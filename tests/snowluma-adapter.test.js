import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { freePort } from './helpers/runtime.js';

test('SnowLuma 模式端到端：独立 WS 路径、拒绝旧端路径、身份与扫码状态一致', { timeout: 25000 }, async (t) => {
  const port = await freePort();
  const dir = path.join(process.env.BIZHI_DATA_DIR, 'snow-server');
  fs.mkdirSync(dir, { recursive: true });
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ qq: { enabled: true, botAccount: '10000001' }, social: { enabled: false }, proactive: { enabled: false } }));
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, BIZHI_QQ_PROVIDER: 'snowluma', BIZHI_DATA_DIR: dir, BIZHI_SETTINGS_FILE: settings, BIZHI_DISABLE_CONSOLE_AUTH: '1', PORT: String(port), LLM_MOCK: '1', OPEN_BROWSER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  let setup;
  for (let i = 0; i < 65; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/qq/setup`);
      if (res.ok) { setup = await res.json(); break; }
    } catch { /* starting */ }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(setup, logs.slice(-1500));
  assert.equal(setup.provider.id, 'snowluma');
  assert.equal(setup.wsUrl, `ws://127.0.0.1:${port}/onebot/snowluma`);
  assert.equal(setup.qrAvailable, false);
  assert.equal(setup.versions, null);
  const old = new WebSocket(`ws://127.0.0.1:${port}/onebot?access_token=${process.env.ONEBOT_TOKEN}`);
  t.after(() => old.terminate());
  await once(old, 'error');
  const ws = new WebSocket(`${setup.wsUrl}?access_token=${process.env.ONEBOT_TOKEN}`);
  t.after(() => ws.terminate());
  await once(ws, 'open');
  ws.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', self_id: 10000001 }));
  let current;
  for (let i = 0; i < 30; i += 1) {
    current = await (await fetch(`http://127.0.0.1:${port}/api/qq/setup`)).json();
    if (current.status.selfId === '10000001') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(current.status.identityOk, true);
  assert.equal(current.status.clients, 1);
  assert.equal(current.status.migration.requiresColdRestart, true);
  assert.equal(current.status.recovery.napcatLogin, null);
});
