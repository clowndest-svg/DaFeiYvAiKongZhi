import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { paths, saveSettings } from '../src/config.js';
import { closeDb, kvSetJson, kvGetJson, addMessage, getActiveSession } from '../src/db.js';
import { DeepSeek } from '../src/llm.js';
import { Companion } from '../src/chat.js';
import { runOwnerTools, ownerCapabilities, wantsOwnerTools } from '../src/owner-tools.js';
import { readSourceFile, replaceSourceText, restoreSourceEdit, resolveSourceFile } from '../src/source-access.js';
import { recordXActivity } from '../src/channels/x.js';
import { storeDouyinVideoNote } from '../src/channels/douyin.js';
import { kvSet } from '../src/db.js';
import { startTestServer } from './helpers/runtime.js';
import { OneBotChannel } from '../src/channels/onebot.js';

test.beforeEach(() => {
  saveSettings({ ownerTools: { enabled: true, desktop: true, sourceWrite: true, maxSteps: 6 }, cost: { maxDailyCostCny: 100 } });
  kvSetJson('cost_state', { balanceCny: 20, at: new Date().toISOString() });
});
test.after(closeDb);

const toolCall = (name, args = {}, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('工具调用允许空正文并保留调用参数，HTTP 费用正常入账', async t => {
  let body;
  let includeUsage = true;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'deepseek-flash', choices: [{ message: { content: null, tool_calls: [toolCall('capabilities')] }, finish_reason: 'tool_calls' }], ...(includeUsage ? { usage: { prompt_tokens: 10, completion_tokens: 8 } } : {}) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const llm = new DeepSeek({ apiKey: 'test', baseUrl: `http://127.0.0.1:${server.address().port}` });
  const result = await llm.chat([{ role: 'user', content: '看一下权限' }], { tools: [{ type: 'function', function: { name: 'capabilities', parameters: { type: 'object', properties: {} } } }], thinking: false });
  assert.equal(result.toolCalls[0].function.name, 'capabilities');
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tools[0].function.name, 'capabilities');
  includeUsage = false;
  const estimated = await llm.chat([{ role: 'user', content: '查看权限' }], { tools: body.tools, thinking: false });
  assert.equal(estimated.usageEstimated, true);
  assert.ok(estimated.usage.completion > 5, '工具参数也必须计入缺少 usage 时的输出估算');
  assert.ok(estimated.usage.prompt > 20, '工具 schema 也必须计入输入估算');
});

test('访客、群聊和缺少主人身份的调用不会执行工具', async () => {
  let calls = 0;
  const llm = { chat: async () => { calls++; } };
  for (const opts of [{ channel: 'qq-guest', ownerAuthorized: true }, { channel: 'qq-group', ownerAuthorized: true }, { channel: 'qq' }, { channel: 'web' }]) {
    assert.equal(await runOwnerTools({ text: '截图并修改源码', ...opts }, llm), null);
  }
  assert.equal(calls, 0);
});

test('顺序调用、多次观察与失败回执进入最终上下文，同一 QQ 消息重放不重复动作', async () => {
  let round = 0, actions = 0;
  const llm = { chat: async messages => {
    round++;
    if (round === 1) return { toolCalls: [toolCall('desktop_action', { action: 'screenshot' }), toolCall('desktop_action', { action: 'screenshot' }, 'call-2')] };
    assert.ok(messages.some(m => m.role === 'tool' && m.content.includes('awaiting_final_send')));
    return { content: '截图已送达' };
  } };
  const options = { text: '把电脑截图发给我', channel: 'qq', ownerAuthorized: true, deliveryMeta: { qqReceiptKeys: ['unique-owner-tools-shot'] }, sendImage: async () => { actions++; return true; } };
  const deps = { executeTool: async () => ({ ok: true, image: 'data:image/png;base64,aGVsbG8=', attachment: { url: '/media/owner-test.png' } }) };
  const first = await runOwnerTools(options, llm, deps);
  const second = await runOwnerTools(options, llm, deps);
  assert.match(first.context, /sent_to_owner/);
  assert.equal(second.context, first.context);
  assert.equal(actions, 1);
  assert.equal(round, 2);
});

