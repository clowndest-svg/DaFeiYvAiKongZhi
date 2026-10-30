import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer } from './helpers/runtime.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function wavBase64(seconds = 0.6, sampleRate = 16000) {
  const frames = Math.floor(seconds * sampleRate);
  const body = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) body.writeInt16LE(Math.round(Math.sin(i / 10) * 4000), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + body.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(body.length, 40);
  return Buffer.concat([head, body]).toString('base64');
}

test('没开开关时三条口都不开门，开了以后才认格式', { timeout: 120000 }, async (t) => {
  const server = await startTestServer(t, { settings: { presence: { cameraEnabled: false, micEnabled: false, speakReplies: false } } });
  const post = async (pathname, body) => {
    const res = await fetch(server.base + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.base, 'x-bizhi-request': '1' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const hear = await post('/api/presence/hear', { audio: wavBase64() });
  assert.equal(hear.status, 403, '麦克风没开就该 403');
  assert.match(hear.body.error, /关的/);
  const look = await post('/api/presence/look', { image: PNG });
  assert.equal(look.status, 403);
  assert.match(look.body.error, /摄像头是关的/);
  const speak = await post('/api/presence/speak', { text: '你好' });
  assert.equal(speak.status, 403);
  assert.match(speak.body.error, /念话是关的/);

  const put = await fetch(server.base + '/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: server.base, 'x-bizhi-request': '1' },
    body: JSON.stringify({ presence: { cameraEnabled: true, micEnabled: true, cameraDailyMax: 1, cameraIntervalSeconds: 30 } }),
  });
  assert.equal(put.status, 200);

  const badImage = await post('/api/presence/look', { image: 'hello' });
  assert.equal(badImage.status, 400, '开了以后还要挑格式');
  assert.match(badImage.body.error, /png|jpeg|webp/);
  const badAudio = await post('/api/presence/hear', { audio: 'aGVsbG8=' });
  assert.equal(badAudio.status, 400);
  assert.match(badAudio.body.error, /wav/);

  const first = await post('/api/presence/look', { image: PNG });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.text.length > 0);
  assert.equal(first.body.budget.cameraToday, 1);
  const second = await post('/api/presence/look', { image: PNG });
  assert.equal(second.status, 429, '日额度只有 1 条，第二条必须挡掉');
  assert.match(second.body.error, /用完|再等/);
});

test('她看过的画面会真的变成一条对话，而不是只回一句就丢掉', { timeout: 120000 }, async (t) => {
  const server = await startTestServer(t, { settings: { presence: { cameraEnabled: true, cameraDailyMax: 5, sensesEnabled: true } } });
  const res = await fetch(server.base + '/api/presence/look', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.base, 'x-bizhi-request': '1' },
    body: JSON.stringify({ image: PNG, caption: '这是我桌上那杯' }),
  });
  assert.equal(res.status, 200);
  const messages = await (await fetch(server.base + '/api/messages', { headers: { origin: server.base } })).json();
  const userLine = messages.messages.find((m) => m.role === 'user');
  assert.match(userLine.content, /这是我桌上那杯/);
  assert.equal(userLine.meta.hasImage, true, '要记住这是带画面的一次');
  const state = await (await fetch(server.base + '/api/presence/state', { headers: { origin: server.base } })).json();
  assert.equal(state.budget.cameraToday, 1);
  assert.equal(state.brain.links.look, 1, '「看过」要计入真实连接数');
  assert.equal(state.senses.count, 1, '开着的感官记忆要收下这次看到的');
  assert.equal(state.senses.items[0].kind, 'sight');
});

test('状态接口是轮询用的：并发两次不许把自己撞成 409', { timeout: 120000 }, async (t) => {
  const server = await startTestServer(t, { settings: {} });
  const results = await Promise.all([
    fetch(server.base + '/api/presence/state', { headers: { origin: server.base } }),
    fetch(server.base + '/api/presence/state', { headers: { origin: server.base } }),
    fetch(server.base + '/api/presence/curve?id=1', { headers: { origin: server.base } }),
  ]);
  assert.deepEqual(results.map((res) => res.status), [200, 200, 404], 'curve 在没有那条记忆时明确说没有');
  const state = await results[0].json();
  for (const key of ['presence', 'budget', 'neuro', 'senses', 'brain', 'mood']) {
    assert.ok(Object.hasOwn(state, key), `状态接口少了 ${key}，界面就只能空着`);
  }
});

