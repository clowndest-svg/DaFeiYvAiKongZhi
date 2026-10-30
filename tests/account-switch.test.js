import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { freePort } from './helpers/runtime.js';

const ROOT = process.cwd();

function waitForExit(child, ms = 5000) {
  return Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, ms))]);
}

const dataDir = path.join(ROOT, 'data', `test-account-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ qq: { enabled: true, botAccount: 'rm -rf /q' } }), 'utf8');
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { loadSettings, normalizeSettings } = await import('../src/config.js');
const { closeDb, kvGet, kvSet } = await import('../src/db.js');
const { xhsLogout } = await import('../src/channels/xhs.js');

test('机器人 QQ 号只认 5–12 位数字，别的退回默认小号', () => {
  assert.equal(loadSettings().qq.botAccount, '', '乱填要用默认小号，不能把命令当成号传出去');
  const ok = normalizeSettings({ qq: { botAccount: '12345678' } });
  assert.equal(ok.qq.botAccount, '12345678');
  const shell = normalizeSettings({ qq: { botAccount: '2000000001 & del /q C:\\' } });
  assert.equal(shell.qq.botAccount, '', '带命令的输入必须整个丢掉');
});

test('退出小红书登录：清登录态文件、清缓存 kv，并落事件', async () => {
  const profile = path.join(dataDir, 'xhs-profile', 'Default');
  fs.mkdirSync(path.join(profile, 'Local Storage'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Cookies'), 'fake-cookie-db');
  fs.writeFileSync(path.join(profile, 'Local Storage', 'leveldb.log'), 'fake');
  kvSet('xhs_logged_in', '1');
  kvSet('xhs_self_name', '测试机器人昵称');
  kvSet('xhs_self_user_id', '6a1b2c3d00000000000000aa');
  kvSet('xhs_profile_url', 'https://www.xiaohongshu.com/user/profile/6a1b2c3d00000000000000aa');

  const result = await xhsLogout();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(profile, 'Cookies')), false, 'cookie 库要真删掉');
  assert.equal(fs.existsSync(path.join(profile, 'Local Storage')), false, 'localStorage 要真删掉');
  assert.equal(kvGet('xhs_logged_in', ''), '', '登录态缓存要清');
  assert.equal(kvGet('xhs_self_name', ''), '', '上一个号的昵称不能留着');
  assert.equal(kvGet('xhs_self_user_id', ''), '');
  assert.equal(kvGet('xhs_profile_url', ''), '');
  assert.ok(result.removed.length >= 2, `至少删了两样东西：${JSON.stringify(result.removed)}`);

  const again = await xhsLogout();
  assert.equal(again.ok, true, '没登录过也不该报错');
});

test('保存设置会把机器人号写进 qq-account.txt，启动脚本按它快速登录', { timeout: 90000 }, async (t) => {
  const port = await freePort();
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
      LLM_MOCK: '1',
      OPEN_BROWSER: '0',
      BIZHI_NO_BACKUP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  t.after(async () => {
    try { child.kill(); } catch { /* 已退出 */ }
    await waitForExit(child);
  });

  let up = false;
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) { up = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(up, `服务没起来：${logs.slice(-600)}`);

  const accountFile = path.join(dataDir, 'qq-account.txt');
  assert.equal(fs.existsSync(accountFile), false, '未配置时不创建账号文件');

  const saved = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qq: { botAccount: '99887766' } }),
  });
  assert.equal(saved.status, 200);
  assert.equal(fs.readFileSync(accountFile, 'utf8').trim(), '99887766', '改了号要立刻写到文件里');

  const stopped = await fetch(`http://127.0.0.1:${port}/api/qq/stop`, { method: 'POST' });
  assert.equal(stopped.status, 200);
  const after = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
  assert.equal(after.settings.qq.enabled, false, '一键停用要真的关掉通道');
  const events = after.settings ? (await (await fetch(`http://127.0.0.1:${port}/api/events`)).json()).events : [];
  assert.ok(events.some((e) => e.type === 'qq_channel_stopped'), '停用要留事件');

  const bad = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qq: { botAccount: 'rm -rf' } }),
  });
  assert.equal(bad.status, 400);
  const dumped = fs.readFileSync(accountFile, 'utf8');
  assert.equal(dumped.trim(), '99887766', '非法输入不会覆盖原来的有效账号');
  assert.equal(dumped.includes('&'), false, '写进文件的只可能是纯数字');
});

test('小红书状态提供当前账号字段而非只说已登录', async () => {
  const { xhsBrowserStatus } = await import('../src/channels/xhs.js');
  const status = await xhsBrowserStatus();
  for (const key of ['selfName', 'selfUserId', 'profileUrl', 'browserRunning', 'loggedIn']) assert.ok(Object.hasOwn(status, key), key);
});

test.after(() => {
  try {
    closeDb();
  } catch {
    // 没开库
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
});
