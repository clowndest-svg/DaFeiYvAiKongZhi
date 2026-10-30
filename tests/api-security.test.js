import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { freePort } from './helpers/runtime.js';

const ROOT = process.cwd();
const port = await freePort();

function rawRequest({ method = 'GET', pathName, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathName, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('本地 API 拒绝跨站、非 JSON 与伪造 Host', { timeout: 60000 }, async (t) => {
  const dataDir = path.join(ROOT, 'data', `test-api-security-${process.pid}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONSOLE_TOKEN: '',
      CONSOLE_PASSWORD: '',
      BIZHI_DISABLE_CONSOLE_AUTH: '1',
      PORT: String(port),
      BIZHI_DATA_DIR: dataDir,
      BIZHI_SETTINGS_FILE: path.join(dataDir, 'settings.json'),
      BIZHI_NO_BACKUP: '1',
      LLM_MOCK: '1',
      ONEBOT_TOKEN: `test_${process.pid}`,
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
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
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
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(healthy, `服务没有起来:\n${logs.slice(-1500)}`);

  const badHost = await rawRequest({ pathName: '/api/health', headers: { Host: 'evil.example' } });
  assert.equal(badHost.status, 403);

  const badOrigin = await rawRequest({
    method: 'POST',
    pathName: '/api/memories',
    headers: {
      Host: `127.0.0.1:${port}`,
      Origin: 'http://evil.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: '不该写进去' }),
  });
  assert.equal(badOrigin.status, 403);

  const badType = await rawRequest({
    method: 'POST',
    pathName: '/api/memories',
    headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ content: '也不该写进去' }),
  });
  assert.equal(badType.status, 415);

  const ok = await fetch(`http://127.0.0.1:${port}/api/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '这是本地控制台写入的测试记忆', importance: 1 }),
  });
  assert.equal(ok.status, 200);
  const memories = await (await fetch(`http://127.0.0.1:${port}/api/memories?layer=core`)).json();
  assert.ok(memories.memories.some((item) => item.content.includes('本地控制台写入')));
  assert.ok(!memories.memories.some((item) => item.content.includes('不该写进去')));

  const chat = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text: '测试上下文记账' }),
  });
  assert.equal(chat.status, 200);
  const stream = await chat.text();
  assert.match(stream, /"type":"done"/);
  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert.ok(status.session.contextTokens > 0, '完成一轮后应记录真实上下文 token');
});
