import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { freePort } from './helpers/runtime.js';

const ROOT = process.cwd();

function waitForExit(child, ms = 5000) {
  return Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}

test('OneBot 私聊能触发回复并落库（使用模拟模型）', { timeout: 90000 }, async (t) => {
  const port = await freePort();
  const dataDir = path.join(ROOT, 'data', `test-onebot-${process.pid}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const token = `test_${process.pid}`;
  const settingsFile = path.join(dataDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ qq: { enabled: true, botAccount: '999999', sleepyMode: false, sendStickers: false }, social: { enabled: false }, tts: { enabled: false } }), 'utf8');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONSOLE_TOKEN: '',
      CONSOLE_PASSWORD: '',
      BIZHI_DISABLE_CONSOLE_AUTH: '1',
      PORT: String(port),
      BIZHI_DATA_DIR: dataDir,
      BIZHI_SETTINGS_FILE: settingsFile,
      BIZHI_NO_BACKUP: '1',
      LLM_MOCK: '1',
      ONEBOT_TOKEN: token,
      OPEN_BROWSER: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });

  t.after(async () => {
    try {
      child.kill();
    } catch {
      // ignore
    }
    await waitForExit(child);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  });

  let healthy = false;
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(healthy, `服务没有起来:\n${logs.slice(-1500)}`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot?access_token=${token}`);
  t.after(() => ws.close());

  const base = `http://127.0.0.1:${port}`;
  const message = (id, text) => ({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: id,
    self_id: 999999,
    user_id: 123456789,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { nickname: '测试' },
  });

  await new Promise((resolve, reject) => {
    if (ws.readyState === 1) return resolve();
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify(message(1, '你好')));

  let candidate = null;
  for (let i = 0; i < 30; i += 1) {
    const setup = await (await fetch(`${base}/api/qq/setup`)).json();
    if (setup.candidate?.userId === '123456789') {
      candidate = setup.candidate;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(candidate, '第一条私聊应该进入待确认，而不是直接绑定主人');

  const bind = await fetch(`${base}/api/qq/bind-owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: '123456789' }),
  });
  assert.equal(bind.status, 200);

  const action = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`没有收到 QQ 回复:\n${logs.slice(-1500)}`)), 30000);
    ws.on('message', (raw) => {
      const payload = JSON.parse(raw.toString());
      if (payload.action === 'send_private_msg') {
        clearTimeout(timer);
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: payload.echo, data: { message_id: 2 } }));
        resolve(payload);
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    ws.send(JSON.stringify(message(3, '你好')));
  });

  assert.equal(action.params.user_id, 123456789);
  const text = action.params.message?.[0]?.data?.text || '';
  assert.match(text, /测试模式/);

  const messages = await (await fetch(`${base}/api/messages?limit=20`)).json();
  assert.ok(messages.messages.some((m) => m.role === 'assistant' && m.channel === 'qq'));
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.qq.ownerIdMasked, '123****789');
  assert.equal(status.qq.connected, true);
});
