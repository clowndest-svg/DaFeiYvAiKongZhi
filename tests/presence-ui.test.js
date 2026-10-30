import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'style.css'), 'utf8');
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'default-settings.json'), 'utf8'));

test('陪伴视图真的挂在导航里，桌宠小窗也有落点', () => {
  assert.match(HTML, /<button class="rail-btn" data-view="presence"/, '侧栏要有「陪伴」入口');
  assert.match(HTML, /<section class="view" id="view-presence">/, '要有对应的视图容器');
  assert.match(APP, /'presence', 'pet'/, 'init 要认得 presence 和 pet 两个入口');
  assert.match(APP, /mode-pet/, '桌宠小窗要有自己的布局开关');
  assert.match(CSS, /body\.mode-pet \.rail/, '小窗模式下要真的隐藏导航');
});

test('立绘用的五张图都在仓库里，而且服务端真的放得出去', () => {
  const figures = APP.match(/const PET_FIGURES = \{[\s\S]*?\n\};/);
  assert.ok(figures, '找不到表情图清单');
  const paths = [...figures[0].matchAll(/'\/char\/([a-z]+\.png)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(paths)].sort(), ['blink.png', 'happy.png', 'normal.png', 'shy.png', 'surprised.png']);
  for (const name of paths) {
    const file = path.join(ROOT, 'assets', 'char', name);
    assert.ok(fs.existsSync(file) && fs.statSync(file).size > 100000, `${name} 不像是能用的图`);
  }
  const index = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  assert.match(index, /pathname\.startsWith\('\/char\/'\)/, '得有 /char/ 的静态路由');
  assert.match(index, /safeJoin\(path\.join\(paths\.assets, 'char'\)/, '并且限制在 assets/char 里，不许穿越');
});

test('陪伴设置项在三个地方口径一致：默认值、收、填', () => {
  const keys = Object.keys(DEFAULTS.presence);
  assert.equal(keys.length, 15, '陪伴设置块被改动了，判据要跟着核对');
  const block = APP.match(/presence: \{\n([\s\S]*?)\n    \},/);
  assert.ok(block, 'collectSettings 里没有 presence 块');
  const collected = [...block[1].matchAll(/^      ([a-zA-Z]+):/gm)].map((m) => m[1]).filter((k) => k !== '...prev');
  assert.deepEqual(collected.sort(), [...keys].sort(), '收上来的键必须和默认值一一对应');
  for (const key of keys) {
    assert.ok(APP.includes(`presence?.${key}`) || APP.includes(`presence.${key}`), `填回去的时候漏了 ${key}`);
  }
});

test('会花钱、会动设备的开关默认必须是关', () => {
  for (const key of ['cameraEnabled', 'micEnabled', 'speakReplies', 'neuroEnabled', 'forgettingCurve', 'sensesEnabled']) {
    assert.equal(DEFAULTS.presence[key], false, `${key} 默认必须是关的`);
  }
  for (const key of ['cameraDailyMax', 'speakDailyMax']) {
    assert.ok(DEFAULTS.presence[key] > 0 && DEFAULTS.presence[key] <= 60, `${key} 默认值要保守：${DEFAULTS.presence[key]}`);
  }
});

test('设备不可用时要说清楚原因，不许摆一个点了没反应的按钮', () => {
  assert.match(APP, /isSecureContext/, '要先判断是不是安全上下文');
  assert.match(APP, /getUserMedia/, '用的是浏览器原生采集');
  assert.match(APP, /这个浏览器没有 getUserMedia|不是安全上下文/, '不支持时要给具体原因');
  assert.match(APP, /NotAllowedError/, '权限被拒和没设备要分得开');
  const hint = HTML.match(/id="presenceHint"/g);
  assert.ok(hint && hint.length === 1, '界面上要有一行常驻的说明位');
});

test('录音只在本机转字：不上传、不落盘，格式是 16k 单声道', () => {
  assert.match(APP, /resampleTo16k/, '要重采样到 16k 才交给本机 SenseVoice');
  assert.match(APP, /view\.setUint16\(22, 1, true\)/, 'WAV 头里的声道数必须写 1');
  assert.match(APP, /view\.setUint16\(34, 16, true\)/, '位深必须写 16');
  assert.match(APP, /setUint32\(24, sampleRate, true\)/, '采样率要真的写进头里');
});

test('字幕和快捷回话都来自设置，不是写死在页面里', () => {
  assert.match(APP, /const cfg = presenceSettings\(\);[\s\S]{0,400}cfg\.subtitles/, '字幕要跟着开关走');
  assert.match(APP, /presenceSettings\(\)\.quickChips/, '快捷词要从设置读');
  assert.ok(!/<button[^>]*class="chip"/.test(HTML), 'HTML 里不该留一批写死的表情词');
});

test('数字读不到就显示「无读数」，不许拿 0 或空串糊过去', () => {
  assert.match(APP, /无读数/, '要有明确的「无读数」文案');
  assert.match(APP, /function fmtOr/, '而且要统一走一个格式化函数');
  assert.match(APP, /画的是 \$\{drawn\} 个点（真实节点/, '大脑图要标出自己画的是抽样');
});

test('没有把 CSP 需要的口子开大：脚本、连接、媒体都还是同源', () => {
  const index = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  const csp = index.match(/'Content-Security-Policy':\s*\n?\s*"([^"]+)"/);
  assert.ok(csp, '找不到 CSP');
  assert.match(csp[1], /script-src 'self'/);
  assert.match(csp[1], /connect-src 'self'/);
  assert.match(csp[1], /media-src 'self' blob:/, '播放本机合成的语音需要 blob，但不能放开到任意来源');
  assert.ok(!/unsafe-inline/.test(csp[1]));
});
