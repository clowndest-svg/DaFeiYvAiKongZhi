import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { normalizeOneBotEvent, messageReceiptKey, claimMessageReceipt, inboxState, bindInboxOwner, beginOutbound, finishOutbound, recoverJournal, pendingInbox, journalStatus, journalReview, resolveJournal } from '../src/onebot-receipts.js';
import { getDb, closeDb, kvSet } from '../src/db.js';
import { paths, saveSettings } from '../src/config.js';
import { OneBotChannel } from '../src/channels/onebot.js';

test.after(closeDb);
const event = (id) => ({ post_type: 'message', self_id: '10000001', user_id: '10000002', message_id: id, message_type: 'private', time: 1, message: [{ type: 'text', data: { text: '测试私密正文' } }] });
const context = { provider: 'napcat', bot: '10000001', owner: '10000002' };

test('两端数字/字符串 ID 与秒/毫秒时间戳统一；不接受已失去精度的数字 ID', () => {
  const a = { ...event(4), self_id: 10000001, time: 1700000000 };
  const b = { ...event('4'), time: 1700000000000 };
  assert.equal(messageReceiptKey(a), messageReceiptKey(b));
  assert.equal(normalizeOneBotEvent(null), null);
  assert.equal(normalizeOneBotEvent({ ...a, message_id: Number.MAX_SAFE_INTEGER + 1 }), null);
});

test('队列和会话同库，显式 FULL；非法状态转换被拒', () => {
  assert.equal(Object.values(getDb().prepare('PRAGMA synchronous').get())[0], 2);
  const receipt = claimMessageReceipt(event('states'), Date.now(), context);
  assert.throws(() => inboxState([receipt.key], 'processing'), /不能/);
  inboxState([receipt.key], 'dispatching');
  inboxState([receipt.key], 'buffered');
  inboxState([receipt.key], 'processing');
  inboxState([receipt.key], 'completed');
  assert.throws(() => inboxState([receipt.key], 'dispatching'), /不能/);
});

test('每段发送键固定；sent 可复用回执；sending/unknown 不自动重发', () => {
  const request = { ...context, action: 'send_private_msg', params: { user_id: '10000002', message: '测试私密正文' }, receiptKeys: ['batch-1'], sequence: 0 };
  const first = beginOutbound(request);
  assert.equal(journalStatus().outbox.sending, 1);
  assert.throws(() => beginOutbound(request), { code: 'DELIVERY_UNKNOWN' });
  finishOutbound(first.id, 'sent', { messageId: 0 });
  assert.equal(beginOutbound(request).receipt.data.message_id, '0');
  const second = beginOutbound({ ...request, sequence: 1 });
  finishOutbound(second.id, 'unknown', { reason: 'timeout' });
  assert.throws(() => beginOutbound({ ...request, sequence: 1 }), { code: 'DELIVERY_UNKNOWN' });
  const review = journalReview();
  assert.equal(JSON.stringify(review).includes('测试私密正文'), false);
  resolveJournal({ kind: 'outbox', id: second.id, resolution: 'confirmed' });
  assert.throws(() => resolveJournal({ kind: 'outbox', id: second.id, resolution: 'not_sent' }), /状态已变化/);
});

test('跨端、改绑主人、过期的待处理事件只转人工核对，不重放', () => {
  claimMessageReceipt(event('changed-owner'), Date.now(), { ...context, owner: '10000003' });
  claimMessageReceipt(event('changed-provider'), Date.now(), { ...context, provider: 'snowluma' });
  claimMessageReceipt(event('expired'), Date.now() - 7200000, context);
  assert.equal(pendingInbox(context).length, 0);
  assert.ok(journalStatus().inbox.review >= 3);
});

test('首条白名单消息完成自动绑定后可以恢复；活跃缓冲不会被重连恢复误判', () => {
  const receipt = claimMessageReceipt(event('auto-bind'), Date.now(), { ...context, owner: '' });
  inboxState([receipt.key], 'dispatching');
  bindInboxOwner(receipt.key, context.owner);
  inboxState([receipt.key], 'buffered');
  assert.equal(pendingInbox({ ...context, excludeKeys: [receipt.key] }).length, 0);
  assert.equal(getDb().prepare('SELECT state FROM qq_inbox WHERE key=?').get(receipt.key).state, 'buffered');
  assert.ok(pendingInbox(context).some(row => row.key === receipt.key));
  inboxState([receipt.key], 'processing'); inboxState([receipt.key], 'completed');
});

