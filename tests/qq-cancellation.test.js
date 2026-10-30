import test from 'node:test';
import assert from 'node:assert/strict';
import { OneBotChannel } from '../src/channels/onebot.js';
import { closeDb, kvSet } from '../src/db.js';
import { saveSettings } from '../src/config.js';
import http from 'node:http';

test.after(closeDb);
test('账号改绑取消正在等待的旧对话，包括重新启用后的发送', async (t) => {
  const server = http.createServer();
  const channel = new OneBotChannel({ server, companion: {} });
  t.after(() => channel.destroy());
  saveSettings({ qq: { enabled: true, botAccount: '10000001' } });
  kvSet('qq_owner_id', '10000002');
  const scope = { generation: channel.generation, ownerId: '10000002' };
  let packets = 0;
  channel.clients.add({ selfId: '10000001', readyState: 1, isAlive: true, close() {}, send() { packets += 1; } });
  await channel.outboundScope.run(scope, async () => {
    channel.cancelPending();
    kvSet('qq_owner_id', '10000003');
    await assert.rejects(() => channel.sendToTarget({ type: 'private', userId: '10000002' }, '旧的私聊'), /取消旧任务/);
  });
  assert.equal(packets, 0);
});
