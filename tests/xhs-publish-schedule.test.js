// 发笔记这条路的排期判据。三天没发出去的真因都在这里：一次失败废一整天、随机时间点跑到第二天。
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, kvGet, kvSet } from '../src/db.js';
import { saveSettings } from '../src/config.js';
import { pickMomentInWindow, shanghaiDayKey } from '../src/util.js';
import { Scheduler } from '../src/scheduler.js';

test.after(closeDb);

function windowCoveringNow() {
  const now = new Date();
  const shift = (hours) => {
    const d = new Date(now.getTime() + hours * 3600000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return { start: shift(-2), end: shift(2) };
}

function enablePublish(overrides = {}) {
  const { start, end } = windowCoveringNow();
  saveSettings({
    social: {
      xhsEnabled: true,
      xhsAutoPublish: true,
      xhsPublishPerDay: 1,
      xhsAutoBrowse: false,
      xhsAutoReply: false,
      xhsAutoLike: false,
      xhsAutoCollect: false,
      xhsDmReply: false,
      xhsDmAutoOwner: false,
      xhsDmAutoReply: false,
      activeStart: start,
      activeEnd: end,
      ...overrides,
    },
  });
}

const day = shanghaiDayKey();

// 同一份隔离库里多条用例排队跑，上一条留下的 kv 会把下一条闸门挡死——每条都先清干净。
function resetPublishKeys() {
  kvSet(`xhs_publish_target:${day}`, '');
  kvSet(`xhs_publish_attempt:${day}`, '');
  kvSet(`xhs_publish_last_try:${day}`, '');
  kvSet(`xhs_publish_decided:${day}`, '');
  kvSet(`xhs_publish_day:${day}`, '');
  kvSet('xhs_last_publish_at', '');
  kvSet('xhs_cooldown_until', '');
}

test('时间点只会落在当天剩下的窗口里，不会跑到第二天（10-30 那天就是这么废的）', () => {
  const cases = [
    { now: new Date('2026-11-01T02:00:00Z'), start: '09:30', end: '22:30' },   // 上海 10:00
    { now: new Date('2026-11-01T06:30:00Z'), start: '09:30', end: '22:30' },   // 上海 14:30
    { now: new Date('2026-11-01T13:55:00Z'), start: '09:30', end: '22:30' },   // 上海 21:55
    { now: new Date('2026-11-01T15:50:00Z'), start: '23:00', end: '00:30' },   // 上海 23:50，窗口跨午夜
  ];
  for (const randomValue of [0, 0.5, 0.999]) {
    for (const c of cases) {
      const at = pickMomentInWindow({ now: c.now, activeStart: c.start, activeEnd: c.end, random: () => randomValue });
      if (!at) continue;
      assert.equal(shanghaiDayKey(new Date(at)), shanghaiDayKey(c.now), `跨天了：${c.now.toISOString()} + 窗口 ${c.start}-${c.end} → ${at}`);
      assert.ok(new Date(at).getTime() > c.now.getTime(), '时间点不能在过去');
    }
  }
});

test('窗口只剩两三分钟或还没开门时，如实说没空间，别硬挤出一个过去的时间', () => {
  assert.equal(pickMomentInWindow({ now: new Date('2026-11-01T14:28:00Z'), activeStart: '09:30', activeEnd: '22:30', random: () => 0.5 }), null, '22:28 只剩 2 分钟，不该排');
  assert.equal(pickMomentInWindow({ now: new Date('2026-11-01T01:00:00Z'), activeStart: '09:30', activeEnd: '22:30', random: () => 0.5 }), null, '窗口没开门不该排');
  const edge = pickMomentInWindow({ now: new Date('2026-11-01T14:20:00Z'), activeStart: '09:30', activeEnd: '22:30', random: () => 0 });
  assert.equal(edge, new Date(new Date('2026-11-01T14:20:00Z').getTime() + 60000).toISOString(), 'random=0 时应当是 1 分钟后');
});

test('她今天还没决定时，时间点没到就不问模型、不写尝试次数', async () => {
  resetPublishKeys();
  enablePublish();
  kvSet(`xhs_publish_target:${day}`, new Date(Date.now() + 3600000).toISOString());
  let asked = 0;
  const scheduler = new Scheduler({ llm: { chat: async () => { asked += 1; return { content: '{}' }; } }, companion: {}, random: () => 0.5 });
  await assert.doesNotReject(scheduler.maybeXhsPublish());
  assert.equal(asked, 0, '时间点还没到就问了她想不想发');
  assert.equal(Number(kvGet(`xhs_publish_attempt:${day}`, '0') || 0), 0, '还没动手就把尝试次数写上了');
});

test('她说今天不想发 → 记成当天决定，不再每小时问一遍', async () => {
  resetPublishKeys();
  enablePublish();
  kvSet(`xhs_publish_target:${day}`, new Date(Date.now() - 60000).toISOString());
  kvSet(`xhs_publish_last_try:${day}`, '0');
  let asked = 0;
  const scheduler = new Scheduler({
    llm: { chat: async () => { asked += 1; return { content: JSON.stringify({ want: false, reason: '今天没什么想说的' }) }; } },
    companion: {},
    random: () => 0.5,
  });
  const first = await scheduler.maybeXhsPublish();
  assert.equal(first?.skipped, true);
  assert.equal(asked, 1);
  assert.ok(kvGet(`xhs_publish_decided:${day}`), '没记下"今天决定过了"');
  await scheduler.maybeXhsPublish();
  assert.equal(asked, 1, '她已经说不发了，还被反复问');
});

test('失败当天允许再试（最多三次、间隔半小时）——旧版一次失败就废一整天', async () => {
  resetPublishKeys();
  enablePublish();
  kvSet(`xhs_publish_target:${day}`, new Date(Date.now() - 60000).toISOString());
  // 内容写得过关，但表情库里没有能当封面的图 → 走到"跳过"分支，不动浏览器
  const llm = { chat: async () => ({ content: JSON.stringify({ want: true, reason: '想说一句', title: '今天的风', content: '今天风很大，我把窗帘吹得啪啪响，就当去过了海边。', tags: ['天气'] }) }) };
  const scheduler = new Scheduler({ llm, companion: {}, random: () => 0.5 });

  const attempts = () => Number(kvGet(`xhs_publish_attempt:${day}`, '0') || 0);
  // 隔离测试禁止接管真浏览器，走到浏览器那步必然抛——"抛"正是这里的失败场景
  const runOnce = async () => {
    try {
      await scheduler.maybeXhsPublish();
    } catch {
      /* 失败是预期的 */
    }
  };

  await runOnce();
  assert.equal(attempts(), 1, '第一次尝试没记上');

  // 半小时内不重试
  await runOnce();
  assert.equal(attempts(), 1, '间隔没到就重试了');

  // 间隔过了 → 可以再试第二次（旧版在这里直接 return，整天不再试）
  kvSet(`xhs_publish_last_try:${day}`, String(Date.now() - 31 * 60000));
  await runOnce();
  assert.equal(attempts(), 2, '失败后当天没能再试');

  // 第三次之后收手，别刷账号
  kvSet(`xhs_publish_attempt:${day}`, '3');
  kvSet(`xhs_publish_last_try:${day}`, '0');
  const before = kvGet(`xhs_publish_attempt:${day}`);
  await assert.doesNotReject(scheduler.maybeXhsPublish());
  assert.equal(kvGet(`xhs_publish_attempt:${day}`), before, '试过三次还在试第四次');
});

test('旧版本留下的 ISO 时间串不能被当成数字：那会让"最多三次"永远不成立', async () => {
  resetPublishKeys();
  enablePublish();
  kvSet(`xhs_publish_target:${day}`, new Date(Date.now() - 60000).toISOString());
  kvSet(`xhs_publish_attempt:${day}`, '2026-10-31T03:39:24.739Z');  // 旧写法
  kvSet(`xhs_publish_last_try:${day}`, '0');
  const scheduler = new Scheduler({ llm: { chat: async () => ({ content: JSON.stringify({ want: false, reason: '不想发' }) }) }, companion: {}, random: () => 0.5 });
  await scheduler.maybeXhsPublish();
  const now = Number(kvGet(`xhs_publish_attempt:${day}`, '0') || 0);
  assert.ok(Number.isFinite(now) && now >= 1, `计数器还是脏的：${kvGet(`xhs_publish_attempt:${day}`)}`);
});

test('窗口关了就不排时间，也不写"今天没空间"这种结论', async () => {
  resetPublishKeys();
  enablePublish({ activeStart: '09:30', activeEnd: '09:31' });
  const scheduler = new Scheduler({ llm: { chat: async () => ({ content: '{}' }) }, companion: {}, random: () => 0.5 });
  await assert.doesNotReject(scheduler.maybeXhsPublish());
  assert.equal(kvGet(`xhs_publish_target:${day}`) || '', '', '窗口外还给她排了时间');
});