test('维护期间事件落库且不触发处理；结束维护只恢复安全队列', async (t) => {
  saveSettings({ qq: { enabled: true, botAccount: context.bot } });
  kvSet('qq_owner_id', context.owner);
  const server = http.createServer();
  const channel = new OneBotChannel({ server, companion: {} });
  t.after(() => { channel.setMaintenance(false); channel.destroy(); server.close(); });
  const ws = { selfId: context.bot, readyState: 1, isAlive: true, close() {} };
  channel.clients.add(ws);
  let calls = 0;
  channel.handleMessage = async () => { calls += 1; };
  channel.setMaintenance(true);
  channel.handleRaw(ws, JSON.stringify(event('during-maintenance')));
  assert.equal(calls, 0);
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM qq_inbox WHERE state='received'").get().n, 1);
  await assert.rejects(channel.sendAction('send_private_msg', {}), /维护/);
  channel.setMaintenance(false);
  for (let i = 0; i < 20 && !calls; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  channel.handleRaw(ws, JSON.stringify(event('during-maintenance')));
  assert.equal(calls, 1);
});

test('真实子进程被结束后：buffered 可恢复，processing/sending 转待核对且原事件仍在库', { timeout: 15000 }, async (t) => {
  const moduleUrl = pathToFileURL(path.join(paths.root, 'src', 'onebot-receipts.js')).href;
  const crashDir = path.join(paths.data, 'crash-worker');
  const workerEnv = { ...process.env, BIZHI_DATA_DIR: crashDir, BIZHI_SETTINGS_FILE: path.join(crashDir, 'settings.json') };
  const script = `import * as j from ${JSON.stringify(moduleUrl)};
    const e=${JSON.stringify(event('crash-buffered'))};
    const a=j.claimMessageReceipt(e,Date.now(),${JSON.stringify(context)});
    j.inboxState([a.key],'dispatching');j.inboxState([a.key],'buffered');
    const b=j.claimMessageReceipt({...e,message_id:'crash-processing'},Date.now(),${JSON.stringify(context)});
    j.inboxState([b.key],'dispatching');j.inboxState([b.key],'buffered');j.inboxState([b.key],'processing');
    j.beginOutbound({...${JSON.stringify(context)},action:'send_private_msg',params:{message:'private'},receiptKeys:[b.key],sequence:0});
    console.log('DURABLE_READY');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: workerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('DURABLE_READY')) resolve(); });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('worker exited before durable checkpoint')));
  });
  const exit = once(child, 'exit');
  child.kill();
  await exit;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `import * as j from ${JSON.stringify(moduleUrl)};j.recoverJournal();console.log(JSON.stringify({status:j.journalStatus(),pending:j.pendingInbox(${JSON.stringify(context)}).length}));`], { env: workerEnv, encoding: 'utf8', windowsHide: true });
  const parsed = JSON.parse(result.trim());
  assert.equal(parsed.status.inbox.buffered, 1);
  assert.equal(parsed.status.inbox.review, 1);
  assert.equal(parsed.status.outbox.unknown, 1);
  assert.equal(parsed.pending, 1);
});

test('主动消息分段期间改绑主人，后续分段不能继续发送', async (t) => {
  saveSettings({ qq: { enabled: true, botAccount: context.bot } }); kvSet('qq_owner_id', context.owner);
  const server = http.createServer(); const channel = new OneBotChannel({ server, companion: {} });
  t.after(() => { channel.destroy(); server.close(); });
  channel.clients.add({ readyState: 1, close() {} });
  const sent = [];
  channel.sendToTarget = async (target, text) => { sent.push({ target, text }); kvSet('qq_owner_id', '10000003'); };
  await assert.rejects(channel.sendToOwner('第一段。\n\n第二段。'), /账号或通道/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target.userId, context.owner);
});
