import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = process.cwd();
const nativeTests = process.env.BIZHI_LOCAL_VOICE_TESTS === '1';
const dataDir = path.join(ROOT, 'data', `test-asr-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    qq: { enabled: true, botAccount: '2000000001' },
    tts: { enabled: true, voice: 'zh-TW-HsiaoChenNeural', rate: '+10%', pitch: '-1Hz', listen: true },
  }),
  'utf8',
);
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { loadSettings } = await import('../src/config.js');
const { asrStatus, transcribeRecord, transcribeWav } = await import('../src/asr.js');
const { normalizeVoice, synthesizeSpeech, ttsStatus, ttsVoices } = await import('../src/tts.js');
const { OneBotChannel } = await import('../src/channels/onebot.js');
const { closeDb, kvSet, listEvents } = await import('../src/db.js');

function fakeClient(reply) {
  const sent = [];
  return {
    client: {
      readyState: 1,
      selfId: '2000000001',
      isAlive: true,
      ping() {},
      on() {},
      send(payload, cb) {
        const parsed = JSON.parse(payload);
        sent.push(parsed);
        cb(null);
        setTimeout(() => {
          for (const [echo, entry] of channel.pending) {
            if (echo === parsed.echo) {
              clearTimeout(entry.timer);
              channel.pending.delete(echo);
              entry.resolve({ status: 'ok', retcode: 0, echo, ...reply(parsed) });
            }
          }
        }, 5);
      },
    },
    sent,
  };
}

let channel = null;

test('音色与听语音开关能存下来（不再被写死白名单吃掉）', () => {
  const settings = loadSettings();
  assert.equal(settings.tts.voice, 'zh-TW-HsiaoChenNeural');
  assert.equal(settings.tts.rate, '+10%');
  assert.equal(settings.tts.pitch, '-1Hz');
  assert.equal(settings.tts.listen, true);
  assert.equal(normalizeVoice('瞎写的音色'), 'zh-CN-XiaoxiaoNeural');
  assert.ok(ttsVoices().length >= 8, '控制台至少要有 8 个音色可选');
  if (nativeTests) assert.equal(ttsStatus().edge, true, '本机验收要求 voice/pyenv 已安装');
  else assert.equal(typeof ttsStatus().edge, 'boolean');
});

test('本地识别模型确实在磁盘上，不是嘴上说说', { skip: !nativeTests }, () => {
  const status = asrStatus();
  assert.equal(status.ready, true, status.error);
  assert.equal(status.engine, 'sensevoice');
  assert.ok(status.modelBytes > 100 * 1024 * 1024, `模型只有 ${status.modelBytes} 字节`);
});

test('她说的话能被她自已听回来（本地出声 → SenseVoice 识别）', { timeout: 180000, skip: !nativeTests }, async () => {
  const audio = await synthesizeSpeech('今天的天气很不错，我们出去走走吧', { voice: 'local-piper', maxChars: 40 });
  assert.equal(audio.engine, 'piper');
  assert.match(audio.file, /\.wav$/);
  const heard = await transcribeWav(audio.file);
  fs.rmSync(audio.file, { force: true });
  assert.equal(heard.engine, 'sensevoice', heard.error);
  assert.ok(heard.text.includes('今天'), `识别结果是「${heard.text}」`);
  assert.ok(heard.text.includes('出去'), `识别结果是「${heard.text}」`);
  assert.equal(asrStatus().warm, true);
});

test('QQ 直接给 wav 路径时不绕路，给的是语音文字时优先用', { skip: !nativeTests }, async () => {
  const wav = await synthesizeSpeech('记得带伞', { voice: 'local-piper', maxChars: 20 }).then((a) => a.file);
  const direct = await transcribeRecord({ file: wav });
  assert.equal(direct.engine, 'sensevoice', direct.error);
  assert.ok(direct.text.length >= 2, direct.text);
  fs.rmSync(wav, { force: true });
  const fromQq = await transcribeRecord({ text: '帮我定个明早七点的闹钟' });
  assert.equal(fromQq.engine, 'qq');
  assert.match(fromQq.text, /闹钟/);
});

test('语音转 wav：成功就拿到路径，失败要落到事件里', { skip: !nativeTests }, async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  channel = new OneBotChannel({ server, companion: {} });
  const wav = await synthesizeSpeech('转码这条给我', { voice: 'local-piper', maxChars: 20 }).then((a) => a.file);

  const ok = fakeClient(() => ({ data: { file: wav } }));
  channel.clients.add(ok.client);
  assert.equal(await channel.fetchRecordWav({ file: 'abc.slk' }), wav);
  assert.equal(ok.sent[0].action, 'get_record');
  assert.equal(ok.sent[0].params.out_format, 'wav');

  channel.clients.delete(ok.client);
  const bad = fakeClient(() => ({ status: 'failed', retcode: 1, errorMessage: 'silk 坏了' }));
  channel.clients.add(bad.client);
  assert.equal(await channel.fetchRecordWav({ file: 'broken.slk' }), '');
  const events = listEvents(20).map((e) => e.type);
  assert.ok(events.includes('qq_record_convert_error'), `事件里没有转码失败：${events.join(',')}`);

  channel.clients.delete(bad.client);
  const empty = fakeClient(() => ({ data: {} }));
  channel.clients.add(empty.client);
  assert.equal(await channel.fetchRecordWav({}), '');
  assert.equal(empty.sent.length, 0, '没有文件标识时不该去打 NapCat');

  channel.clients.delete(empty.client);
  const order = fakeClient((parsed) => (parsed.params.file === 'FID123' ? { data: { file: wav } } : { status: 'failed', retcode: 1 }));
  channel.clients.add(order.client);
  assert.equal(await channel.fetchRecordWav({ file: 'gone.slk', file_id: 'FID123' }), wav);
  assert.deepEqual(order.sent.map((s) => s.params.file), ['FID123'], '路径不在磁盘上时要先试 file_id');

  channel.clients.delete(order.client);
  const both = fakeClient(() => ({ status: 'failed', retcode: 2 }));
  channel.clients.add(both.client);
  assert.equal(await channel.fetchRecordWav({ file: 'gone.slk', file_id: 'FID_BAD' }), '');
  assert.deepEqual(both.sent.map((s) => s.params.file), ['FID_BAD', 'gone.slk'], '两个标识要按顺序都试过才算失败');

  fs.rmSync(wav, { force: true });
  channel.destroy();
  server.close();
});

test('自检链路：发出去 → 回读语音段 → 转 wav → 听回来', { timeout: 120000, skip: !nativeTests }, async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const probe = new OneBotChannel({ server, companion: {} });
  probe.selfId = '2000000001';
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ qq: { enabled: true, botAccount: '2000000001' }, tts: { enabled: true, voice: 'local-piper', maxPerDay: 8, listen: true } }),
    'utf8',
  );
  const wav = await synthesizeSpeech('这条用来做链路自检', { voice: 'local-piper', maxChars: 30 }).then((a) => a.file);
  const answers = [];
  probe.clients.add({
    readyState: 1,
    selfId: '2000000001',
    isAlive: true,
    ping() {},
    on() {},
    send(payload, cb) {
      const parsed = JSON.parse(payload);
      answers.push(parsed.action);
      cb(null);
      setTimeout(() => {
        for (const [echo, entry] of probe.pending) {
          if (echo !== parsed.echo) continue;
          clearTimeout(entry.timer);
          probe.pending.delete(echo);
          if (parsed.action === 'send_private_msg') {
            assert.equal(parsed.params.message[0].type, 'record');
            entry.resolve({ status: 'ok', retcode: 0, echo, data: { message_id: 555 } });
          } else if (parsed.action === 'get_msg') {
            assert.equal(parsed.params.message_id, 555);
            entry.resolve({
              status: 'ok',
              retcode: 0,
              echo,
              data: { message: [{ type: 'record', data: { file: 'sent-from-qq.slk', voice_wts: 3 } }] },
            });
          } else if (parsed.action === 'get_record') {
            assert.equal(parsed.params.file, 'sent-from-qq.slk');
            entry.resolve({ status: 'ok', retcode: 0, echo, data: { file: wav } });
          }
        }
      }, 5);
    },
  });
  kvSet('qq_owner_id', '123456789');

  const result = await probe.echoCheck('这条用来做链路自检');
  assert.deepEqual(answers, ['send_private_msg', 'get_msg', 'get_record'], `链路顺序不对：${answers.join('→')}`);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.engine, 'piper');
  assert.equal(result.seconds, 3);
  assert.ok(result.heard.length >= 4, `听回来的太短：「${result.heard}」`);
  assert.ok(result.heard.includes('这条'), `听回来的是「${result.heard}」`);

  probe.destroy();
  server.close();
  fs.rmSync(wav, { force: true });
});

test.after(() => {
  try {
    closeDb();
  } catch {
    // 已经关过了
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
