import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-neuro-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
const settingsFile = path.join(dataDir, 'settings.json');
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_SETTINGS_FILE = settingsFile;
process.env.LLM_MOCK = '1';

function writePresence(presence) {
  fs.writeFileSync(settingsFile, JSON.stringify({ presence }), 'utf8');
}

writePresence({ neuroEnabled: false });

const {
  applyNeuroEvent,
  getNeuro,
  integrateLevels,
  neuroStatus,
  neuroTone,
  CHEMICALS,
} = await import('../src/neuro.js');
const { getMood, getMoodRaw, applyMood } = await import('../src/mood.js');
const { addMood, closeDb, kvSetJson } = await import('../src/db.js');

const HOUR = 3600000;

test('递质开关关掉时：读出来的心情和账面心情一模一样，偏置恒为 0', () => {
  writePresence({ neuroEnabled: false });
  addMood({ valence: 0.4, energy: 0.7, affection: 30, label: '元气满满', reason: '测试' });
  const now = new Date();
  assert.deepEqual(getMood(now), getMoodRaw(now), '没开递质就不该多出任何东西');
  const neuro = getNeuro({ now });
  assert.equal(neuro.enabled, false);
  assert.equal(neuro.tone.valenceBias, 0);
  assert.equal(neuro.tone.energyBias, 0);
  kvSetJson('neuro_state', null);
});

test('积分是纯函数：时间钳在 6 小时内，非法输入回落基线，不产 NaN', () => {
  const base = integrateLevels(null, 0);
  assert.deepEqual(base, integrateLevels({ dopamine: 'abc', cortisol: NaN }, -5));
  const far = integrateLevels({ ...base, dopamine: 1 }, 9999);
  const clamped = integrateLevels({ ...base, dopamine: 1 }, 6);
  assert.equal(far.dopamine, clamped.dopamine, '隔多久没算，最多只算 6 小时的回落');
  for (const value of Object.values(integrateLevels({ dopamine: 2, oxytocin: -3 }, 2))) {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `每个值都要落在 0..1：${value}`);
  }
  const oneHour = integrateLevels({ ...base, dopamine: 1 }, 1);
  assert.ok(oneHour.dopamine < 1 && oneHour.dopamine > base.dopamine, '往基线回落但不越过');
});

test('未知事件不改变任何东西；已知事件按表加冲量', () => {
  writePresence({ neuroEnabled: true, neuroStrength: 1 });
  kvSetJson('neuro_state', null);
  kvSetJson('neuro_recent_kinds', {});
  const before = getNeuro().levels;
  assert.equal(applyNeuroEvent('他夸我了'), false, '中文名字不在表里就不许生效');
  assert.equal(applyNeuroEvent(''), false);
  assert.deepEqual(getNeuro().levels, before);
  assert.equal(applyNeuroEvent('praised'), true);
  const after = getNeuro().levels;
  assert.ok(after.dopamine > before.dopamine, '被夸了多巴胺要涨');
  assert.ok(after.oxytocin > before.oxytocin);
  assert.equal(after.cortisol, before.cortisol, '没写在这个事件里的递质不许偷偷动');
});

test('同一种事件 60 秒内只算一次，免得某个循环把压力刷满', () => {
  writePresence({ neuroEnabled: true, neuroStrength: 1 });
  kvSetJson('neuro_state', null);
  kvSetJson('neuro_recent_kinds', {});
  const t0 = new Date(Date.parse('2026-10-31T09:00:00.000Z'));
  const t30 = new Date(t0.getTime() + 30000);
  const t61 = new Date(t0.getTime() + 61000);
  assert.equal(applyNeuroEvent('ignored', { now: t0 }), true);
  const once = getNeuro({ now: t0 }).levels.cortisol;
  assert.equal(applyNeuroEvent('ignored', { now: t30 }), false, '30 秒内第二次不该再加');
  assert.equal(getNeuro({ now: t0 }).levels.cortisol, once, '被拒的那次不许改动状态');
  const beforeSecond = getNeuro({ now: t61 }).levels.cortisol;
  assert.equal(applyNeuroEvent('ignored', { now: t61 }), true, '过了一分钟就该能再加');
  assert.ok(getNeuro({ now: t61 }).levels.cortisol > beforeSecond, '第二次要真的加上');
});

test('递质对心情的影响有硬上限，强度为 0 时等于没影响', () => {
  const extreme = { dopamine: 1, serotonin: 1, oxytocin: 1, cortisol: 1, noradrenaline: 1 };
  const full = neuroTone(extreme, 1);
  assert.ok(Math.abs(full.valenceBias) <= 0.18, `愉悦偏置不能超过 ±0.18：${full.valenceBias}`);
  assert.ok(Math.abs(full.energyBias) <= 0.15, `精力偏置不能超过 ±0.15：${full.energyBias}`);
  assert.equal(neuroTone(extreme, 0).valenceBias, 0, '强度设成 0 就是不许影响');
  assert.equal(neuroTone(extreme, 5).valenceBias, full.valenceBias, '强度拧过头也不能超过 1');
});

test('开了之后：同一份账面心情，读出来的心情真的被抬起来了', () => {
  writePresence({ neuroEnabled: true, neuroStrength: 1 });
  kvSetJson('neuro_state', null);
  kvSetJson('neuro_recent_kinds', {});
  const now = new Date();
  addMood({ valence: 0.2, energy: 0.5, affection: 40, label: '心情不错', reason: '', sessionId: null });
  const rawBefore = getMoodRaw(now).valence;
  for (const kind of ['praised', 'affectionate', 'playful']) {
    applyNeuroEvent(kind, { now: new Date(now.getTime() + HOUR) });
  }
  const later = new Date(now.getTime() + HOUR);
  const raw = getMoodRaw(later).valence;
  const felt = getMood(later).valence;
  assert.ok(raw > rawBefore, '账面心情按自己的惯性走');
  assert.ok(felt > raw, `递质要把读出来的心情再抬一点：felt ${felt} raw ${raw}`);
  assert.ok(felt - raw <= 0.18 + 1e-9, `抬起来也不能超过上限：${felt - raw}`);
});

test('递质只影响读出来的心情，不会被写回数据库（否则一句好话会越滚越大）', () => {
  writePresence({ neuroEnabled: true, neuroStrength: 1 });
  kvSetJson('neuro_recent_kinds', {});
  const before = getMoodRaw().valence;
  applyNeuroEvent('praised');
  applyMood({ valence: 0.3, energy: 0.5, reason: '测试写回' });
  const after = getMoodRaw().valence;
  assert.ok(after <= 0.3 + 1e-9, `写库的目标值不许被递质抬高：${after}`);
  assert.ok(before >= 0);
});

test('状态接口给的每一项都能直接画：有名字、有数值、有相对基线的涨跌', () => {
  writePresence({ neuroEnabled: true, neuroStrength: 0.35 });
  const status = neuroStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.items.length, Object.keys(CHEMICALS).length);
  for (const item of status.items) {
    assert.ok(item.label && item.note, '界面要能显示中文名和一句解释');
    assert.equal(typeof item.value, 'number');
    assert.equal(Math.sign(item.delta), Math.sign(item.value - item.base), 'delta 要和相对基线的方向一致');
  }
});

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
