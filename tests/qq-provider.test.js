import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { providerInfo, snowLumaConfig } from '../src/qq-provider.js';
import { claimMessageReceipt, messageReceiptKey } from '../src/onebot-receipts.js';
import { closeDb, kvGet, kvSet } from '../src/db.js';
import { saveSettings, env } from '../src/config.js';
import { OneBotChannel } from '../src/channels/onebot.js';
import { isOwnedProcess } from '../src/processes.js';
import { paths } from '../src/config.js';
import path from 'node:path';

test.after(closeDb);
const message = (patch = {}) => ({ post_type: 'message', self_id: 10000001, message_type: 'private', user_id: 10000002, message_id: 42, time: 1700000000, message: [{ type: 'text', data: { text: '你好' } }], ...patch });

test('SnowLuma 配置仅机器人账号启用反向连接，不打开额外监听或自动注入', () => {
  const config = snowLumaConfig({ account: '10000001', token: 'isolated-token', port: 9876 });
  assert.deepEqual(config.global.networks.wsClients, []);
  assert.deepEqual(config.account.networks.httpServers, []);
  assert.deepEqual(config.account.networks.wsServers, []);
  assert.equal(config.account.networks.wsClients[0].url, 'ws://127.0.0.1:9876/onebot/snowluma');
  assert.equal(config.account.networks.wsClients[0].messageFormat, 'array');
  assert.equal(config.runtime.hookAutoLoad, false);
  assert.throws(() => snowLumaConfig({ account: '../other', token: 'x' }));
  assert.equal(providerInfo().id, 'napcat');
  assert.equal(providerInfo().webUiUrl, 'http://127.0.0.1:6099/');
});

test('消息回执跨数据库重开去重；同 ID 不同账号/群/发送者不误去重；ID 0 合法', () => {
  const event = message();
  assert.equal(claimMessageReceipt(event).claimed, true);
  closeDb();
  assert.equal(claimMessageReceipt(event).claimed, false);
  for (const patch of [{ self_id: 10000003 }, { message_type: 'group', group_id: 10000004 }, { user_id: 10000005 }, { time: 1700000001 }, { message_id: 0 }]) {
    assert.equal(claimMessageReceipt(message(patch)).claimed, true);
  }
  assert.notEqual(messageReceiptKey(message({ message_id: null, message: [{ type: 'image', data: { file: 'a' } }] })), messageReceiptKey(message({ message_id: null, message: [{ type: 'image', data: { file: 'b' } }] })));
});

function fixture(t) {
  saveSettings({ qq: { enabled: true, botAccount: '10000001' } });
  kvSet('qq_owner_id', '10000002');
  const server = http.createServer();
  const channel = new OneBotChannel({ server, companion: {} });
  t.after(() => { channel.destroy(); server.close(); });
  return channel;
}

test('重复连接被拒；错误账号不污染有效身份和去重表', (t) => {
  const channel = fixture(t);
  const fake = () => Object.assign(new EventEmitter(), { readyState: 1, close(code, reason) { this.closed = { code, reason }; } });
  const request = { url: '/onebot', headers: { authorization: `Bearer ${env.onebotToken}` } };
  const first = fake();
  channel.handleConnection(first, request);
  const second = fake();
  channel.handleConnection(second, request);
  assert.match(second.closed.reason, /one active/);
  kvSet('qq_self_id', '10000001');
  channel.handleRaw(first, JSON.stringify({ post_type: 'meta_event', self_id: 10000002 }));
  assert.equal(kvGet('qq_self_id'), '10000001');
  assert.equal(channel.clients.size, 0);
  assert.equal(first.closed.code, 1008);
});

test('手动停用、服务关闭、底层写入错误都保留发送结果未知状态', async (t) => {
  for (const mode of ['disconnect', 'destroy', 'write-error']) {
    const channel = fixture(t);
    channel.clients.add({ readyState: 1, isAlive: true, selfId: '10000001', close() {}, send(raw, callback) { if (mode === 'write-error') callback(new Error('socket failed')); } });
    const promise = channel.sendAction('send_private_msg', { user_id: 10000002, message: 'test' });
    const rejected = assert.rejects(promise, { code: 'DELIVERY_UNKNOWN' });
    if (mode === 'disconnect') channel.disconnectAll();
    if (mode === 'destroy') channel.destroy();
    await rejected;
  }
});

test('SnowLuma 进程所有权必须同时匹配内置 Node 和本项目入口', () => {
  const exe = path.join(paths.root, 'snowluma', 'node.exe');
  const entry = path.join(paths.root, 'snowluma', 'index.mjs');
  assert.equal(isOwnedProcess({ ProcessId: 1, ExecutablePath: exe, CommandLine: `"${exe}" "${entry}"` }, 'snowluma'), true);
  assert.equal(isOwnedProcess({ ProcessId: 1, ExecutablePath: exe, CommandLine: `"${exe}" C:/other/index.mjs` }, 'snowluma'), false);
  assert.equal(isOwnedProcess({ ProcessId: 1, ExecutablePath: process.execPath, CommandLine: `node "${entry}"` }, 'snowluma'), false);
});
