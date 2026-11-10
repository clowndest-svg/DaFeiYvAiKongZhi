import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { logger } from '../logger.js';
import { env } from '../config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function findBrowser() {
  return CHROME_CANDIDATES.find((file) => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  }) || '';
}

// 归属核实的唯一判据：那个浏览器的 --user-data-dir 必须正好是本项目的专用目录。
// CDP 的 getBrowserCommandLine 要求浏览器带 --enable-automation 启动，
// 老窗口（或别的构建起的窗口）不带这个参数就会直接报错，所以还要能从操作系统侧读到命令行。
export function parseUserDataDir(commandLine) {
  const match = /--user-data-dir=("[^"]*"|[^\s]+)/i.exec(String(commandLine || ''));
  return match ? match[1].replace(/^"|"$/g, '') : '';
}

export function ownsProfileDir(commandLine, profileDir) {
  const found = parseUserDataDir(commandLine);
  if (!found) return false;
  return path.resolve(found).toLowerCase() === path.resolve(String(profileDir || '')).toLowerCase();
}

function windowsCommandLineForPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
  const script = [
    '$ErrorActionPreference="SilentlyContinue"',
    `$l=@(Get-NetTCPConnection -LocalPort ${port} -State Listen | ForEach-Object { $_.OwningProcess } | Select-Object -Unique)`,
    'if ($l.Count -ne 1) { exit }',
    '$c=(Get-CimInstance Win32_Process -Filter "ProcessId=$($l[0])").CommandLine',
    'if ($c) { [Console]::Out.WriteLine($c) }',
  ].join('\n');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    });
    return String(out || '').trim();
  } catch (error) {
    logger.debug('读取调试端口进程命令行失败', { error: error.message });
    return '';
  }
}

// 候选标签页的优先级：已经开着站点的页最可能是活的那个；about:blank 多半是历史遗留。
export function liveScore(page) {
  const url = String(page?.url || '');
  if (/^https?:\/\//i.test(url)) return 2;
  if (url && url !== 'about:blank') return 1;
  return 0;
}

// 地址是否已经是目标页：浏览器会补斜杠、丢 hash，逐字比较会把成功的跳转判成失败。
export function sameLocation(actual, target) {
  const norm = (value) => {
    try {
      const u = new URL(String(value || ''));
      return `${u.origin.toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}`;
    } catch {
      return '';
    }
  };
  const a = norm(actual);
  return Boolean(a) && a === norm(target);
}

// 谁还占着这个 profile：只读进程列表，一个进程都不动。
// Chrome 的渲染/GPU/网络子进程命令行里同样带 --user-data-dir，照单全报会列出十几个 pid，
// 甚至出现 pid 8 这种荒唐数字——等于没说。父进程本身也是浏览器的是孩子，剔掉；
// 只剩窗口主进程（父进程已死的孤儿也算，正是它最会卡住 profile）。
export function chromeHoldingProfile(profileDir) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($env:BIZHI_PROFILE_MATCH) } | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)" }`;
  let rows;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      env: { ...process.env, BIZHI_PROFILE_MATCH: String(profileDir) },
    });
    rows = String(out)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes('|'))
      .map((line) => line.split('|').map((part) => Number(part.trim())))
      .filter(([pid]) => Number.isFinite(pid) && pid > 0);
  } catch (error) {
    logger.debug('读取 profile 占用者失败', { error: String(error.message).slice(0, 60) });
    return [];
  }
  const pids = new Set(rows.map(([pid]) => pid));
  return rows.filter(([, parent]) => !pids.has(parent)).map(([pid]) => String(pid)).slice(0, 4);
}

export function profileHeldMessage(pids, profileDir) {
  if (!pids || !pids.length) return '';
  return `这个账号目录还被另一个 Chrome 窗口占着（pid ${pids.join('、')}，profile ${profileDir}）：把那个窗口关掉，我再接管同一个 profile 继续`;
}

// 从"窗口主进程"名单里把自己起的那个摘掉，剩下的才是真正要请用户关掉的窗口。
export function otherHolders(pids, ownPid) {
  return (pids || []).filter((pid) => String(pid) !== String(ownPid || ''));
}

export class CdpBrowser {

  constructor({ port = 9333, profileDir, visible = false, proxyServer = '', lang = 'zh-CN' } = {}) {
    this.port = port;
    this.profileDir = profileDir;
    this.visible = visible;
    // 有些站点在这张网上直连不通（X 实测直连 000、走本机代理 200），
    // 代理地址必须由调用方显式给，不能悄悄跟着系统代理走——那样失败原因会被记成"页面打不开"。
    this.proxyServer = String(proxyServer || '').trim();
    this.lang = lang;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.child = null;
    this.pageInfo = null;
    this.launchedVisible = null;
  }

