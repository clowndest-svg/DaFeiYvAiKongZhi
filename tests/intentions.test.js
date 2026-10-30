import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-intentions-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.LLM_MOCK = '1';

const { addIntention, listIntentions, pickDueIntention, completeIntention, bumpIntention } = await import('../src/intentions.js');
const { getDb, closeDb } = await import('../src/db.js');

test('她记下的事会去重、能取出来、也能销账', () => {
  const first = addIntention({ text: '想问他周五体检结果', reason: '他说过要查', dueInHours: 0 });
  assert.ok(first && first.id);
  assert.equal(addIntention({ text: '想问他周五体检结果' }), null, '同一件事不重复记');
  assert.equal(listIntentions({ limit: 5 }).length, 1);
  const due = pickDueIntention();
  assert.equal(due.text, '想问他周五体检结果');
  bumpIntention(due.id);
  bumpIntention(due.id);
  assert.equal(pickDueIntention(), null, '提过两次就不再惦记');
  assert.equal(completeIntention(due.id), true);
  assert.equal(listIntentions({ limit: 5 }).length, 0);
});

test('惦记的事会进她的提示词，群聊和陌生人看不到', async () => {
  addIntention({ text: '想让他少熬夜', reason: '他昨天两点才睡', dueInHours: 0 });
  const { Companion } = await import('../src/chat.js');
  const { DeepSeek } = await import('../src/llm.js');
  const companion = new Companion({ llm: new DeepSeek() });
  const priv = companion.prepare({ text: '在吗', channel: 'qq' });
  assert.match(priv.payload.system, /你还惦记的事/);
  assert.match(priv.payload.system, /想让他少熬夜/);
  assert.match(priv.payload.system, /一次最多提一件/);
  const group = companion.prepare({ text: '在吗', channel: 'qq-group' });
  assert.ok(!group.payload.system.includes('想让他少熬夜'), '群里不能漏出她跟主人的私事');
});

test('过期四天的惦记会自动忘掉', () => {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get('open_intentions');
  const list = JSON.parse(row.value);
  list[0].createdAt = new Date(Date.now() - 5 * 86400000).toISOString();
  getDb().prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(list), 'open_intentions');
  assert.equal(listIntentions({ limit: 5 }).length, 0);
});

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
