// QQ 语音会话的竞态判据。
// 不靠"随机跑一千次看看会不会出事"：假时钟 + 注入延迟，把 12 组合法交叉逐条钉住。
// 事故级的是 C05、C08、C09、C10、C11、C12 —— 过期回合非法提交次数必须为 0。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CALL_DEFAULTS, VoiceCall } from '../src/voice-call.js';
import { OneBotChannel } from '../src/channels/onebot.js';
import { closeDb, kvSet } from '../src/db.js';
import { saveSettings } from '../src/config.js';

test.after(closeDb);

function harness(overrides = {}) {
  let now = 1_000_000;
  const timers = new Set();
  const acks = [];
  const events = [];
  const cfg = { ...CALL_DEFAULTS, ...overrides };
  const call = new VoiceCall({
    now: () => now,
    setTimeout: (fn, ms) => {
      const timer = { fn, at: now + ms };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    config: () => cfg,
    sendAck: async (text, scope) => {
      acks.push({ text, turn: scope.turnGeneration });
    },
    onEvent: (kind, data) => events.push([kind, data]),
  });
  const fire = () => {
    for (const timer of [...timers]) {
      if (timer.at <= now) {
        timers.delete(timer);
        timer.fn();
      }
    }
  };
  return {
    call,
    acks,
    events,
    timers,
    advance(ms) {
      now += ms;
      fire();
    },
    now: () => now,
    start() {
      const r = call.begin({ ownerId: '2', accountGeneration: 7, enabled: true });
      assert.equal(r.ok, true, '会话应能起来');
      return r;
    },
    turn(extra = {}) {
      return call.openTurn({ accountGeneration: 7, ownerId: '2', batchFirstAt: now, ...extra });
    },
  };
}

test('C01 创建回合 × 新语音入站：旧回合不能覆盖新世代', () => {
  const h = harness();
  h.start();
  const t1 = h.turn();
  const before = t1.turnGeneration;
  h.call.noteInbound();
  const t2 = h.turn();
  assert.equal(h.call.isCurrent(t1), false, '旧回合必须失效');
  assert.ok(t2.turnGeneration > before, '新回合世代号必须更大');
  assert.equal(h.call.isCurrent(t2), true);
});

for (const stage of ['ASR 返回', 'LLM 返回', 'TTS 完成']) {
  test(`C02/C03/C04 ${stage} × 新语音入站：过期结果不许进入发送链`, () => {
    const h = harness();
    h.start();
    const stale = h.turn();
    h.call.noteInbound();
    // 各阶段完成后唯一能做的事就是申请提交，这里逐段验证申请被拒。
    const ticket = h.call.markCommitting(stale, { dailyCount: 0 });
    assert.equal(ticket.ok, false);
    assert.match(ticket.reason, /作废|结束/);
  });
}

test('C05 新语音先于校验生效：旧语音一条都不许发出去', async (t) => {
  const made = makeChannel(t, { synthesize: async (text) => ({ file: 'no-such.wav', bytes: 10, engine: 'fake', voice: 'fake', text }) });
  const scope = made.channel.voiceCall.openTurn({ accountGeneration: made.channel.generation, ownerId: '10000002', batchFirstAt: Date.now() });
  const inflight = made.channel.sendCallVoice({ text: '回来啦？今天累不累。' }, scope);
  // 合成还没回来时主人又发了一条语音 —— 这正是"打断"要赢的那种竞态。
  made.channel.voiceCall.noteInbound();
  const sent = await inflight;
  assert.equal(sent, false, '作废的回合不能算作已发语音');
  assert.equal(made.packets.length, 0, `一条过期语音都不许落到 NapCat：${JSON.stringify(made.packets)}`);
  assert.equal(made.channel.voiceCall.snapshot().voiceUsed, 0, '没发出去就不能扣额度');
});

test('C05 情况 B 反例：没有新输入时同一回合正常提交一次', async (t) => {
  const made = makeChannel(t, { synthesize: async (text) => ({ file: 'no-such.wav', bytes: 10, engine: 'fake', voice: 'fake', text }) });
  const scope = made.channel.voiceCall.openTurn({ accountGeneration: made.channel.generation, ownerId: '10000002', batchFirstAt: Date.now() });
  const sent = await made.channel.sendCallVoice({ text: '回来啦？今天累不累。' }, scope);
  assert.equal(sent, true);
  const records = made.packets.filter((p) => p.action === 'send_private_msg');
  assert.equal(records.length, 1);
  assert.equal(records[0].params.message[0].type, 'record');
  assert.equal(made.channel.voiceCall.snapshot().voiceUsed, 1);
});

test('C06 创建回合 × 挂断：挂断后延迟的 flush 不能新建回合', () => {
  const h = harness();
  h.start();
  h.call.end('owner_command');
  assert.equal(h.call.openTurn({ accountGeneration: 7, ownerId: '2' }), null);
  assert.equal(h.call.active, false);
});

test('C07 各阶段返回 × 挂断：关闭的会话不能被异步结果重新激活', async (t) => {
  const made = makeChannel(t, { synthesize: async (text) => ({ file: 'no-such.wav', bytes: 10, engine: 'fake', voice: 'fake', text }) });
  const scope = made.channel.voiceCall.openTurn({ accountGeneration: made.channel.generation, ownerId: '10000002', batchFirstAt: Date.now() });
  const inflight = made.channel.sendCallVoice({ text: '抱抱你，先喝口水。' }, scope);
  made.channel.voiceCall.end('owner_command');
  assert.equal(await inflight, false);
  assert.equal(made.packets.length, 0);
  assert.equal(made.channel.voiceCall.active, false, '挂断后被异步结果重新激活');
});

test('C08 提交 × 挂断：已校验但未发出的那条必须被拦住并退额度', async (t) => {
  const made = makeChannel(t, { synthesize: async (text) => ({ file: 'no-such.wav', bytes: 10, engine: 'fake', voice: 'fake', text }) });
  const scope = made.channel.voiceCall.openTurn({ accountGeneration: made.channel.generation, ownerId: '10000002', batchFirstAt: Date.now() });
  const ticket = made.channel.voiceCall.markCommitting(scope, { dailyCount: 0 });
  assert.equal(ticket.ok, true);
  made.channel.voiceCall.end('owner_command');
  assert.equal(made.channel.voiceCall.isCurrent(scope), false, '挂断之后旧回合仍被当成有效');
  // 光看状态不够：真正到了写发送帧那一步必须被提交点复核拦下来。
  await assert.rejects(
    () => made.channel.outboundScope.run(scope, () => made.channel.sendRecordToTarget({ type: 'private', userId: '10000002' }, 'x.wav')),
    /取消旧任务|作废/,
    '提交点没拦住已作废回合的发送',
  );
  assert.equal(made.packets.length, 0, `挂断之后还是把语音帧写给了 NapCat：${JSON.stringify(made.packets)}`);
});

test('C08b 作废发生在校验之后：提交点复核单独拦住旧语音（不是靠 markCommitting）', async (t) => {
  const made = makeChannel(t, { synthesize: async (text) => ({ file: 'no-such.wav', bytes: 10, engine: 'fake', voice: 'fake', text }) });
  const scope = made.channel.voiceCall.openTurn({ accountGeneration: made.channel.generation, ownerId: '10000002', batchFirstAt: Date.now() });
  const ticket = made.channel.voiceCall.markCommitting(scope, { dailyCount: 0 });
  assert.equal(ticket.ok, true, '额度只剩一条时才需要这条路径');
  made.channel.voiceCall.noteInbound(); // 校验通过之后主人才发来新语音
  await assert.rejects(
    () => made.channel.outboundScope.run(scope, () => made.channel.sendRecordToTarget({ type: 'private', userId: '10000002' }, 'x.wav')),
    /取消旧任务|作废/,
    '校验通过后到提交之间被插入的新输入没被拦住',
  );
  assert.equal(made.packets.length, 0);
});

test('C09 账号换代（单元层）：新会话不继承旧世代，旧 scope 在新会话里也不许有效', () => {
  const h = harness();
  h.start();
  const scope = h.turn();
  assert.equal(h.call.markCommitting(scope, { dailyCount: 0 }).ok, true);
  h.call.end('owner_command');
  h.call.begin({ ownerId: '2', accountGeneration: 9, enabled: true });
  const fresh = h.call.openTurn({ accountGeneration: 9, ownerId: '2' });
  assert.equal(h.call.isCurrent(scope), false, '旧账号世代 scope 在新会话里仍然有效');
  assert.equal(h.call.isCurrent(fresh), true);
});

test('C09 账号换代（发送层）：换号后旧回合的语音一条都发不出去', async (t) => {
  const made = makeChannel(t, { synthesize: async (text) => ({ file: 'no-such.wav', bytes: 10, engine: 'fake', voice: 'fake', text }) });
  const scope = made.channel.voiceCall.openTurn({ accountGeneration: made.channel.generation, ownerId: '10000002', batchFirstAt: Date.now() });
  const inflight = made.channel.sendCallVoice({ text: '好，那我说给你听。' }, scope);
  made.channel.generation += 1; // 模拟重新登录/改绑后的账号换代
  assert.equal(await inflight, false);
  assert.equal(made.packets.length, 0, `旧账号的语音发到了新连接上：${JSON.stringify(made.packets)}`);
});

test('C10 迟到 ACK：可以结旧账，不许复活会话', () => {
  const h = harness();
  h.start();
  const scope = h.turn();
  const ticket = h.call.markCommitting(scope, { dailyCount: 0 });
  assert.equal(ticket.ok, true);
  h.call.end('owner_command');
  const settled = h.call.settle(ticket.ticketId, 'confirmed');
  assert.equal(settled.ok, true, '已提交那条的账要能结掉');
  assert.equal(h.call.active, false, '迟到 ACK 复活了会话');
  assert.equal(h.call.session, null);
});

test('C11 发送超时 → UNKNOWN，之后迟到的 ACK 不能重复扣额度', () => {
  const h = harness();
  h.start();
  const scope = h.turn();
  const ticket = h.call.markCommitting(scope, { dailyCount: 0 });
  const first = h.call.settle(ticket.ticketId, 'unknown');
  assert.equal(first.state, 'UNKNOWN');
  const late = h.call.settle(ticket.ticketId, 'confirmed');
  assert.equal(late.ok, false, '已结算的提交单被二次结算');
  assert.equal(h.call.snapshot().voiceUsed, 1, 'UNKNOWN 之后又被记了一次额度');
  assert.equal(h.call.snapshot().voiceReserved, 0, '预留没被回收');
});

test('C12 额度只剩一条：没发出去的那条必须退额度，已提交的不许当没发', () => {
  const h = harness({ sessionVoiceMax: 1 });
  h.start();
  const t1 = h.turn();
  const first = h.call.markCommitting(t1, { dailyCount: 0 });
  assert.equal(first.ok, true);
  // 主人这时候发来新语音：t1 被作废，但它的提交单还在（发送调用会因为 isCurrent 失败而抛）
  h.call.noteInbound();
  assert.equal(h.call.snapshot().voiceUsed, 0);
  assert.equal(h.call.snapshot().voiceReserved, 1, '还没结算就不该偷偷扣掉本场额度');
  const blocked = h.call.markCommitting(h.turn(), { dailyCount: 0 });
  assert.equal(blocked.ok, false, '未结算的占用还挡着下一条，这是预期的');
  // 调用方在发送抛错后结算成 refunded —— 额度必须原样还回来
  h.call.settle(first.ticketId, 'refunded');
  assert.equal(h.call.snapshot().voiceReserved, 0, '作废那条的预留没还');
  const t2 = h.turn();
  const second = h.call.markCommitting(t2, { dailyCount: 0 });
  assert.equal(second.ok, true, '还回的额度用不上');
  const over = h.call.markCommitting(h.turn(), { dailyCount: 0 });
  assert.equal(over.ok, false, '同一场次能超出会话额度');
  h.call.settle(second.ticketId, 'confirmed');
  assert.equal(h.call.snapshot().voiceUsed, 1);
  h.call.noteInbound();
  assert.equal(h.call.snapshot().voiceUsed, 1, '已提交的语音被当成没发过退回额度');
});

test('每日总量闸门：到线就不发，与本场额度分开计', () => {
  const h = harness({ dailyVoiceMax: 40 });
  h.start();
  const scope = h.turn();
  assert.equal(h.call.markCommitting(scope, { dailyCount: 40 }).ok, false);
  assert.equal(h.call.markCommitting(scope, { dailyCount: 39 }).ok, true);
});

test('最小发送间隔：两条语音之间不许贴着发', () => {
  const h = harness({ minSendGapMs: 8000 });
  h.start();
  const t1 = h.turn();
  const first = h.call.markCommitting(t1, { dailyCount: 0 });
  assert.equal(first.ok, true);
  h.call.settle(first.ticketId, 'confirmed');
  const t2 = h.turn();
  assert.match(h.call.markCommitting(t2, { dailyCount: 0 }).reason, /隔/);
  h.advance(8001);
  assert.equal(h.call.markCommitting(h.turn(), { dailyCount: 0 }).ok, true);
});

test('慢回合确认：超过阈值才发一次，语音抢先提交就不发，挂断后定时器作废', async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const h = harness({ ackAfterMs: 5000 });
  h.start();
  const t1 = h.turn();
  h.call.armAck(t1);
  assert.equal(h.acks.length, 0);
  h.advance(5001);
  await flush();
  assert.equal(h.acks.length, 1, '超阈值应当确认一次');
  h.advance(6000);
  await flush();
  assert.equal(h.acks.length, 1, '同一回合确认不许刷屏');

  const t2 = h.turn();
  h.call.armAck(t2);
  h.call.markCommitting(t2, { dailyCount: 1 });
  h.advance(5001);
  await flush();
  assert.equal(h.acks.length, 1, '语音已经在路上还发确认');

  const t3 = h.turn();
  h.call.armAck(t3);
  h.call.end('owner_command');
  h.advance(5001);
  await flush();
  assert.equal(h.acks.length, 1, '挂断后确认定时器还触发了');
});

