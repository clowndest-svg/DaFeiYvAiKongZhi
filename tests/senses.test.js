import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-senses-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
const settingsFile = path.join(dataDir, 'settings.json');
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_SETTINGS_FILE = settingsFile;
process.env.LLM_MOCK = '1';

fs.writeFileSync(settingsFile, JSON.stringify({ presence: { sensesEnabled: true } }), 'utf8');

const { addSense, listSenses, clearSenses, sensesPrompt, sensesStatus } = await import('../src/senses.js');
const { closeDb, getDb, kvGetJson } = await import('../src/db.js');

test('没在他原话里出现过的味道，一条都不许记', () => {
  const result = addSense({
    kind: 'taste',
    text: '他做的红烧肉有点咸',
    evidence: '红烧肉太咸了',
    sourceText: '今天开会开到好晚',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /证据/);
  assert.equal(listSenses({ limit: 10 }).length, 0, '被拒绝的不许进清单');
  const events = getDb().prepare("SELECT * FROM events WHERE type = 'sense_rejected' ORDER BY id DESC LIMIT 1").all();
  assert.equal(events.length, 1, '拒了要留下能查到的记录，不能静默');
});

test('他真说过的才记得住，还能带出口感和时间', () => {
  const result = addSense({
    kind: 'taste',
    text: '那块蛋糕是咸奶油的',
    detail: '绵密、微咸',
    evidence: '咸奶油的',
    sourceText: '我今天吃了块蛋糕，咸奶油的，绵密但微咸',
  });
  assert.equal(result.ok, true);
  const items = listSenses({ limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'taste');
  assert.equal(items[0].detail, '绵密、微咸');
  assert.match(sensesPrompt(items), /尝到：那块蛋糕是咸奶油的（绵密、微咸）/);
  assert.match(sensesPrompt(items), /清单里没有的味道、气味、画面就是没经历过/);
});

test('证据只有两个字以内不算证据', () => {
  assert.equal(addSense({ kind: 'smell', text: '咖啡味', evidence: '咖啡', sourceText: '咖啡' }).ok, false, '「咖啡」两字太容易蒙对，不算');
  assert.equal(addSense({ kind: 'smell', text: '现磨咖啡的味道', evidence: '现磨咖啡的味道', sourceText: '我买了点现磨咖啡的味道一般' }).ok, true);
});

test('不认识的感官种类直接拒，摄像头看到的画面不需要他亲口说过', () => {
  assert.equal(addSense({ kind: '第六感', text: '他要说分手', sourceText: '' }).ok, false);
  const seen = addSense({ kind: 'sight', text: '桌上有一杯凉掉的咖啡', source: 'camera' });
  assert.equal(seen.ok, true);
  assert.equal(listSenses({ kind: 'sight', limit: 5 }).length, 1);
});

test('同一条不会重复堆，清单最多 24 条，三十天前的自动忘掉', () => {
  clearSenses();
  for (let i = 0; i < 5; i += 1) {
    addSense({ kind: 'touch', text: '抱着的那只鲸鱼玩偶', evidence: '鲸鱼玩偶', sourceText: '我抱着鲸鱼玩偶睡的' });
  }
  assert.equal(listSenses({ limit: 30 }).length, 1, '同一句重复说不该变成五条');
  for (let i = 0; i < 30; i += 1) {
    addSense({ kind: 'sound', text: `外面的声音 ${i}`, evidence: '声音', sourceText: '外面有声音' });
  }
  assert.ok(listSenses({ limit: 40 }).length <= 24, '清单要有上限');
  const stored = kvGetJson('sensory_memory', []);
  stored[0].at = new Date(Date.now() - 40 * 86400000).toISOString();
  getDb().prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(stored), 'sensory_memory');
  const kept = listSenses({ limit: 40 });
  assert.ok(!kept.some((item) => item.id === stored[0].id), '超过三十天就不该还在');
});

test('感官记忆只进主人自己的提示词，群里和访客那边一个字都不给', async () => {
  clearSenses();
  addSense({ kind: 'taste', text: '他煮的酸汤面', detail: '有点酸', evidence: '酸汤面', sourceText: '我中午煮了酸汤面' });
  const { Companion } = await import('../src/chat.js');
  const { DeepSeek } = await import('../src/llm.js');
  const companion = new Companion({ llm: new DeepSeek() });
  const priv = companion.prepare({ text: '中午吃了点东西', channel: 'qq' });
  assert.ok(priv.block.senses?.length, '私聊要带得上');
  assert.match(priv.payload.system, /你的感官记忆/);
  assert.match(priv.payload.system, /他煮的酸汤面/);
  const group = companion.prepare({ text: '中午吃了点东西', channel: 'qq-group' });
  assert.ok(!group.payload.system.includes('他煮的酸汤面'), '群里不能漏出主人的私事');
  assert.ok(!group.payload.system.includes('你的感官记忆'));
});

test('没开开关时不注入这一段，界面也能看出是没开', async () => {
  fs.writeFileSync(settingsFile, JSON.stringify({ presence: { sensesEnabled: false } }), 'utf8');
  const status = sensesStatus();
  assert.equal(status.enabled, false);
  const { Companion } = await import('../src/chat.js');
  const { DeepSeek } = await import('../src/llm.js');
  const companion = new Companion({ llm: new DeepSeek() });
  const prep = companion.prepare({ text: '随便说点什么', channel: 'qq' });
  assert.equal(prep.block.senses, undefined, '关着就不该去读清单');
  assert.ok(!prep.payload.system.includes('你的感官记忆'));
});

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
