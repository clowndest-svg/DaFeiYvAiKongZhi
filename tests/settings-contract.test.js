import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', `test-settings-contract-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
const settingsFile = path.join(dataDir, 'settings.json');
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const DEFAULTS_FILE = path.join(ROOT, 'config', 'default-settings.json');
const RUNTIME_FILE = DEFAULTS_FILE;
const APP_JS = path.join(ROOT, 'web', 'app.js');
const INDEX_HTML = path.join(ROOT, 'web', 'index.html');

const { loadSettings, normalizeSettings } = await import('../src/config.js');
const { closeDb } = await import('../src/db.js');
const { ttsVoices } = await import('../src/tts.js');

function leaves(obj, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) out.push(...leaves(value, p));
    else out.push([p, value]);
  }
  return out;
}

function read(pathname) {
  return fs.readFileSync(pathname, 'utf8');
}

test('默认设置里每个值，落进 normalize 后不能变样（防止两处口径不一致）', () => {
  fs.writeFileSync(settingsFile, '{}', 'utf8');
  const defaults = JSON.parse(read(DEFAULTS_FILE));
  const merged = loadSettings();
  const allow = new Set([
    'memory.handoverTokens',
    'memory.compactTokens',
    'model.name',
    'companion.name',
    'companion.nickname',
    'companion.userName',
    'companion.intro',
    'proactive.quietStart',
    'proactive.quietEnd',
  ]);
  const drift = [];
  for (const [p, expected] of leaves(defaults)) {
    const actual = p.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), merged);
    if (actual === expected) continue;
    if (JSON.stringify(actual) === JSON.stringify(expected)) continue;
    if (allow.has(p)) continue;
    drift.push(`${p}: 默认 ${JSON.stringify(expected)} → normalize 后 ${JSON.stringify(actual)}`);
  }
  assert.deepEqual(drift, [], `这些设置存一次就变样：${drift.join('；')}`);
});

test('少一个键时 normalize 的兜底值要等于默认值（两处不许各写一套数字）', () => {
  const defaults = JSON.parse(read(DEFAULTS_FILE));
  const drift = [];
  for (const [p, expected] of leaves(defaults)) {
    if (p.startsWith('companion.') || p === 'model.name') continue;
    const stripped = JSON.parse(JSON.stringify(defaults));
    const keys = p.split('.');
    const parent = keys.slice(0, -1).reduce((acc, key) => (acc == null ? acc : acc[key]), stripped);
    if (!parent) continue;
    delete parent[keys[keys.length - 1]];
    const after = normalizeSettings(stripped);
    const actual = keys.reduce((acc, key) => (acc == null ? acc : acc[key]), after);
    if (JSON.stringify(actual) === JSON.stringify(expected)) continue;
    drift.push(`${p}: 默认 ${JSON.stringify(expected)}，兜底给了 ${JSON.stringify(actual)}`);
  }
  assert.deepEqual(drift, [], `键缺失时会被改成另一套数字：${drift.join('；')}`);
});

test('collectSettings 顶层键必须和 settings.json 顶层键一一对应（别再嵌错对象）', () => {
  const source = read(APP_JS);
  const start = source.indexOf('function collectSettings');
  assert.ok(start > 0, '找不到 collectSettings');
  const bodyStart = source.indexOf('{', source.indexOf('return', start));
  let depth = 0;
  let i = bodyStart;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = source.slice(bodyStart, i + 1);
  const topLevel = [...body.matchAll(/^    ([a-zA-Z]+): \{/gm)].map((m) => m[1]);
  const runtime = JSON.parse(read(RUNTIME_FILE));
  const expected = Object.keys(runtime);
  assert.deepEqual(
    [...topLevel].sort(),
    [...expected].sort(),
    `collectSettings 收的块是 ${topLevel.join(',')}，而设置文件里是 ${expected.join(',')}`,
  );
});

test('每个 set 开头的控件都要既被填上也被收走（防控件 id 打错/漏收集）', () => {
  const html = read(INDEX_HTML);
  const app = read(APP_JS);
  const ids = [...html.matchAll(/id="(set[A-Za-z0-9]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 40, `控件太少，像是正则没匹配上：${ids.length}`);
  const missing = [];
  for (const id of ids) {
    const hits = app.split(`$('#${id}')`).length - 1;
    if (hits < 2) missing.push(`${id}(出现 ${hits} 次)`);
  }
  assert.deepEqual(missing, [], '这些控件在页面上有，但代码里没填或没收：' + missing.join('、'));
});

test('页面里不许留内联 style（CSP 会把它们整条忽略）', () => {
  const html = read(INDEX_HTML);
  const inline = [...html.matchAll(/style="[^"]*"/g)].map((m) => m[0]);
  assert.deepEqual(inline, [], `这些内联样式在 CSP 下不生效：${inline.join(' ')}`);
});

test('音色目录至少 8 个，且设置页那个下拉的 id 还叫 setVoiceName', () => {
  assert.ok(ttsVoices().length >= 8);
  assert.ok(ttsVoices().some((v) => v.id === 'zh-CN-XiaoxiaoNeural'));
  assert.match(read(INDEX_HTML), /id="setVoiceName"/);
});

test('前端定时轮询的接口不能被加锁（否则轮询会自己撞成 409）', () => {
  const source = read(path.join(ROOT, 'src', 'index.js'));
  const getLock = source.slice(source.indexOf('const EXPENSIVE_GET = new Set(['), source.indexOf(']);', source.indexOf('const EXPENSIVE_GET = new Set([')));
  for (const polled of ['/api/xhs/status', '/api/xhs/qr', '/api/xhs/images', '/api/qq/setup']) {
    assert.equal(getLock.includes(`'${polled}'`), false, `${polled} 是轮询接口，上锁会拒绝后来那次请求`);
  }
  assert.ok(getLock.includes('/api/xhs/feed'), '人手点的重只读接口还是要锁');
});

test.after(() => {
  try {
    closeDb();
  } catch {
    // 没开库
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
