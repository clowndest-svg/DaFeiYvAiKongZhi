import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { freePort, stopChild, removeTestDir } from './helpers/runtime.js';

const ROOT = process.cwd();

function waitForExit(child, ms = 5000) {
  return Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('接话决策解析与延迟窗口', async () => {
  const { parseFollowUpDecision, followUpDelayMs } = await import('../src/channels/onebot.js');
  assert.deepEqual(
    parseFollowUpDecision('```json\n{"send":true,"text":" 刚那句 我再说一遍 ","reason":"补一句"}\n```'),
    { send: true, text: '刚那句 我再说一遍', reason: '补一句' },
  );
  assert.equal(parseFollowUpDecision('{"send":false,"text":"哼"}').send, false);
  assert.equal(parseFollowUpDecision('{"send":true,"text":"   "}').send, false);
  assert.equal(parseFollowUpDecision('她想了想，没说话').send, false);
  assert.equal(parseFollowUpDecision('{"send":true,"text":"' + '啊'.repeat(200) + '"}').text.length, 120);

  assert.equal(followUpDelayMs({ qq: { selfFollowUpDelaySeconds: 20 } }, () => 0), 14400);
  assert.equal(followUpDelayMs({ qq: { selfFollowUpDelaySeconds: 20 } }, () => 1), 28400);
  assert.equal(followUpDelayMs({ qq: {} }, () => 0.5), Math.round(25000 * 1.07));
  assert.ok(followUpDelayMs({ qq: { selfFollowUpDelaySeconds: 3 } }, () => 0) >= 1000);
});

test('QQ 私聊：主人没接话时她自己补一句，且受每小时上限约束', { timeout: 150000 }, async (t) => {
  const port = await freePort();
  const dataDir = path.join(ROOT, 'data', `test-follow-up-${process.pid}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      qq: {
        enabled: true,
        botAccount: '999999', sleepyMode: false, sendStickers: false,
        selfFollowUp: true,
        selfFollowUpChance: 1,
        selfFollowUpDelaySeconds: 3,
        selfFollowUpMaxPerHour: 1,
        selfFollowUpMaxPerDay: 5,
      },
      tts: { enabled: false },
    }),
    'utf8',
  );
  const token = `test_fu_${process.pid}`;
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
    await stopChild(child);
    removeTestDir(dataDir);
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
    await sleep(200);
  }
  assert.ok(healthy, `服务没有起来:\n${logs.slice(-1500)}`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot?access_token=${token}`);
  t.after(() => ws.close());
  await new Promise((resolve, reject) => {
    if (ws.readyState === 1) return resolve();
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const textSends = [];
  ws.on('message', (raw) => {
    const payload = JSON.parse(raw.toString());
    if (payload.action !== 'send_private_msg') return;
    ws.send(
      JSON.stringify({ status: 'ok', retcode: 0, echo: payload.echo, data: { message_id: textSends.length + 1 } }),
    );
    const seg = (payload.params.message || []).find((item) => item.type === 'text');
    if (seg?.data?.text) textSends.push(seg.data.text);
  });

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

  const base = `http://127.0.0.1:${port}`;
  ws.send(JSON.stringify(message(1, '第一轮')));
  for (let i = 0; i < 40 && !textSends.length; i += 1) await sleep(200);
  assert.equal(textSends.length, 0, '主人没绑定之前不应该回复');

  const bind = await fetch(`${base}/api/qq/bind-owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: '123456789' }),
  });
  assert.equal(bind.status, 200);

  const waitForSend = async (count, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && textSends.length < count) await sleep(200);
    return textSends.length >= count;
  };

  ws.send(JSON.stringify(message(3, '第一轮')));
  assert.ok(await waitForSend(1, 30000), `没有收到第一轮的正面回复:\n${logs.slice(-1200)}`);
  assert.ok(
    await waitForSend(2, 20000),
    `主人没接话，她应该自己补一句:\n${logs.slice(-1200)}\n已收到：${JSON.stringify(textSends)}`,
  );
  assert.match(textSends[1], /再说一遍/);

  const messages = await (await fetch(`${base}/api/messages?limit=40`)).json();
  const followUp = messages.messages.find((m) => m.role === 'assistant' && /再说一遍/.test(m.content || ''));
  assert.ok(followUp, '补的那句应该进对话记录');
  assert.equal(followUp.channel, 'qq');
  assert.equal(followUp.meta?.followUp, true);

  ws.send(JSON.stringify(message(5, '第二轮')));
  assert.ok(await waitForSend(3, 30000), `第二轮没有回复:\n${logs.slice(-1200)}`);
  const beforeQuiet = textSends.length;
  await sleep(12000);
  assert.equal(textSends.length, beforeQuiet, '每小时上限只有 1，第二轮不该再接话');

  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.qq.followUp.enabled, true);
  assert.equal(status.qq.followUp.today, 1);
  assert.equal(status.qq.followUp.dayMax, 5);
});

test('关掉开关后不再自己接话', { timeout: 90000 }, async (t) => {
  const port = await freePort();
  const dataDir = path.join(ROOT, 'data', `test-follow-off-${process.pid}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      qq: { enabled: true, botAccount: '999999', sleepyMode: false, sendStickers: false, selfFollowUp: false, selfFollowUpChance: 1, selfFollowUpDelaySeconds: 3 },
      tts: { enabled: false },
    }),
    'utf8',
  );
  const token = `test_fu_off_${process.pid}`;
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
      ONEBOT_TOKEN: token,
      OPEN_BROWSER: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  t.after(async () => {
    await stopChild(child);
    removeTestDir(dataDir);
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
    await sleep(200);
  }
  assert.ok(healthy, `服务没有起来:\n${logs.slice(-1500)}`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot?access_token=${token}`);
  t.after(() => ws.close());
  await new Promise((resolve, reject) => {
    if (ws.readyState === 1) return resolve();
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const sends = [];
  ws.on('message', (raw) => {
    const payload = JSON.parse(raw.toString());
    if (payload.action !== 'send_private_msg') return;
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: payload.echo, data: { message_id: sends.length + 1 } }));
    const seg = (payload.params.message || []).find((item) => item.type === 'text');
    if (seg?.data?.text) sends.push(seg.data.text);
  });

  const base = `http://127.0.0.1:${port}`;
  const message = (id, text) => ({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: id,
    self_id: 999999,
    user_id: 234567890,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { nickname: '测试' },
  });
  ws.send(JSON.stringify(message(1, '你好')));
  for (let i = 0; i < 40 && !sends.length; i += 1) await sleep(200);
  await fetch(`${base}/api/qq/bind-owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: '234567890' }),
  });

  ws.send(JSON.stringify(message(3, '你好')));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !sends.length) await sleep(200);
  assert.equal(sends.length, 1, `只应该有一条正常回复:\n${logs.slice(-1200)}`);
  await sleep(9000);
  assert.equal(sends.length, 1, '开关关掉后不该再接话');
});
