import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-forgetting-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
const settingsFile = path.join(dataDir, 'settings.json');
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_SETTINGS_FILE = settingsFile;
process.env.LLM_MOCK = '1';

function writePresence(presence) {
  fs.writeFileSync(settingsFile, JSON.stringify({ presence }), 'utf8');
}

writePresence({ forgettingCurve: false });

const { memoryHalfLifeDays, memoryStrength, memoryRemainingHalfDays, forgettingCurve } = await import('../src/forgetting.js');
const { addMemory, closeDb, getDb } = await import('../src/db.js');
const { loadSettings } = await import('../src/config.js');
const { getMemoryBlock } = await import('../src/memory.js');

const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

test('名义半衰期恰好减半，老记忆曲线从当前强度开始', () => {
  const now=Date.now();
  const memory={importance:3,use_count:0,updated_at:new Date(now).toISOString()};
  assert.ok(Math.abs(memoryStrength(memory,now+memoryHalfLifeDays({importance:3})*DAY)/memoryStrength(memory,now)-0.5)<1e-9);
  const old={...memory,updated_at:ago(30)};
  assert.ok(Math.abs(forgettingCurve(old)[0].strength-memoryStrength(old))<0.001);
});

test('越重要、越常被想起，半衰期越长（这是“越记越牢”的全部依据）', () => {
  assert.ok(memoryHalfLifeDays({ importance: 5, useCount: 0 }) > memoryHalfLifeDays({ importance: 1, useCount: 0 }));
  assert.ok(memoryHalfLifeDays({ importance: 3, useCount: 8 }) > memoryHalfLifeDays({ importance: 3, useCount: 0 }));
  assert.ok(memoryHalfLifeDays({ importance: 3, useCount: 9999 }) === memoryHalfLifeDays({ importance: 3, useCount: 8 }), '召回次数要封顶，不能无限拉长');
  assert.equal(memoryHalfLifeDays({}), memoryHalfLifeDays({ importance: 3, useCount: 0 }), '缺字段要落到中间值而不是 0');
});

test('强度随时间单调下降，且任何脏数据都不产 NaN', () => {
  const memory = { importance: 4, use_count: 1, updated_at: ago(0) };
  const at = (days) => memoryStrength({ ...memory, updated_at: ago(days) }, Date.now());
  assert.ok(at(0) > at(20) && at(20) > at(80), '越久越淡');
  assert.ok(at(0) > at(100000), '放到一百天也不能翻上来');
  for (const bad of [{}, { importance: 'x', use_count: null, updated_at: '不是时间' }, { importance: -9, use_count: -1 }]) {
    const value = memoryStrength(bad, Date.now());
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1.5, `脏数据要给个能用的数：${value}`);
  }
});

test('剩余半衰期天数不会变成负数', () => {
  assert.ok(memoryRemainingHalfDays({ importance: 1, use_count: 0, updated_at: ago(9999) }, Date.now()) === 0);
  assert.ok(memoryRemainingHalfDays({ importance: 5, use_count: 0, updated_at: ago(0) }, Date.now()) > 0);
});

test('曲线是单调下降的一串点，起点就是现在的强度', () => {
  const points = forgettingCurve({ importance: 3, use_count: 0 }, { days: 90, points: 10 });
  assert.equal(points.length, 10);
  assert.equal(points[0].ageDays, 0);
  assert.equal(points[points.length - 1].ageDays, 90);
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(points[i].strength <= points[i - 1].strength, '往后不许变强');
  }
});

test('关掉遗忘曲线时，检索排序和以前逐条一致（不许悄悄改口径）', () => {
  writePresence({ forgettingCurve: false });
  getDb().prepare('DELETE FROM memories').run();
  // 两条对「咖啡」的相关度完全一样（同样的字数、同样的命中），只差重要度和新旧。
  const stale = addMemory({ layer: 'mid', content: '他爱喝美式咖啡', importance: 5, tags: [], sourceSession: null });
  const fresh = addMemory({ layer: 'mid', content: '他爱喝拿铁咖啡', importance: 1, tags: [], sourceSession: null });
  assert.notEqual(stale.id, fresh.id, '两条得真的是两条，不能被相似合并吃掉');
  getDb().prepare('UPDATE memories SET updated_at = ?, created_at = ? WHERE id = ?').run(ago(200), ago(200), stale.id);
  getDb().prepare('UPDATE memories SET updated_at = ?, created_at = ? WHERE id = ?').run(ago(1), ago(1), fresh.id);
  const block = getMemoryBlock({ query: '咖啡', settings: loadSettings(), recordUsage: false });
  assert.deepEqual(block.mid.map((m) => m.id), [stale.id, fresh.id], '关着的时候还是老口径：重要度高的排前面');
});

test('打开遗忘曲线后，两百天没想起过的事会被新近的事压下去', () => {
  writePresence({ forgettingCurve: true });
  const stale = getDb().prepare("SELECT id FROM memories WHERE content LIKE '%美式%'").get().id;
  const fresh = getDb().prepare("SELECT id FROM memories WHERE content LIKE '%拿铁%'").get().id;
  const block = getMemoryBlock({ query: '咖啡', settings: loadSettings(), recordUsage: false });
  const ids = block.mid.map((m) => m.id);
  assert.deepEqual(ids, [fresh, stale], '开起来以后，淡掉的那条要往后排');
});

test('被想起来会真的变牢：只改召回次数，旧事就能重新排回第一位', () => {
  writePresence({ forgettingCurve: true });
  const stale = getDb().prepare("SELECT * FROM memories WHERE content LIKE '%美式%'").get();
  const fresh = getDb().prepare("SELECT id FROM memories WHERE content LIKE '%拿铁%'").get().id;
  assert.deepEqual(
    getMemoryBlock({ query: '咖啡', settings: loadSettings(), recordUsage: false }).mid.map((m) => m.id),
    [fresh, stale.id],
    '先确认此刻是新的排在前面',
  );
  const weak = memoryStrength(stale, Date.now());
  assert.ok(memoryStrength({ ...stale, use_count: 40 }, Date.now()) > weak, '召回多了强度要涨');
  getDb().prepare('UPDATE memories SET use_count = ? WHERE id = ?').run(40, stale.id);
  assert.deepEqual(
    getMemoryBlock({ query: '咖啡', settings: loadSettings(), recordUsage: false }).mid.map((m) => m.id),
    [stale.id, fresh],
    '被反复想起的旧事要能重新排回第一位',
  );
});

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
