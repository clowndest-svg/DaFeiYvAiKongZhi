import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

export class CdpBrowser {
  constructor({ port = 9333, profileDir, visible = false } = {}) {
    this.port = port;
    this.profileDir = profileDir;
    this.visible = visible;
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
    const args = [
      `--remote-debugging-port=${this.port}`,
      '--enable-automation',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--lang=zh-CN',
      '--window-size=1280,900',
      visible ? '--window-position=80,60' : '--window-position=-32000,-32000',
      'about:blank',
    ];
    logger.info('启动小红书专用浏览器', { executable, visible });
    this.child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    this.child.unref();
    this.launchedVisible = visible;
    for (let i = 0; i < 50; i += 1) {
      if (await this.alive()) break;
      await sleep(300);
    }
    if (!(await this.alive())) throw new Error('Chrome 调试端口没有起来');
    await this.attach();
  }

  async relaunch({ visible = true } = {}) {
    await this.shutdown();
    this.launchedVisible = visible;
    await this.ensure({ visible });
  }

  async assertOwnership() {
    const command = await this.send('Browser.getBrowserCommandLine', {}, 5000);
    const expected = path.resolve(this.profileDir).toLowerCase();
    const argument = (command?.arguments || []).find((value) => value.startsWith('--user-data-dir='));
    if (!argument || path.resolve(argument.slice(16)).toLowerCase() !== expected) throw new Error('浏览器调试端口不属于本项目，拒绝接管');
  }

  async shutdown() {
    if (env.testMode) { await this.close(); return; }
    if (!(await this.alive())) { await this.close(); return; }
    await this.ensure();
    await this.assertOwnership();
    await this.send('Browser.close', {}, 5000).catch(() => {});
    await this.close();
    for (let i = 0; i < 30; i += 1) { if (!(await this.alive())) return; await sleep(100); }
    throw new Error('专用浏览器未退出，未清理登录文件');
  }

  async attach() {
    const listRes = await fetch(`${this.endpoint}/json/list`, { signal: AbortSignal.timeout(3000) });
    let pages = await listRes.json();
    if (!Array.isArray(pages) || !pages.length) {
      const created = await fetch(`${this.endpoint}/json/new?about:blank`, {
        method: 'PUT',
        signal: AbortSignal.timeout(3000),
      });
      pages = [await created.json()];
    }
    const page = pages.find((item) => item.type === 'page') || pages[0];
    if (!page?.webSocketDebuggerUrl) throw new Error('没有可控制的浏览器页面');
    this.pageInfo = page;
    this.ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    this.ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
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
      logger.warn('小红书浏览器 WebSocket 错误', { error: error.message });
    });
    await new Promise((resolve, reject) => {
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
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    try { await this.assertOwnership(); }
    catch (error) { await this.close(); throw new Error('无法核实专用浏览器归属，请关闭旧专用窗口后重新登录：' + error.message); }
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
    await this.send('Page.navigate', { url }, timeoutMs);
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
