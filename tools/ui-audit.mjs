// 界面体检：起一个隔离演示实例，灌入有代表性的数据，然后在五档视口 × 五个视图上
// 量六类可判定的缺陷：横向溢出、真遮挡、文字截断、元素出界、可点区域过小、对比度不达 WCAG AA。
// 任何一项不达标就以非 0 退出，可以直接挂在本机收尾或 CI 上。
//
//   node tools/ui-audit.mjs            # 只判定
//   node tools/ui-audit.mjs --shots    # 顺便把截图写到 data/ui-audit/run
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 7795;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'ui-audit-password';
const VIEWS = ['chat', 'presence', 'memory', 'social', 'settings'];
const WIDTHS = [1440, 1024, 768, 390, 337];
const wantShots = process.argv.includes('--shots');
const shotDir = path.join(ROOT, 'data', 'ui-audit', 'run');

const installedChromium = () => ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((file) => fs.existsSync(file));

function startDemo() {
  const data = path.join(ROOT, 'data', 'ui-audit-demo');
  fs.mkdirSync(data, { recursive: true });
  const settingsFile = path.join(data, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    companion: { name: '鲸鲸', nickname: '笨蛋', intro: '有点小傲娇、但很会照顾人的女朋友' },
    qq: { enabled: false },
    social: { xhsEnabled: false },
    proactive: { enabled: false },
    presence: { neuroEnabled: true, sensesEnabled: true, forgettingCurve: true, cameraEnabled: true, micEnabled: true },
  }));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      BIZHI_TEST_MODE: '1', BIZHI_NO_BACKUP: '1', LLM_MOCK: '1', OPEN_BROWSER: '0',
      PORT: String(PORT), DEEPSEEK_API_KEY: '', ONEBOT_TOKEN: 'ui-audit-token',
      CONSOLE_PASSWORD: PASSWORD, CONSOLE_TOKEN: '',
      BIZHI_DATA_DIR: data, BIZHI_SETTINGS_FILE: settingsFile,
      BIZHI_PERSONA_FILE: path.join(data, 'persona.md'),
      BIZHI_MOM_LETTER_FILE: path.join(data, 'mom-letter.md'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const ready = (async () => {
    for (let i = 0; i < 80; i += 1) {
      try {
        if ((await fetch(`${BASE}/api/health`)).status === 200) return;
      } catch {
        /* 还在起 */
      }
      await sleep(250);
    }
    throw new Error(`演示实例没起来：${logs.slice(-400)}`);
  })();
  return { child, ready };
}

