// 关闭态等价判据：新开关不许悄悄改变旧路径。
// 比的是同一条消息在 callEnabled 开/关两种设置下，旧路径消耗的东西是否逐项相同：
// 发送轨迹（顺序+内容）、随机数消费次数、定时器个数、本地 TTS 调用、kv 新增键。
// 只看次数不够 —— 次数相同顺序变了也可能出事，所以 packets 逐条深比。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { OneBotChannel, parseOwnerCommand } from '../src/channels/onebot.js';
import { closeDb, getDb, kvSet } from '../src/db.js';
import { loadSettings, saveSettings } from '../src/config.js';
import { localTts } from '../src/tts.js';

test.after(closeDb);

const allKeys = () => new Set(getDb().prepare('SELECT key FROM kv').all().map((row) => row.key));

async function drive(t, { callEnabled, messages, replyText = () => '我在想你呀。' }) {
  saveSettings({
    qq: { enabled: true, botAccount: '10000001', sendStickers: false, selfFollowUp: false, sleepyMode: false, allowAllPrivate: false },
    tts: { enabled: true, callEnabled, maxPerDay: 8, maxChars: 120, chance: 0.18, voice: 'zh-CN-XiaoxiaoNeural' },
  });
  kvSet('qq_owner_id', '10000002');
  kvSet('qq_self_id', '10000001');
  const server = http.createServer();
  const channel = new OneBotChannel({
    server,
    companion: { reply: async () => ({ text: replyText(), stickerHint: null }) },
    synthesize: async () => ({ file: 'no-such.wav', bytes: 8, engine: 'fake', voice: 'fake', text: 'x' }),
  });
  const packets = [];
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
      setImmediate(() => channel.handleRaw(client, JSON.stringify({ status: 'ok', retcode: 0, echo: payload.echo, data: { message_id: packets.length + 900 } })));
    },
  };
  channel.clients.add(client);
  // handleRaw 对入站消息也要核身份：事件必须带 self_id，并且通道的 selfId 得有值，
  // 否则消息在入口就被丢了（我第一版夹具就是这么静默地一条都没发出去）。
  channel.selfId = '10000001';
  t.after(() => channel.destroy());

  const keysBefore = allKeys();
  const originalRandom = Math.random;
  let randomCalls = 0;
  Math.random = () => {
    randomCalls += 1;
    // 固定成不会命中概率语音的值：两条路径必须走同一个分支，比的是结构不是运气。
    return 0.95;
  };
  let timers = 0;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function counted(fn, ms, ...rest) {
    timers += 1;
    return originalSetTimeout(fn, ms, ...rest);
  };
  try {
    for (const item of messages) {
      channel.handleRaw(client, JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        self_id: 10000001,
        user_id: item.userId,
        message_id: item.id,
        time: Math.floor(Date.now() / 1000),
        message: [{ type: 'text', data: { text: item.text } }],
      }));
      await new Promise((resolve) => originalSetTimeout(resolve, 2700));
    }
    await new Promise((resolve) => originalSetTimeout(resolve, 1500));
  } finally {
    Math.random = originalRandom;
    globalThis.setTimeout = originalSetTimeout;
  }
  const keysAfter = allKeys();
  return {
    packets: packets.map((p) => ({ action: p.action, parts: (p.params?.message || []).map((seg) => (seg.type === 'text' ? `text:${seg.data.text}` : seg.type)) })),
    randomCalls,
    timers,
    newKeys: [...keysAfter].filter((k) => !keysBefore.has(k)),
    callState: channel.voiceCall.state,
    tickets: channel.voiceCall.tickets.size,
    callTimers: channel.voiceCall.timers.size,
    localCalls: localTts().status().metrics.calls,
  };
}

const MESSAGES = [
  { id: 7001, userId: '10000002', text: '在干嘛' },
  { id: 7002, userId: '10000002', text: '今天好累' },
];