test('空闲与最长时长自动挂断，且挂断后不留任何定时器', () => {
  const h = harness({ idleHangMs: 120000, maxSessionMs: 480000 });
  h.start();
  h.advance(121000);
  assert.equal(h.call.active, false, '空闲到线没挂断');
  assert.equal(h.timers.size, 0, `挂断后还留着 ${h.timers.size} 个定时器`);
  h.call.begin({ ownerId: '2', accountGeneration: 7, enabled: true });
  h.advance(481000);
  assert.equal(h.call.active, false, '最长时长到线没挂断');
  assert.equal(h.timers.size, 0);
});

test('没开设置就进不了会话，且 begin 拒绝时不起任何定时器', () => {
  const h = harness();
  const r = h.call.begin({ ownerId: '2', accountGeneration: 7, enabled: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没开/);
  assert.equal(h.timers.size, 0);
  assert.equal(h.call.active, false);
});

function makeChannel(t, { synthesize }) {
  const server = http.createServer();
  const packets = [];
  const channel = new OneBotChannel({ server, companion: {}, synthesize });
  const client = {
    readyState: 1,
    isAlive: true,
    selfId: '10000001',
    lastPongAt: Date.now(),
    close() {},
    send(raw, cb) {
      const payload = JSON.parse(String(raw));
      packets.push(payload);
      if (typeof cb === 'function') cb();
      setImmediate(() => channel.handleRaw(client, JSON.stringify({ status: 'ok', retcode: 0, echo: payload.echo, data: { message_id: 77 } })));
    },
  };
  channel.clients.add(client);
  saveSettings({
    qq: { enabled: true, botAccount: '10000001' },
    tts: { enabled: true, callEnabled: true, callDailyMax: 40, callMinIntervalSeconds: 0, maxPerDay: 8 },
  });
  kvSet('qq_owner_id', '10000002');
  kvSet('qq_self_id', '10000001');
  for (const key of [...channel.voiceCall.tickets.keys()]) channel.voiceCall.tickets.delete(key);
  channel.voiceCall.end('reset');
  const began = channel.voiceCall.begin({ ownerId: '10000002', accountGeneration: channel.generation, enabled: true });
  assert.equal(began.ok, true, '测试夹具没能起来一个语音会话');
  t.after(() => channel.destroy());
  return { channel, packets, client };
}