async function seed() {
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bizhi-request': '1' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('演示实例登录失败，无法灌测试数据');
  const post = async (url, body) => {
    const res = await fetch(BASE + url, {
      method: 'POST',
      headers: { cookie, origin: BASE, 'x-bizhi-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status >= 400) throw new Error(`${url} -> ${res.status}`);
  };
  for (const text of ['在吗', '今天开会开到好晚，累死了', '我中午煮了酸汤面，有点咸', '周五上午我要去体检，记得提醒我空腹', '你别老熬夜行不行', '周末想去看海']) {
    await post('/api/chat', { text });
  }
  for (const item of [
    { layer: 'core', content: '他不喜欢吃香菜', importance: 5 },
    { layer: 'core', content: '他生日是 3 月 14 日', importance: 5 },
    { layer: 'mid', content: '他周五上午要体检，要空腹', importance: 5 },
    { layer: 'mid', content: '他喜欢喝美式咖啡，不加糖', importance: 3 },
    { layer: 'mid', content: '他最近加班很多，晚上容易烦躁', importance: 4 },
    { layer: 'long', content: '去年冬天他们一起去过海边', importance: 5 },
  ]) {
    await post('/api/memories', item);
  }
  await post('/api/posts/generate', { kind: 'qzone' });
  await post('/api/posts/generate', { kind: 'xhs' });
}

// 在页面里跑的那段检查。注意：滚动与命中测试必须成对做——
// 先滚完一批再统一测，读到的是最后一次滚动之后的位置，会把早就离开原地的元素误判成被遮挡。
async function probeInPage() {
  const out = { overflow: 0, offscreen: [], occluded: [], clipped: [], tiny: [], contrast: [] };
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const parseColor = (color) => {
    const m = String(color).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[,/\s]+/).filter((v) => v.length).map(Number);
    const [r, g, b] = parts;
    const a = parts.length >= 4 ? Number(parts[3]) : 1;
    if (![r, g, b, a].every((v) => Number.isFinite(v))) return null;
    return { r, g, b, a };
  };
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (color) => {
    const p = parseColor(color);
    return p ? 0.2126 * chan(p.r) + 0.7152 * chan(p.g) + 0.0722 * chan(p.b) : null;
  };
  // 半透明背景要逐层合成到不透明底色，否则会把 rgba(...,0.1) 当实心色算出假的对比度
  const effectiveBg = (node) => {
    const chain = [];
    let probe = node;
    while (probe) {
      const color = parseColor(getComputedStyle(probe).backgroundColor);
      if (color) {
        chain.push(color);
        if (color.a >= 0.999) break;
      }
      probe = probe.parentElement;
    }
    if (!chain.length) return null;
    let acc = chain[chain.length - 1];
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      const c = chain[i];
      acc = { r: c.r * c.a + acc.r * (1 - c.a), g: c.g * c.a + acc.g * (1 - c.a), b: c.b * c.a + acc.b * (1 - c.a) };
    }
    return 0.2126 * chan(acc.r) + 0.7152 * chan(acc.g) + 0.0722 * chan(acc.b);
  };
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  // 「看不见」不算被遮挡：display none、透明度 0 的抽屉、闭合 details 里的内容
  const actuallyVisible = (node) => {
    let probe = node;
    while (probe && probe !== document.body) {
      const style = getComputedStyle(probe);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (Number(style.opacity) < 0.06) return false;
      if (probe.tagName === 'DETAILS' && !probe.open && probe !== node) return false;
      probe = probe.parentElement;
    }
    return true;
  };
  const label = (node) => `${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}`;

  out.overflow = document.documentElement.scrollWidth - window.innerWidth;
  for (const node of document.querySelectorAll('body *')) {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden') continue;
    if (rect.left > window.innerWidth + 1) out.offscreen.push(`${label(node)}@${Math.round(rect.left)}`);
  }

  const candidates = [...document.querySelectorAll('#messages .msg, .card, .composer, .settings-jump a, button, input, select, textarea, .forget-row, .chip')];
  for (const node of candidates) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 12 || rect.height < 12) continue;
    if (!actuallyVisible(node)) continue;
    node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await frames();
    const box = node.getBoundingClientRect();
    const cx = Math.round(box.left + box.width / 2);
    const cy = Math.round(box.top + box.height / 2);
    if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) continue;
    const scroller = node.closest('.messages, .view, .chat-side, .presence-side') || node.parentElement;
    if (scroller && scroller !== document.body) {
      const sbox = scroller.getBoundingClientRect();
      if (cx < sbox.left || cx > sbox.right || cy < sbox.top || cy > sbox.bottom) continue;
    }
    const hit = document.elementFromPoint(cx, cy);
    if (hit && hit !== node && !node.contains(hit) && !hit.contains(node)) {
      // 顶栏 / 侧栏 / 保存栏是结构性 chrome：元素滚到它们下面只说明它滚出了可视区，
      // 不是内容互相遮挡，报出来只会制造假阳性。
      if (hit.closest('.topbar, .rail, .save-bar')) continue;
      out.occluded.push(`${label(node)} <- ${label(hit)}`);
    }
  }

  for (const node of document.querySelectorAll('code, .hint, .badge, button, .chip, .mood-chip, a.link-btn, label')) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0 && !/auto|scroll/.test(style.overflow)) {
      out.clipped.push(`${label(node)}:${(node.textContent || '').trim().slice(0, 16)}`);
    }
  }

  for (const node of document.querySelectorAll('button, a, input[type=checkbox], select')) {
    const target = node.type === 'checkbox' && node.closest('label') ? node.closest('label') : node;
    const box = target.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    if (box.height < 28 || box.width < 24) out.tiny.push(label(node));
  }

  for (const node of document.querySelectorAll('p, span, label, li, .bubble, .card h3, .muted')) {
    const text = (node.textContent || '').trim();
    if (text.length < 3 || node.children.length) continue;
    if (!actuallyVisible(node)) continue;
    const style = getComputedStyle(node);
    const fg = lum(style.color);
    const bg = effectiveBg(node);
    if (fg === null || bg === null) continue;
    const size = parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || 400;
    const large = size >= 18.66 || (size >= 14 && weight >= 700);
    const got = ratio(fg, bg);
    if (got < (large ? 3 : 4.5)) out.contrast.push(`${label(node)}.${String(node.className).split(' ')[0]} ${got.toFixed(2)} "${text.slice(0, 12)}"`);
  }

  // 说明：曾经在这里加过「滚到底检查最后一行是否被浮动导航吃掉」的补测。
  // 用正向对照（把底部导航加高到 300px）标定时它仍然全绿，说明这条断言没有探测能力，
  // 留着只会给人一种「已经覆盖了」的错觉，所以删掉。该风险目前由 ui-contract 的
  // 静态断言 + 直接几何测量 + 截图兜底，不冒充被自动判据覆盖。
  const dedupe = (list) => [...new Set(list)];
  for (const key of ['offscreen', 'occluded', 'clipped', 'tiny', 'contrast']) out[key] = dedupe(out[key]).slice(0, 6);
  return out;
}