test('关闭开关或费用封顶时返回具体原因，源代码修改不会被只读社交请求授权', async () => {
  saveSettings({ ownerTools: { enabled: false } });
  assert.equal(ownerCapabilities().sourceWrite, false);
  assert.match((await runOwnerTools({ text: '截图', channel: 'web', ownerAuthorized: true }, {})).context, /尚未开启/);
  saveSettings({ ownerTools: { enabled: true } });
  kvSetJson('cost_state', { balanceCny: 0, at: new Date().toISOString() });
  assert.match((await runOwnerTools({ text: '去看看抖音', channel: 'web', ownerAuthorized: true }, {})).context, /费用上限暂停/);
  kvSetJson('cost_state', { balanceCny: 20, at: new Date().toISOString() });
  let executed = false, round = 0;
  const output = await runOwnerTools({ text: '去看看推特', channel: 'web', ownerAuthorized: true }, {
    chat: async () => ++round === 1 ? { toolCalls: [toolCall('source_replace', { path: 'src/chat.js' })] } : { content: '此动作未获授权' },
  }, { executeTool: async () => { executed = true; return { ok: true }; } });
  assert.equal(executed, false);
  assert.match(output.context, /工具已关闭或不可用/);
});

test('私聊与流式回复实际走工具，历史可接续，X 和抖音活动进入聊天', async () => {
  const session = getActiveSession();
  recordXActivity({ type: 'read', text: 'X真实记录', target: 'somebody' });
  kvSet('douyin:account', 'test-bound');
  storeDouyinVideoNote('test-bound', { videoId: '123456', title: '厨房', summary: '抖音真实笔记', at: new Date().toISOString() });
  const llm = {
    configured: true,
    chat: async (messages, opts) => opts.tools ? { toolCalls: [toolCall('capabilities')] } : { content: '收到真实回执', model: 'stub' },
    async *stream(messages) {
      assert.match(messages[0].content, /X真实记录/);
      assert.match(messages[0].content, /抖音真实笔记/);
      assert.match(messages[0].content, /工具执行回执/);
      yield { type: 'content', delta: '回执已看到' };
      yield { type: 'done', model: 'stub' };
    },
  };
  const companion = new Companion({ llm });
  companion.afterTurn = () => {};
  const reply = await companion.reply({ text: '你有什么权限', channel: 'qq', ownerAuthorized: true });
  assert.match(reply.prep.userMessage.meta.ownerToolNote, /capabilities/);
  const events = [];
  for await (const event of companion.streamReply({ text: '现在有什么能力', channel: 'web', ownerAuthorized: true })) events.push(event);
  assert.equal(events.at(-1).message.content, '回执已看到');
  assert.equal(wantsOwnerTools('继续', [{ role: 'user', content: '', meta: { ownerToolNote: '回执' }, created_at: new Date().toISOString() }]), true);
  assert.equal(wantsOwnerTools('停止'), false);
  assert.equal(wantsOwnerTools('看看 tools/desktop.ps1'), true);
  assert.equal(wantsOwnerTools('看看 tests/owner-tools.test.js'), true);
  const guest = companion.prepare({ text: '在吗', channel: 'qq-guest', sessionId: session.id });
  assert.doesNotMatch(guest.payload.messages[0].content, /X真实记录|抖音真实笔记|当前能力与执行条件/);
});

