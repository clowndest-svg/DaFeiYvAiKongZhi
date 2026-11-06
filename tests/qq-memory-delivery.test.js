import test from 'node:test';
import assert from 'node:assert/strict';
import { Companion } from '../src/chat.js';
import { updateMessageMeta, getMessage, closeDb } from '../src/db.js';
import { saveSettings } from '../src/config.js';
test.after(closeDb);

test('QQ 生成回复不等于送达：确认前不反思或压缩，确认后只触发一次', async () => {
  saveSettings({ social: { xhsEnabled: false }, presence: { neuroEnabled: false } });
  const companion = new Companion({ llm: { configured: true, chat: async () => ({ content: '我在这里。', model: 'mock', usage: { prompt: 10, completion: 6 }, costCny: 0 }) } });
  let reflections = 0;
  companion.afterTurn = () => { reflections += 1; };
  const result = await companion.reply({ text: '你好', channel: 'qq', deferAfterTurn: true, deliveryMeta: { qqReceiptKeys: ['inbound-1'], qqDelivery: 'pending' } });
  assert.equal(reflections, 0);
  assert.equal(getMessage(result.message.id).meta.qqDelivery, 'pending');
  assert.equal(result.prep.userMessage.meta.qqDelivery, undefined);
  companion.completeDeferredTurn(result);
  assert.equal(reflections, 0);
  updateMessageMeta(result.message.id, { qqDelivery: 'sent' });
  companion.completeDeferredTurn(result); companion.completeDeferredTurn(result);
  assert.equal(reflections, 1);
});
