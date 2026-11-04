import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildEdgeArgs } from '../src/tts.js';
import { normalizeSettings } from '../src/config.js';
import { OneBotChannel } from '../src/channels/onebot.js';
import { saveSettings } from '../src/config.js';
import { closeDb } from '../src/db.js';
import { startTestServer } from './helpers/runtime.js';

test.after(closeDb);

for (const [rate, pitch, volume] of [['+2%', '-12Hz', ''], ['-8%', '-12Hz', '-10%'], ['+0%', '+0Hz', '+0%']]) {
  test(`Edge 参数不会把带符号的值当选项：${rate}/${pitch}/${volume}`, () => {
    const args = buildEdgeArgs('我在呢。', { voice: 'zh-CN-XiaoxiaoNeural', rate, pitch, volume }, 'out.mp3');
    assert.ok(args.includes(`--rate=${rate}`));
    assert.ok(args.includes(`--pitch=${pitch}`));
    assert.equal(args.includes('--rate'), false);
    assert.equal(args.includes('--pitch'), false);
    assert.equal(args.some(arg => arg.startsWith('--volume=')), Boolean(volume));
    if (volume) assert.ok(args.includes(`--volume=${volume}`));
    assert.deepEqual(args.slice(-4), ['--text', '我在呢。', '--write-media', 'out.mp3']);
  });
}

test('无效语速和音高回到沉稳女声默认值，合法零值保留', () => {
  const invalid = normalizeSettings({ tts: { rate: 'bad', pitch: 'bad' } }).tts;
  assert.equal(invalid.rate, '+2%');
  assert.equal(invalid.pitch, '-12Hz');
  const zero = normalizeSettings({ tts: { rate: '+0%', pitch: '+0Hz' } }).tts;
  assert.equal(zero.rate, '+0%');
  assert.equal(zero.pitch, '+0Hz');
});

test('普通 QQ 语音调参不把零值替换成旧的高音默认值', async () => {
  saveSettings({ tts: { enabled: true, rate: '+0%', pitch: '+0Hz', maxChars: 120 } });
  let captured;
  const channel = {
    voiceBudgetLeft: () => ({ ok: true }),
    sendVoiceAndCount: async (text, options) => { captured = options; },
  };
  const sent = await OneBotChannel.prototype.maybeSendVoice.call(channel, { text: '我在呢，今天慢慢说。', voice: true });
  assert.equal(sent, true);
  assert.ok(Math.abs(parseInt(captured.rate, 10)) <= 4, captured.rate);
  assert.ok(Math.abs(parseInt(captured.pitch, 10)) <= 2, captured.pitch);
});

test('试听与陪伴朗读都传递音量，音色对比返回实际音色', () => {
  const index = fs.readFileSync('src/index.js', 'utf8');
  const preview = index.split("pathname === '/api/voice/preview'")[1].split("pathname === '/api/voice/compare'")[0];
  assert.match(preview, /volume: body\.volume \?\? cfg\.volume/);
  assert.match(index, /actualVoice: audio\.voice/);
  const presence = fs.readFileSync('src/presence.js', 'utf8');
  assert.match(presence, /volume: settings\?\.tts\?\.volume/);
});

test('聊天朗读不要求打开陪伴自动发声，但仍受配额限制', async (t) => {
  const app = await startTestServer(t, { settings: { tts: { enabled: true }, presence: { speakReplies: false, speakDailyMax: 0 } } });
  const request = path => fetch(`${app.base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BiZhi-Request': '1' }, body: JSON.stringify({ text: '我在呢。' }),
  });
  const chat = await request('/api/voice/speak');
  assert.equal(chat.status, 403);
  assert.match((await chat.json()).error, /每日上限设成了 0/);
  const presence = await request('/api/presence/speak');
  assert.equal(presence.status, 403);
});

test('关闭语音后，聊天朗读接口不能偷偷合成', async (t) => {
  const app = await startTestServer(t, { settings: { tts: { enabled: false } } });
  const result = await fetch(`${app.base}/api/voice/speak`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BiZhi-Request': '1' }, body: JSON.stringify({ text: '我在呢。' }),
  });
  assert.equal(result.status, 403);
});