test('源码修改以唯一原文和哈希保护并发，语法失败保持原文，备份可恢复', () => {
  const relative = `web/owner-source-test-${process.pid}.js`;
  const file = path.join(paths.root, relative);
  const original = 'export const label = "before";\n';
  fs.writeFileSync(file, original, { flag: 'wx' });
  try {
    const first = readSourceFile({ path: relative });
    assert.throws(() => replaceSourceText({ path: relative, expectedHash: first.hash, oldText: '"before"', newText: '(' }), /语法检查失败/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    const edited = replaceSourceText({ path: relative, expectedHash: first.hash, oldText: '"before"', newText: '"after"' });
    assert.match(fs.readFileSync(file, 'utf8'), /after/);
    assert.throws(() => replaceSourceText({ path: relative, expectedHash: first.hash, oldText: '"after"', newText: '"stale"' }), /发生变化/);
    restoreSourceEdit({ editId: edited.editId });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    const empty = replaceSourceText({ path: relative, expectedHash: first.hash, oldText: original, newText: '' });
    restoreSourceEdit({ editId: empty.editId });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    for (const target of ['.env', 'config/settings.json', 'data/bizhi.db', 'src/../config/settings.json', '../src/chat.js']) assert.throws(() => resolveSourceFile(target));
  } finally { fs.unlinkSync(file); }
});

test('主人给出图片路径后可真实读取并发送，未指定的图片路径不能由模型自行补出', async () => {
  let calls = 0, sent = 0;
  const opts = { text: '把 assets/avatar.png 这张图片发给我', channel: 'qq', ownerAuthorized: true, sendImage: async image => { assert.match(image, /^data:image\/png;base64,/); sent++; return true; } };
  const result = await runOwnerTools(opts, { chat: async () => ++calls === 1 ? { toolCalls: [toolCall('send_image', { path: 'assets/avatar.png' })] } : { content: '已发出图片' } });
  assert.equal(sent, 1);
  assert.match(result.context, /sent_to_owner/);
  assert.match(result.attachments[0].url, /^\/media\/owner-.*\.png$/);
  calls = 0;
  const denied = await runOwnerTools({ ...opts, text: '发一张图片给我' }, { chat: async () => ++calls === 1 ? { toolCalls: [toolCall('send_image', { path: 'assets/avatar.png' })] } : { content: '需要路径' } });
  assert.match(denied.context, /明确提供/);
  assert.equal(sent, 1);
});

test('源码工具按文件类型检查模块和 PowerShell 语法，检查过程不执行脚本', { skip: process.platform !== 'win32' }, () => {
  for (const [extension, content] of [['mjs', 'export const value = 1;\n'], ['cjs', 'module.exports = 1;\n'], ['ps1', '$value = 1\n']]) {
    const relative = `tools/owner-source-test-${process.pid}.${extension}`;
    const file = path.join(paths.root, relative);
    fs.writeFileSync(file, content, { flag: 'wx' });
    try {
      const before = readSourceFile({ path: relative });
      assert.throws(() => replaceSourceText({ path: relative, expectedHash: before.hash, oldText: '1', newText: '{' }), /语法检查失败/);
      assert.equal(fs.readFileSync(file, 'utf8'), content);
      const edited = replaceSourceText({ path: relative, expectedHash: before.hash, oldText: '1', newText: '2' });
      assert.equal(fs.readFileSync(file, 'utf8'), content.replace('1', '2'));
      restoreSourceEdit({ editId: edited.editId });
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    } finally { fs.unlinkSync(file); }
  }
});

test('图片发送使用绑定主人，独立于表情开关，账号过期立即停止', async () => {
  kvSet('qq_owner_id', '123456789');
  saveSettings({ qq: { sendStickers: false } });
  let request;
  const sender = {
    clients: new Set([{}]), maintenance: false,
    assertCurrentWork() {},
    async sendAction(action, params) { request = { action, params }; return { data: { message_id: 1 } }; },
  };
  await OneBotChannel.prototype.sendImageToOwner.call(sender, 'data:image/png;base64,aGVsbG8=');
  assert.equal(request.action, 'send_private_msg');
  assert.equal(request.params.user_id, 123456789);
  assert.equal(request.params.message[0].data.file, 'base64://aGVsbG8=');
  sender.assertCurrentWork = () => { throw new Error('账号已改变'); };
  await assert.rejects(OneBotChannel.prototype.sendImageToOwner.call(sender, 'data:image/png;base64,aGVsbG8='), /账号已改变/);
});

test('工具执行中的停止信号阻止下一步，未知的中断状态留在回执里', async () => {
  const controller = new AbortController();
  let executed = 0;
  const result = await runOwnerTools({ text: '在桌面窗口输入你好', channel: 'web', ownerAuthorized: true, signal: controller.signal }, {
    chat: async () => ({ toolCalls: [toolCall('desktop_action', { action: 'windows' }), toolCall('desktop_action', { action: 'type', window: '123', text: '你好' }, 'call-2')] }),
  }, { executeTool: async () => { executed++; controller.abort(new Error('主人停止')); return { ok: true }; } });
  assert.equal(executed, 1);
  assert.match(result.context, /主人停止/);
});

test('网页普通与 SSE 入口持久化工具回执，系统分区保存工具开关', async t => {
  const server = await startTestServer(t, { settings: { ownerTools: { enabled: true, desktop: true, sourceWrite: true, maxSteps: 5 } } });
  const headers = { 'Content-Type': 'application/json', 'X-BiZhi-Request': '1' };
  const response = await fetch(`${server.base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ text: '你有什么权限' }) });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.message);
  const history = await (await fetch(`${server.base}/api/messages`)).json();
  assert.match(history.messages.find(message => message.role === 'user').meta.ownerToolNote, /工具执行回执/);
  const streamed = await fetch(`${server.base}/api/chat`, { method: 'POST', headers: { ...headers, Accept: 'text/event-stream' }, body: JSON.stringify({ text: '看看源码' }) });
  assert.match(await streamed.text(), /"type":"done"/);
  assert.equal(ownerCapabilities().toolsEnabled, true);
});
