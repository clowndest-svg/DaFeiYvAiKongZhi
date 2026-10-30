import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-qq-watchdog-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ qq: { enabled: true, autoRecover: true } }), 'utf8');
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { OneBotChannel } = await import('../src/channels/onebot.js');
const { listEvents, closeDb } = await import('../src/db.js');

const server = http.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let recoverCalls = 0;
const channel = new OneBotChannel({
  server,
  companion: {},
  onNeedRecover: async () => {
    recoverCalls += 1;
    return { ok: true };
  },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test('刚断开时只记账，不到 5 分钟不动手', () => {
  assert.equal(recoverCalls, 0);
  channel.checkConnectionHealth();
  assert.ok(channel.downSince, '要记下断开时间');
  assert.equal(recoverCalls, 0, '才刚断，不该重启登录');
});

test('断了 6 分钟会报警并自己去拉一次登录', async () => {
  channel.downSince = Date.now() - 6 * 60000;
  const result = channel.checkConnectionHealth();
  assert.ok(result.downMinutes >= 5);
  await settle();
  assert.equal(recoverCalls, 1, '应该触发一次自动恢复');
  const events = listEvents(30);
  assert.ok(events.some((e) => e.type === 'qq_down'), '要在事件里留下“她收不到消息了”');
  assert.ok(events.some((e) => e.type === 'qq_auto_recover'), '自动恢复也要留痕');
});

test('20 秒内不重复拉，一小时内最多三次', async () => {
  channel.checkConnectionHealth();
  await settle();
  assert.equal(recoverCalls, 1, '20 秒节流内不该再来一次');
  channel.lastRecoverAt = 0;
  channel.recoverTimestamps = [Date.now(), Date.now(), Date.now()];
  channel.checkConnectionHealth();
  await settle();
  assert.equal(recoverCalls, 1, '一小时内最多三次');
});

test('连回来之后状态清零', () => {
  channel.clients.add({ readyState: 1, isAlive: true, ping() {}, on() {} });
  const result = channel.checkConnectionHealth();
  assert.equal(result.downMinutes, 0);
  assert.equal(channel.downSince, null);
  const status = channel.status();
  assert.equal(status.connected, true);
  assert.equal(status.autoRecover, true);
  channel.clients.clear();
});

test.after(() => {
  channel.destroy();
  server.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
