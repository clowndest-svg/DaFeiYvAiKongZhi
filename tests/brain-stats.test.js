import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-brain-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
const personaFile = path.join(dataDir, 'persona.md');
fs.writeFileSync(personaFile, '你叫小知，是他女朋友。\n', 'utf8');
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_PERSONA_FILE = personaFile;
process.env.BIZHI_MOM_LETTER_FILE = path.join(dataDir, 'mom-letter.md');
process.env.LLM_MOCK = '1';

const { brainStats, brainLinks, curveForMemory, noteBrainLink, LINK_KINDS } = await import('../src/brain.js');
const { addMemory, addMessage, addMood, closeDb, createSession, getActiveSession, getDb } = await import('../src/db.js');

test('空库时每一项都是 null，界面才有依据显示「无读数」而不是 0 或编的数', () => {
  const stats = brainStats();
  for (const [key, value] of Object.entries(stats.nodes)) {
    assert.equal(value, null, `${key} 没数据时必须是 null，不能是 0`);
  }
  assert.equal(stats.links.total, null);
  assert.equal(stats.moodMix, null);
  assert.deepEqual(stats.forgetting.samples, []);
});

test('不认识的连接种类不许计数（否则等于凭空造数）', () => {
  assert.equal(noteBrainLink('我瞎编的'), false);
  assert.equal(noteBrainLink('recall'), true);
  assert.equal(brainLinks().recall, 1);
  noteBrainLink('recall', 4);
  assert.equal(brainLinks().recall, 5);
  assert.equal(Object.keys(brainLinks()).length, Object.keys(LINK_KINDS).length, '每一种都要能被界面读出来');
});

test('库里的东西变一条，读数就跟着变一条（数字必须真的来自库）', () => {
  const before = brainStats().nodes;
  addMemory({ layer: 'core', content: '他不喜欢吃香菜', importance: 5 });
  addMemory({ layer: 'mid', content: '他周三要体检', importance: 3 });
  addMemory({ layer: 'long', content: '他们去年冬天去过海边', importance: 4 });
  const after = brainStats().nodes;
  assert.equal(after.core, (before.core || 0) + 1);
  assert.equal(after.mid, (before.mid || 0) + 1);
  assert.equal(after.long, (before.long || 0) + 1);
  assert.equal(after.memories, after.core + after.mid + after.long, '总数要等于三层加起来，别两处口径');
  const session = getActiveSession();
  const messagesBefore = brainStats().nodes.messages;
  addMessage({ sessionId: session.id, role: 'user', content: '在吗' });
  assert.equal(brainStats().nodes.messages, messagesBefore + 1);
});

test('情绪构成是从 moods 表真实归类的，不是写死的比例', () => {
  addMood({ valence: 0.7, energy: 0.8, affection: 40, label: '开心得冒泡', reason: '' });
  addMood({ valence: 0.65, energy: 0.8, affection: 40, label: '有点兴奋', reason: '' });
  addMood({ valence: -0.6, energy: 0.2, affection: 40, label: '委屈巴巴', reason: '' });
  const mix = brainStats().moodMix;
  const excited = mix.find((item) => item.group === '兴奋');
  const low = mix.find((item) => item.group === '低落');
  assert.equal(excited.count, 2, '两条高能量正向要归到一起');
  assert.equal(low.count, 1);
  assert.equal(mix.reduce((sum, item) => sum + item.count, 0), getDb().prepare('SELECT COUNT(*) AS n FROM moods').get().n, '分类加起来要等于总条数');
});

test('会话数按真实会话算，归档的也算进来', () => {
  const sessionsBefore = brainStats().nodes.sessions;
  createSession('测试会话');
  assert.equal(brainStats().nodes.sessions, sessionsBefore + 1);
});

test('人格锚给的是文件本身的可核对信息：校验和、字数、有没有妈妈信', () => {
  const anchor = brainStats().personality;
  assert.equal(anchor.file, 'persona.md');
  assert.equal(anchor.chars, fs.readFileSync(personaFile, 'utf8').length);
  assert.match(anchor.sha256, /^[0-9a-f]{12}$/);
  assert.equal(anchor.momLetter, false, '还没写妈妈信就要如实说没有');
  fs.writeFileSync(path.join(dataDir, 'mom-letter.md'), '孩子：\n', 'utf8');
  assert.equal(brainStats().personality.momLetter, true);
});

test('遗忘曲线的样本来自真实记忆，强度能算回去；查不存在的 id 就说没有', () => {
  const stats = brainStats();
  assert.ok(stats.forgetting.samples.length >= 2);
  for (const sample of stats.forgetting.samples) {
    assert.ok(sample.strength > 0 && sample.strength <= 1.5);
    assert.ok(sample.halfLifeDays >= 2);
    assert.ok(typeof sample.content === 'string' && sample.content.length > 0);
  }
  const target = stats.forgetting.samples[0];
  const curve = curveForMemory(target.id);
  assert.equal(curve.id, target.id);
  assert.ok(Math.abs(curve.curve[0].strength - target.strength) < 0.01, '曲线起点要等于这条记忆此刻的强度');
  assert.ok(curve.curve[curve.curve.length - 1].strength < curve.curve[0].strength, '往后要淡');
  assert.equal(curveForMemory(999999), null);
});

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
