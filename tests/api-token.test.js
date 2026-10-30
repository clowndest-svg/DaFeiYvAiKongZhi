import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { freePort } from './helpers/runtime.js';

const ROOT = process.cwd();

test('控制台登录：密码换会话 cookie，URL 不再带令牌，外网也能用', { timeout: 60000 }, async (t) => {
  const port = await freePort();
  const password = `p_${process.pid}_secret`;
  const dataDir = path.join(ROOT, 'data', `test-api-token-${process.pid}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONSOLE_TOKEN: '',
      CONSOLE_PASSWORD: password,
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

  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready, `服务没起来：\n${logs.slice(-1200)}`);

  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200, '健康检查不碰数据，允许不带登录');

  const noSession = await fetch(`${base}/api/status`);
  assert.equal(noSession.status, 401, '没登录必须 401');
  const noSessionBody = await noSession.json();
  assert.equal(noSessionBody.login, true);

  const tokenUrl = await fetch(`${base}/api/status?token=${encodeURIComponent(password)}`);
  assert.equal(tokenUrl.status, 401, '旧的 ?token= 登录方式必须失效');

  const wrong = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(wrong.status, 401);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200, `登录失败：${logs.slice(-800)}`);
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /bz_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const cookie = setCookie.split(';')[0];

  const withCookie = await fetch(`${base}/api/status`, { headers: { Cookie: cookie } });
  assert.equal(withCookie.status, 200, 'cookie 应该能接管后续请求');
  const status = await withCookie.json();
  assert.equal(status.app.name, '小知');

  const page = await fetch(`${base}/?token=${encodeURIComponent(password)}`, { redirect: 'manual' });
  assert.equal(page.status, 200, '带旧 token 的地址只当普通页面打开，不自动登录');

  const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);
  const logoutCookie = logout.headers.get('set-cookie') || '';
  assert.match(logoutCookie, /Max-Age=0/);
  const afterLogout = await fetch(`${base}/api/status`, { headers: { Cookie: cookie } });
  assert.equal(afterLogout.status, 401, '退出后旧 cookie 立即失效');

  let lastStatus = 0;
  for (let i = 0; i < 6; i += 1) {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    lastStatus = res.status;
  }
  assert.equal(lastStatus, 429, '连续猜错要被限速');
});