test('开关关掉、与打开但没进入会话：旧收发路径逐字等价', async (t) => {
  const off = await drive(t, { callEnabled: false, messages: MESSAGES });
  const on = await drive(t, { callEnabled: true, messages: MESSAGES.map((m) => ({ ...m, id: m.id + 100 })) });
  // 先自证"这条判据测到了东西"：真有发出帧、真摇了随机数，否则后面比的是两条空轨迹。
  const sent = off.packets.filter((p) => p.action === 'send_private_msg');
  assert.ok(sent.length >= 2, `夹具根本没把消息走到发送步（只发了 ${sent.length} 条），等价比较是空的`);
  assert.ok(sent.some((p) => (p.text || p.parts.join('')).includes('我在想你呀')), '桩回复没走到发送，比较无意义');
  assert.ok(off.randomCalls > 0, '这条路径根本没消耗随机数，随机数比较是空的');
  assert.deepEqual(on.packets, off.packets, `发送轨迹变了：${JSON.stringify({ off: off.packets, on: on.packets })}`);
  assert.equal(on.randomCalls, off.randomCalls, `随机数消费次数从 ${off.randomCalls} 变成 ${on.randomCalls}，概率闸门不再等价`);
  assert.equal(on.timers, off.timers, '定时器个数变了');
  assert.equal(off.callState, 'DISABLED');
  assert.equal(on.callState, 'DISABLED', '光是打开开关就把状态机推进了');
  assert.equal(on.tickets, 0);
  assert.equal(on.callTimers, 0, '未进入会话却注册了会话专属定时器');
  assert.equal(on.localCalls, 0, '没选本地音色却跑了本地 TTS');
});

test('关闭态不写语音会话专属状态键', async (t) => {
  const run = await drive(t, { callEnabled: false, messages: [{ id: 7101, userId: '10000002', text: '随便说一句' }] });
  const offenders = run.newKeys.filter((k) => /^(call_|voice_call|qq_call)/.test(k));
  assert.deepEqual(offenders, [], `关闭态写入了会话状态键：${offenders.join(',')}`);
});

test('口令解析：只有明确指令才进出语音会话，普通句子不误触发', () => {
  assert.equal(parseOwnerCommand('/语音聊天'), 'call_on');
  assert.equal(parseOwnerCommand('打语音'), 'call_on');
  assert.equal(parseOwnerCommand('打电话给你'), null, '带上下文的普通句子被当成了口令');
  assert.equal(parseOwnerCommand('我想和你打语音可以吗'), null, '疑问句被当成了口令');
  assert.equal(parseOwnerCommand('/挂断'), 'call_off');
  assert.equal(parseOwnerCommand('挂断'), 'call_off');
});

test('新增字段都在 tts 段内、默认关，且不新开顶层键', () => {
  const defaults = JSON.parse(fs.readFileSync('config/default-settings.json', 'utf8'));
  assert.equal(defaults.tts.callEnabled, false);
  assert.equal(defaults.tts.volume, '');
  assert.equal(defaults.tts.callDailyMax, 40);
  assert.equal(defaults.tts.callMinIntervalSeconds, 8);
  assert.ok(!('voiceCall' in defaults), '语音会话字段跑到了顶层');
});

test('夹取：越界的会话额度压回安全范围，非法音量值变空', () => {
  saveSettings({ tts: { callEnabled: true, callDailyMax: 5000, callMinIntervalSeconds: -9, volume: 'rm -rf' } });
  const back = loadSettings().tts;
  assert.equal(back.callDailyMax, 80, '当日语音总量没被夹住');
  assert.equal(back.callMinIntervalSeconds, 0, '负间隔没被归零');
  assert.equal(back.volume, '', '非法音量值没清空');
});

test('音色目录能选本地 matcha，且配置层认它（不静默退回默认音色）', () => {
  saveSettings({ tts: { voice: 'local-matcha' } });
  assert.equal(loadSettings().tts.voice, 'local-matcha');
  saveSettings({ tts: { voice: 'local-没有这个' } });
  assert.equal(loadSettings().tts.voice, 'zh-CN-XiaoxiaoNeural', '非法音色被静默改成默认这件事要有个明确结果');
});
