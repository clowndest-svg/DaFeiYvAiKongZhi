import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-voice-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ qq: { enabled: true, botAccount: '2000000001' }, tts: { enabled: true, chance: 1, maxPerDay: 2, voice: 'local-piper' } }), 'utf8');
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { OneBotChannel } = await import('../src/channels/onebot.js');
const { parseStickerHint } = await import('../src/chat.js');
const { closeDb, kvGet } = await import('../src/db.js');

test('[[voice]] 标记会被剥掉并留下意图', () => {
  assert.deepEqual(parseStickerHint('早点睡呀[[voice]]'), { text: '早点睡呀', hint: null, voice: true });
  assert.equal(parseStickerHint('哼[[sticker:shy]][[voice]]').voice, true);
  assert.equal(parseStickerHint('正常说话').voice, false);
});

test('她发语音时真的走 record 段，并且每天有条数上限', async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const synthesize = async (text) => {
    const file = path.join(dataDir, `voice-fixture-${sent.length}.wav`);
    fs.writeFileSync(file, Buffer.alloc(1024));
    return { file, bytes: 1024, mime: 'audio/wav', engine: 'piper', voice: 'local-piper', text };
  };
  const channel = new OneBotChannel({ server, companion: {}, synthesize });
  channel.selfId = '2000000001';
  const sent = [];
  const existedAtSend = [];
  channel.clients.add({
    readyState: 1,
    selfId: '2000000001',
    isAlive: true,
    ping() {},
    on() {},
    send(payload, cb) {
      const parsed = JSON.parse(payload);
      sent.push(parsed);
      if (parsed.action === 'send_private_msg') {
        existedAtSend.push(fs.existsSync(parsed.params.message[0].data.file));
      }
      cb(null);
      setTimeout(() => {
        for (const [echo, entry] of channel.pending) {
          if (echo === parsed.echo) {
            clearTimeout(entry.timer);
            channel.pending.delete(echo);
            entry.resolve({ status: 'ok', retcode: 0, echo, data: { message_id: 99 } });
          }
        }
      }, 5);
    },
  });
  const db = await import('../src/db.js');
  db.kvSet('qq_owner_id', '123456789');

  assert.equal(await channel.maybeSendVoice({ text: '今天也要好好吃饭哦，不许再熬夜了', voice: true }), true, '第一次应该发出去');
  assert.equal(sent[0]?.action, 'send_private_msg');
  assert.equal(sent[0]?.params?.message?.[0]?.type, 'record');
  assert.match(sent[0].params.message[0].data.file, /\.wav$/, '设置里选了 local-piper 就该走本地声，说明音色真的传进去了');
  assert.equal(fs.existsSync(sent[0].params.message[0].data.file), false, '发完立刻删，不在 media 里堆');
  assert.equal(await channel.maybeSendVoice({ text: '第二句我也想说给你听', voice: true }), true);
  assert.deepEqual(existedAtSend, [true, true], '发出去那一刻音频必须真的在盘上');
  assert.equal(await channel.maybeSendVoice({ text: '第三句就超额度了', voice: true }), false, '每天上限要生效');
  await assert.rejects(() => channel.sendVoiceAndCount('换个入口也该看同一个额度'), /额度/, '控制台/口令/自检都走同一道额度');
  assert.equal(await channel.maybeSendVoice({ text: '短', voice: true }), false, '太短不发');
  assert.equal(await channel.maybeSendVoice({ text: '看这个链接 https://example.com/a', voice: true }), false, '带链接不发');
  assert.equal(channel.voiceCountToday(), 2, '被拦下的不该占额度');
  assert.equal(fs.readdirSync(path.join(dataDir, 'media')).filter((f) => f.startsWith('voice-')).length, 0, '语音产物不该留在盘上');
  assert.ok(kvGet('qq_owner_id'));

  channel.destroy();
  server.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test.after(() => {
  try {
    closeDb();
  } catch {
    // 已经关过了
  }
});