const executable = installedChromium();
if (!executable) {
  console.error('这台机器没有安装 Chrome/Edge，无法做界面体检');
  process.exitCode = 2;
} else {
  const demo = startDemo();
  const context = await chromium.launchPersistentContext(path.join(ROOT, 'data', 'ui-audit', '.profile'), {
    executablePath: executable,
    headless: true,
    viewport: { width: 1440, height: 900 },
  });
  let failures = 0;
  try {
    await demo.ready;
    await seed();
    const page = await context.newPage();
    await page.goto(BASE);
    if (await page.evaluate(() => !document.querySelector('#loginScreen').classList.contains('hidden'))) {
      await page.fill('#loginPassword', PASSWORD);
      await page.click('#loginSubmit');
      await page.waitForFunction(() => document.querySelector('#loginScreen').classList.contains('hidden'));
    }
    if (wantShots) fs.mkdirSync(shotDir, { recursive: true });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width < 800 ? 880 : 900 });
      for (const view of VIEWS) {
        await page.goto(`${BASE}/?view=${view}`);
        await page.waitForFunction((name) => document.querySelector(`#view-${name}`)?.classList.contains('active'), view);
        await page.waitForTimeout(700);
        const metrics = await page.evaluate(probeInPage);
        const bad = metrics.overflow > 0 || metrics.occluded.length || metrics.clipped.length
          || metrics.offscreen.length || metrics.tiny.length || metrics.contrast.length;
        if (bad) failures += 1;
        console.log(`${bad ? '✗' : '✓'} ${String(width).padStart(4)}px ${view.padEnd(9)} 溢出=${metrics.overflow} 遮挡=${metrics.occluded.length} 截断=${metrics.clipped.length} 出界=${metrics.offscreen.length} 过小=${metrics.tiny.length} 对比不足=${metrics.contrast.length}`);
        for (const key of ['offscreen', 'occluded', 'clipped', 'tiny', 'contrast']) {
          if (metrics[key].length) console.log(`      ${key}: ${metrics[key].slice(0, 3).join(' | ')}`);
        }
        if (wantShots) await page.screenshot({ path: path.join(shotDir, `${width}-${view}.png`) });
      }
    }
  } finally {
    await context.close();
    demo.child.kill();
  }
  console.log(failures ? `界面体检：${failures} 项不达标` : '界面体检：25 组全部达标');
  process.exitCode = failures ? 1 : 0;
}
