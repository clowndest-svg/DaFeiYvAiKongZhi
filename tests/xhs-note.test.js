import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { once } from 'node:events';
import { freePort } from './helpers/runtime.js';

// 必须在 import 业务模块之前把数据目录指到测试目录，否则会把测试图写进真实 data/media。
const isolatedData = path.join(process.cwd(), 'data', `test-xhs-note-module-${process.pid}`);
process.env.BIZHI_DATA_DIR = isolatedData;
process.env.BIZHI_SETTINGS_FILE = path.join(isolatedData, 'settings.json');
const { resolveXhsImage, listXhsImages } = await import('../src/channels/xhs.js');
const { paths } = await import('../src/config.js');

test.after(() => {
  fs.rmSync(isolatedData, { recursive: true, force: true });
});

test('图片解析只认白名单目录里的静态图', () => {
  const ok = resolveXhsImage('happy-01.jpg');
  assert.ok(fs.existsSync(ok));
  assert.equal(path.dirname(ok), path.join(paths.root, 'assets', 'stickers', 'deepseek-whale'));
  assert.throws(() => resolveXhsImage('nope.jpg'), /找不到图片/);
  assert.throws(() => resolveXhsImage('../../.env'), /图片名不合法|不支持|找不到图片/);
  assert.throws(() => resolveXhsImage('/etc/passwd'), /图片名不合法|不支持|找不到图片/);
  fs.writeFileSync(path.join(paths.media, 'bz-test-gif.gif'), Buffer.from('GIF89a'));
  try {
    assert.throws(() => resolveXhsImage('bz-test-gif.gif'), /不支持 gif/);
  } finally {
    fs.rmSync(path.join(paths.media, 'bz-test-gif.gif'), { force: true });
  }
});

test('可选图片列表只给 jpg/png/webp', () => {
  const list = listXhsImages();
  assert.ok(list.length >= 1);
  for (const item of list) {
    assert.match(item.name, /\.(jpe?g|png|webp)$/i);
    assert.ok(item.bytes > 0);
  }
});

test('没勾选确认时，发布接口直接拒绝', { timeout: 90000 }, async (t) => {
  const port = await freePort();
  const dataDir = path.join(paths.data, `test-xhs-note-${process.pid}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: paths.root,
    env: {
      ...process.env,
      CONSOLE_TOKEN: '',
      CONSOLE_PASSWORD: '',
      BIZHI_DISABLE_CONSOLE_AUTH: '1',
      PORT: String(port),
      BIZHI_DATA_DIR: dataDir,
      BIZHI_SETTINGS_FILE: path.join(dataDir, 'settings.json'),
      LLM_MOCK: '1',
      ONEBOT_TOKEN: `t_${process.pid}`,
      OPEN_BROWSER: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    try { child.kill(); } catch { /* ignore */ }
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 5000))]);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  });

  let healthy = false;
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) { healthy = true; break; }
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(healthy, `服务没起来:\n${logs.slice(-1200)}`);

  const res = await fetch(`http://127.0.0.1:${port}/api/xhs/note/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /确认/);
});