test('权限头只把摄像头和麦克风给本控制台自己，定位仍然不给', { timeout: 120000 }, async (t) => {
  const server = await startTestServer(t, { settings: {} });
  const page = await fetch(server.base + '/');
  const policy = page.headers.get('permissions-policy');
  assert.ok(policy, '要有限制设备的头');
  assert.match(policy, /camera=\(?self\)?/);
  assert.match(policy, /microphone=\(?self\)?/);
  assert.match(policy, /geolocation=\(\)/, '定位还是要全程关着');
  assert.ok(!/camera=\(\*\)/.test(policy), '不许放开成任意来源');
});

test('重口都上了锁：同一时刻只允许一次合成或识别在跑', { timeout: 120000 }, async (t) => {
  const server = await startTestServer(t, { settings: { presence: { cameraEnabled: true, cameraDailyMax: 20 } } });
  const call = () => fetch(server.base + '/api/presence/look', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.base, 'x-bizhi-request': '1' },
    body: JSON.stringify({ image: PNG }),
  });
  const [a, b] = await Promise.all([call(), call()]);
  const statuses = [a.status, b.status].sort();
  assert.equal(statuses[0], 200);
  assert.equal(statuses[1], 409, '第二次要被告知「正在处理」，而不是偷偷并发起两个模型调用');
});

test('临时语音文件不许留在盘上（识别完就删）', { timeout: 120000 }, async (t) => {
  const server = await startTestServer(t, { settings: { presence: { micEnabled: true } } });
  await fetch(server.base + '/api/presence/hear', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.base, 'x-bizhi-request': '1' },
    body: JSON.stringify({ audio: wavBase64() }),
  });
  const dir = path.join(server.dir, 'presence-tmp');
  assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, '识别完目录里不该有残留');
});

test('识别模型没就绪时明确报错，不把「听不到」伪装成听到了空话', { timeout: 120000 }, async (t) => {
  const server = await startTestServer(t, { settings: { presence: { micEnabled: true } } });
  const res = await fetch(server.base + '/api/presence/hear', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.base, 'x-bizhi-request': '1' },
    body: JSON.stringify({ audio: wavBase64(3) }),
  });
  const body = await res.json();
  if (res.status === 200) {
    assert.ok(typeof body.text === 'string');
    assert.equal(body.engine, 'sensevoice', '本机装了模型，就该真的走本机识别');
  } else {
    assert.equal(res.status, 500);
    assert.match(body.error, /没听清/, '没装模型要给出原因，不能静默返回空文本');
  }
});

test('念话失败不烧当天的额度，成功才计一次', async () => {
  const { checkSpeakSlot, noteSpeakUsed, presenceBudget } = await import('../src/presence.js');
  const settings = { presence: { speakDailyMax: 2 } };
  assert.equal(presenceBudget(settings).speakToday, 0);
  checkSpeakSlot(settings);
  noteSpeakUsed(settings);
  assert.equal(presenceBudget(settings).speakToday, 1, '只有合成成功才 +1');
  checkSpeakSlot(settings);
  noteSpeakUsed(settings);
  assert.equal(presenceBudget(settings).speakToday, 2);
  assert.throws(() => checkSpeakSlot(settings), /用完/);
  assert.equal(presenceBudget(settings).speakToday, 2, '被挡掉的那次不许再把计数往上推');
});

test('上限设成 0 就是「不做」，不是「随便做」', async () => {
  const { consumeCameraSlot, presenceBudget } = await import('../src/presence.js');
  assert.throws(() => consumeCameraSlot({ presence: { cameraEnabled: true, cameraDailyMax: 0 } }), /上限设成了 0/);
  assert.throws(() => consumeCameraSlot({ presence: { cameraEnabled: false, cameraDailyMax: 5 } }), /摄像头是关的/);
  assert.equal(presenceBudget({ presence: { cameraDailyMax: 3, cameraIntervalSeconds: 45 } }).cameraMax, 3);
});

test('wav 校验只收浏览器真能产出的那几种，长度也要管住', async () => {
  const { readWavInfo, MAX_WAV_SECONDS } = await import('../src/presence.js');
  assert.equal(readWavInfo(Buffer.from('hello')).ok, false);
  assert.match(readWavInfo(Buffer.concat([Buffer.alloc(44, 0), Buffer.alloc(100)])).error, /RIFF|fmt/);
  assert.equal(readWavInfo(Buffer.from(wavBase64(1), 'base64')).ok, true);
  const tooLong = readWavInfo(Buffer.from(wavBase64(MAX_WAV_SECONDS + 20), 'base64'));
  assert.equal(tooLong.ok, false, `${MAX_WAV_SECONDS} 秒以外不许解`);
  const tooShort = readWavInfo(Buffer.from(wavBase64(0.05), 'base64'));
  assert.equal(tooShort.ok, false);
  assert.match(tooShort.error, /太短/);
});