  get endpoint() {
    return `http://127.0.0.1:${this.port}`;
  }

  async alive() {
    if (env.testMode) return false;
    try {
      const res = await fetch(`${this.endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensure({ visible = this.visible } = {}) {
    if (env.testMode) throw new Error('隔离测试禁止启动或接管真实浏览器');
    this.visible = visible;
    if (await this.alive()) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) await this.attach();
      return;
    }
    const executable = findBrowser();
    if (!executable) throw new Error('找不到 Chrome/Edge，可在 .env 设置 CHROME_PATH');
    fs.mkdirSync(this.profileDir, { recursive: true });
    if (await this.launchOnce(executable)) return;
    // 自己起的那个进程没把调试端口开出来。最常见的原因：同一个 profile 只许一个实例占着，
    // 新进程并进旧窗口后自己退了——这时旧窗口的 pid 会留在端口之外，说"端口没有起来"等于让人猜。
    // 先把自己刚起的那个收掉（不留孤儿占 profile），再看还有谁占着，最后重试一次。
    const stopped = await this.stopOwnChild();
    const holders = otherHolders(chromeHoldingProfile(this.profileDir), stopped);
    if (holders.length) throw new Error(profileHeldMessage(holders, this.profileDir));
    if (await this.launchOnce(executable)) return;
    const again = await this.stopOwnChild();
    const still = otherHolders(chromeHoldingProfile(this.profileDir), again);
    if (still.length) throw new Error(profileHeldMessage(still, this.profileDir));
    throw new Error(`Chrome 调试端口两次都没起来${this.profileDir}（已收掉自己起的浏览器进程）：多半是被安全软件拦了，手动开一次那个浏览器窗口再点验证`);
  }

  async launchOnce(executable) {
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      `--lang=${this.lang}`,
      '--window-size=1280,900',
      this.visible ? '--window-position=80,60' : '--window-position=-32000,-32000',
      ...(this.proxyServer ? [`--proxy-server=${this.proxyServer}`] : []),
      'about:blank',
    ];
    logger.info('启动专用浏览器', { executable, visible: this.visible, port: this.port });
    this.child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: !this.visible,
    });
    this.child.unref();
    this.launchedVisible = this.visible;
    for (let i = 0; i < 50; i += 1) {
      if (await this.alive()) {
        await this.attach();
        return true;
      }
      await sleep(300);
    }
    return false;
  }

  // 只退自己 spawn 的那一个进程：拿不到 pid 就什么都不做，绝不按名字找浏览器去杀。
  async stopOwnChild() {
    const pid = Number(this.child?.pid) || 0;
    this.child = null;
    if (!pid) return 0;
    try {
      process.kill(pid);
    } catch (error) {
      if (error.code !== 'ESRCH') logger.debug('收回自己起的浏览器进程失败', { pid, error: String(error.message).slice(0, 60) });
    }
    for (let i = 0; i < 20; i += 1) {
      if (!chromeHoldingProfile(this.profileDir).map(String).includes(String(pid))) return pid;
      await sleep(150);
    }
    return pid;
  }

  async relaunch({ visible = true } = {}) {
    await this.shutdown();
    this.launchedVisible = visible;
    await this.ensure({ visible });
  }

  async assertOwnership() {
    let reason = '';
    try {
      const command = await this.send('Browser.getBrowserCommandLine', {}, 5000);
      const argument = (command?.arguments || []).find((value) => value.startsWith('--user-data-dir='));
      if (argument) {
        return ownsProfileDir(argument, this.profileDir) ? '' : '浏览器调试端口不属于本项目，拒绝接管';
      }
      reason = 'CDP 没给出启动参数';
    } catch (error) {
      reason = error.message;
    }
    // 读不到不等于不是我们的：老窗口不带 --enable-automation 时 CDP 会拒绝回答，
    // 这时改用操作系统侧的进程命令行复核，判据完全一样（必须指向本项目专用数据目录）。
    const windowsLine = windowsCommandLineForPort(this.port);
    if (windowsLine && ownsProfileDir(windowsLine, this.profileDir)) {
      logger.info('专用浏览器归属改用系统命令行核实通过', { reason, port: this.port });
      return '';
    }
    return `无法核实专用浏览器归属（${reason}）；调试端口上的浏览器数据目录不是 ${this.profileDir}${windowsLine ? '' : '，也没读到该端口的进程命令行'}`;
  }

  async shutdown() {
    if (env.testMode) { await this.close(); return; }
    if (!(await this.alive())) { await this.close(); return; }
    await this.ensure();
    const beforeClose = await this.assertOwnership();
    if (beforeClose) throw new Error(beforeClose);
    await this.send('Browser.close', {}, 5000).catch(() => {});
    await this.close();
    for (let i = 0; i < 30; i += 1) { if (!(await this.alive())) return; await sleep(100); }
    throw new Error('专用浏览器未退出，未清理登录文件');
  }

  async attach() {
    const listRes = await fetch(`${this.endpoint}/json/list`, { signal: AbortSignal.timeout(3000) });
    let pages = await listRes.json();
    if (!Array.isArray(pages)) pages = [];
    // 用户自己也会在这个窗口里开标签页（实测 8 个 target，3 个 about:blank），
    // Chrome 还会"丢弃"后台标签页——被丢掉的页连 Page.enable 都不回。
    // 抓第一个 page 就等于把指令发进一个永远不答话的页：实测所有导航都报"操作超时"。
    // 所以排队候选，谁答话用谁；全都不答话就自己开一个标签页，那个必然归我们控制。
    const pageTargets = pages.filter((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    const reused = this.pageInfo?.webSocketDebuggerUrl
      ? pageTargets.find((item) => item.webSocketDebuggerUrl === this.pageInfo.webSocketDebuggerUrl)
      : null;
    const ranked = [...pageTargets].sort((a, b) => liveScore(b) - liveScore(a));
    const candidates = [reused, ...ranked].filter(Boolean);
    for (const page of candidates) {
      if (await this.tryConnect(page)) return;
    }
    const created = await fetch(`${this.endpoint}/json/new?about:blank`, {
      method: 'PUT',
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    const fresh = created ? await created.json().catch(() => null) : null;
    if (fresh?.webSocketDebuggerUrl && await this.tryConnect(fresh)) return;
    throw new Error('浏览器没有答话的标签页（开着的页都不回话，新开的也不回）');
  }

  // 连一个候选页：问三句话都答了才算可用；不答就断开换下一个。归属不对是硬失败，不换页重试。
  async tryConnect(page) {
    await this.close();
    this.pageInfo = page;
    try {
      await this.openSocket(page.webSocketDebuggerUrl);
      await this.send('Page.enable', {}, 6000);
      await this.send('Runtime.enable', {}, 6000);
      await this.send('Network.enable', {}, 6000);
    } catch (error) {
      logger.debug('这个标签页不答话，换下一个', { url: String(page.url || '').slice(0, 50), error: String(error.message).slice(0, 50) });
      await this.close();
      return false;
    }
    const ownership = await this.assertOwnership();
    if (ownership) {
      await this.close();
      throw new Error(ownership + '；若旧窗口占着调试端口，关掉它再重新登录');
    }
    return true;
  }

  openSocket(url) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // X 的回复框有未保存内容时注册了 beforeunload，我们接着导航走就会弹出
      // "Leave site? Changes you made may not be saved."——那个原生框会冻结这个标签页：
      // 导航不提交、后面的点击全不落地，报错看着像"选择器过期"（实测就是这么卡住的）。
      // 自动化没人去点"Leave"，所以在这里替它答应，并留一条日志说明为什么页面被跳过。
      if (message.method === 'Page.javascriptDialogOpening') {
        const type = message.params?.type || '';
        const prompt = String(message.params?.message || '').slice(0, 60);
        logger.info('浏览器弹了原生对话框，已自动应答', { type, prompt });
        this.send('Page.handleJavaScriptDialog', { accept: true }, 5000).catch(() => {});
        return;
      }
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || 'CDP 调用失败'));
      else entry.resolve(message.result);
    });
    this.ws.on('close', () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('浏览器连接已断开'));
      }
      this.pending.clear();
    });
    this.ws.on('error', (error) => {
      logger.debug('专用浏览器 WebSocket 报错', { error: error.message });
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('浏览器 CDP 连接超时')), 8000);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('浏览器没有连接'));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`浏览器操作超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async evaluate(expression, { timeoutMs = 20000 } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
    );
    if (result?.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行失败';
      throw new Error(text);
    }
    return result?.result?.value;
  }

  evaluateFunction(fn, args = [], options = {}) {
    const call = `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`;
    return this.evaluate(call, options);
  }

  async navigate(url, { waitMs = 1600, timeoutMs = 30000 } = {}) {
    // Page.navigate 要等导航"提交"才返回；X 这种重页面在这张网上提交可能拖过 30 秒。
    // 把超时的命令发出去、页面其实已经跳过去了，却报"操作超时"——实测时间线和主页都栽在这。
    // 所以超时后回头核实地址：地址已经是目标就算成功（内容有没有 load 另有 assertTimelineLoaded 把关）。
    try {
      await this.send('Page.navigate', { url }, timeoutMs);
    } catch (error) {
      // 地址已经变了就是"提交慢"，算成功；没变多半是这个标签页被 Chrome 丢弃了、根本不再答话
      // （实测同一份代码，前一分钟还能读，后一分钟连 Page.navigate 都不回）。
      // 这时重连到一个答话的标签页，再跳一次；还不行才把错抛出去。
      const where = await this.evaluate('location.href', { timeoutMs: 4000 }).catch(() => '');
      if (sameLocation(where, url)) {
        logger.debug('导航未及时返回，但地址已经到了目标页', { url, where });
      } else {
        await this.attach();
        await this.send('Page.navigate', { url }, timeoutMs);
      }
    }
    await sleep(waitMs);
    await this.waitReady(timeoutMs);
  }

  async waitReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState');
        if (state === 'complete' || state === 'interactive') return true;
      } catch {
        // page is navigating
      }
      await sleep(250);
    }
    return false;
  }

  async waitFor(selector, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ok = await this.evaluateFunction(
          (sel) => Boolean(document.querySelector(sel)),
          [selector],
        );
        if (ok) return true;
      } catch {
        // keep polling
      }
      await sleep(250);
    }
    return false;
  }

  async bringToFront() {
    try {
      await this.send('Page.bringToFront');
    } catch {
      // ignore
    }
  }

  async showWindow() {
    const page = this.pageInfo;
    if (!page?.id) return false;
    try {
      const result = await this.send('Browser.getWindowForTarget', { targetId: page.id });
      if (result?.windowId) {
        await this.send('Browser.setWindowBounds', {
          windowId: result.windowId,
          bounds: { windowState: 'normal', left: 100, top: 70, width: 1280, height: 900 },
        });
      }
      await this.bringToFront();
      return true;
    } catch {
      return false;
    }
  }

  async hideWindow() {
    const page = this.pageInfo;
    if (!page?.id) return false;
    try {
      const result = await this.send('Browser.getWindowForTarget', { targetId: page.id });
      if (result?.windowId) {
        await this.send('Browser.setWindowBounds', {
          windowId: result.windowId,
          bounds: { windowState: 'normal', left: -32000, top: -32000, width: 1280, height: 900 },
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  async getUrl() {
    return this.evaluate('location.href');
  }

  async screenshot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' }, 20000);
    if (!res?.data) throw new Error('截图返回空');
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return file;
  }

  async getCookies() {
    const result = await this.send('Network.getAllCookies');
    return result?.cookies || [];
  }

  async click(selector) {
    return this.evaluateFunction((sel) => {
      const node = document.querySelector(sel);
      if (!node) return false;
      node.click();
      return true;
    }, [selector]);
  }

  async focus(selector) {
    return this.evaluateFunction((sel) => {
      const node = document.querySelector(sel);
      if (!node) return false;
      node.focus();
      node.click();
      return true;
    }, [selector]);
  }

  // 真鼠标点一下：内容编辑器（Draft.js/Slate）只认落在真焦点上的输入，
  // node.click() 这种合成点击不会把光标放进去，Input.insertText 就插了个空（X 实测读到空框）。
  async clickAt(selector) {
    const spot = await this.evaluateFunction((sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      node.scrollIntoView({ block: 'center' });
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: Math.round(r.x + Math.min(48, r.width / 2)), y: Math.round(r.y + Math.min(20, r.height / 2)) };
    }, [selector]);
    if (!spot) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type,
        x: spot.x,
        y: spot.y,
        button: 'left',
        clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      });
    }
    return true;
  }

  async type(selector, text) {
    const focused = await this.focus(selector);
    if (!focused) throw new Error(`找不到输入框：${selector}`);
    await this.evaluateFunction((sel) => {
      const node = document.querySelector(sel);
      if (!node) return;
      if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
        node.value = '';
        node.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        node.innerHTML = '';
      }
    }, [selector]);
    await this.send('Input.insertText', { text: String(text) });
    await sleep(250);
    return true;
  }

  async scroll(px) {
    return this.evaluateFunction((distance) => {
      window.scrollBy(0, distance);
      return window.scrollY;
    }, [px]);
  }

  async close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('浏览器连接已关闭'));
    }
    this.pending.clear();
  }
}
