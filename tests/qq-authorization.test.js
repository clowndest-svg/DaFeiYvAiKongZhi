import test from 'node:test';
import assert from 'node:assert/strict';
import { isQzonePostIntent, OneBotChannel } from '../src/channels/onebot.js';
import { loadSettings, saveSettings } from '../src/config.js';
import { closeDb, kvSet } from '../src/db.js';
import http from 'node:http';

test.after(closeDb);

test('否定、问题、引用和模糊索图不会发说说', () => {
  for (const text of ['不要发说说', '别发空间', '你能发说说吗', '如果我说发说说会怎样', '他说“发个说说”', '发个看看', '我昨晚发说说了', '今天发烧了想跟你说说话']) assert.equal(isQzonePostIntent(text), false, text);
  assert.equal(isQzonePostIntent('帮我发个说说'), true);
  assert.equal(isQzonePostIntent('现在发一条 QQ 空间动态'), true);
});

test('双连接只向身份匹配的小号发，停用后连读凭据也不发', async (t) => {
  const server = http.createServer();
  const channel = new OneBotChannel({ server, companion: {} });
  t.after(() => { channel.destroy(); server.close(); });
  saveSettings({ qq: { enabled: true, botAccount: '10000001' } });
  kvSet('qq_owner_id', '10000002');
  channel.selfId = '10000001';
  const packets = [];
  const fake = (selfId) => ({ selfId, readyState: 1, isAlive: true, close() {}, send(raw, callback) {
    const packet = JSON.parse(raw); packets.push({ selfId, ...packet }); callback?.();
    process.nextTick(() => channel.handleRaw(this, Buffer.from(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data: { message_id: 1 } }))));
  } });
  channel.clients.add(fake('10000002'));
  channel.clients.add(fake('10000001'));
  await channel.sendToTarget({ type: 'private', userId: '10000002' }, '测试');
  assert.equal(packets[0].selfId, '10000001');
  saveSettings({ qq: { enabled: false } });
  await assert.rejects(() => channel.sendAction('get_credentials', {}), /停用|关闭/);
  assert.equal(packets.length, 1);
  saveSettings({ qq: { enabled: true, botAccount: loadSettings().qq.botAccount } });
});
