import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSettings } from '../src/config.js';
import { closeDb, getDb, addMessage, getActiveSession, kvGet, kvSet, kvSetJson } from '../src/db.js';
import { Scheduler } from '../src/scheduler.js';
import { evaluateBudget } from '../src/budget.js';
import { listIntentions, pickDueIntention } from '../src/intentions.js';

const now = new Date('2026-10-30T12:00:00+08:00').getTime();
function clear() { getDb().exec('DELETE FROM kv; DELETE FROM messages; DELETE FROM sessions;'); }
test.after(closeDb);

test('每日主动上限为 0 时不生成也不投递', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  clear();
  saveSettings({ proactive: { enabled: true, maxPerDay: 0, quietStart: '00:30', quietEnd: '08:30' } });
  const m = addMessage({ sessionId: getActiveSession().id, role: 'user', content: '我要去忙啦', channel: 'web' });
  const old = new Date(now - 3 * 3600000).toISOString();
  getDb().prepare('UPDATE messages SET created_at=? WHERE id=?').run(old, m.id);
  kvSet('next_proactive_at', old);
  kvSetJson('proactive_plan', { lastAt: old, targetAt: old });
  let calls = 0;
  const scheduler = new Scheduler({ llm: { chat: async () => { calls += 1; return { content: '测试主动消息' }; } }, companion: { saveProactiveMessage: () => ({ id: 1 }) } });
  assert.equal(await scheduler.maybeProactive(), null);
  assert.equal(calls, 0);
});

test('活跃时段内首次排程的发布时间仍在当天窗口', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  clear();
  saveSettings({ social: { xhsEnabled: true, xhsAutoPublish: true, xhsPublishPerDay: 1, activeStart: '09:30', activeEnd: '22:30' } });
  const scheduler = new Scheduler({ llm: {}, companion: {}, random: () => 0.5 });
  await scheduler.maybeXhsPublish();
  const target = new Date(kvGet('xhs_publish_target:2026-10-30'));
  assert.ok(target.getTime() >= now);
  assert.ok(target.getTime() < new Date('2026-10-30T22:30:00+08:00').getTime(), target.toISOString());
});

test('余额未知时本地日账单到顶仍然熔断', () => {
  const result = evaluateBudget({ balanceCny: null, todayCostCny: 3, settings: { cost: { maxDailyCostCny: 3 } } });
  assert.equal(result.level, 'stop');
  assert.ok(result.blocked.includes('proactive'));
});

test('明早到期的惦记跨过午夜不会被词面规则删掉', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T00:10:00+08:00').getTime() });
  clear();
  kvSetJson('open_intentions', [{ id: 'tomorrow', text: '明早问他近况', createdAt: '2026-10-30T22:00:00+08:00', dueAt: '2026-10-31T07:00:00+08:00', tries: 0 }]);
  assert.ok(listIntentions().some((item) => item.id === 'tomorrow'));
  assert.equal(pickDueIntention(), null);
});
