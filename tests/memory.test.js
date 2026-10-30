import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(process.cwd(), 'data', `test-memory-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;

const db = await import('../src/db.js');
const memory = await import('../src/memory.js');
const mood = await import('../src/mood.js');

db.initDb(path.join(dataDir, 'test.db'));

const fakeLlm = {
  async chat(messages, opts = {}) {
    const usage = { prompt: 10, completion: 10, hit: 0, miss: 10, reasoning: 0, total: 20 };
    if (opts.kind === 'compact') return { content: '他最近很累，约定十一点前睡。', usage, costCny: 0, model: 'fake' };
    if (opts.kind === 'handover') return { content: '给未来的我：记得提醒他早睡，别让他空着肚子。', usage, costCny: 0, model: 'fake' };
    if (opts.kind === 'weekly') return { content: '这周我们聊了很多，我也更懂他一点了。', usage, costCny: 0, model: 'fake' };
    return { content: '好呀。', usage, costCny: 0, model: 'fake' };
  },
};

test('相似记忆会合并，不会越记越多', () => {
  const first = db.addMemory({ layer: 'mid', content: '他喜欢吃草莓蛋糕', importance: 3 });
  const second = db.addMemory({ layer: 'mid', content: '他喜欢吃草莓', importance: 4 });
  assert.equal(first.id, second.id);
  const all = db.listMemories({ layer: 'mid', limit: 50 });
  assert.equal(all.length, 1);
  assert.match(all[0].content, /蛋糕/);
  assert.equal(all[0].importance, 4);
});

test('数字不同的记忆不会被错误合并', () => {
  const a = db.addMemory({ layer: 'core', content: '他生日是 3 月 14 日', importance: 5 });
  const b = db.addMemory({ layer: 'core', content: '他生日是 3 月 15 日', importance: 5 });
  assert.notEqual(a.id, b.id);
  const cores = db.listMemories({ layer: 'core', limit: 50 });
  assert.ok(cores.some((item) => item.content.includes('14')));
});

test('肯定和否定不会因为相似就被合并', () => {
  const a = db.addMemory({ layer: 'core', content: '他喜欢猫' });
  const b = db.addMemory({ layer: 'core', content: '他不喜欢猫' });
  assert.notEqual(a.id, b.id);
});

test('心情会被单轮变化限制住，不会一句话就暴涨', () => {
  const before = mood.getMood();
  const after = mood.applyMood({ valence: 1, energy: 1, affection_delta: 2, reason: '测试' });
  assert.ok(after.valence > before.valence);
  assert.ok(after.valence < 1);
  assert.ok(after.affection >= before.affection + 2);
  assert.ok(after.label.length > 0);
});

test('上下文压缩会保留最近消息，并落一段摘要', async () => {
  const session = db.createSession('压缩测试');
  for (let i = 0; i < 14; i += 1) {
    db.addMessage({
      sessionId: session.id,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第 ${i} 条消息，内容有点长，用来把 token 堆上去。`,
      tokens: 20,
    });
  }
  const result = await memory.compactIfNeeded({
    llm: fakeLlm,
    sessionId: session.id,
    settings: { memory: { compactTokens: 100, shortTurns: 6, handoverTokens: 100000 } },
    force: true,
  });
  assert.ok(result);
  assert.ok(result.count >= 2);
  const left = db.getUncompactedMessages(session.id);
  assert.ok(left.length <= 8, `left=${left.length}`);
  assert.match(db.kvGet(`session_summary:${session.id}`), /十一点/);
});

test('压缩阈值按真实上下文 token 判断，而不是按累计输出', async () => {
  const session = db.createSession('上下文阈值测试');
  for (let i = 0; i < 14; i += 1) {
    db.addMessage({
      sessionId: session.id,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `上下文测试第 ${i} 条`,
      tokens: 10,
      contextTokens: i === 13 ? 30000 : 0,
    });
  }
  const result = await memory.compactIfNeeded({
    llm: fakeLlm,
    sessionId: session.id,
    settings: { memory: { compactTokens: 24000, shortTurns: 6 } },
    force: false,
  });
  assert.ok(result, '真实上下文超过阈值时应该触发压缩');
  assert.match(db.kvGet(`session_summary:${session.id}`), /十一点/);
});

test('交接信会归档旧会话、开新会话，并把信写进文件', async () => {
  const old = db.getActiveSession();
  const letter = await memory.handoverIfNeeded({
    llm: fakeLlm,
    sessionId: old.id,
    settings: { memory: { compactTokens: 100, handoverTokens: 100, shortTurns: 6 } },
    force: true,
  });
  assert.ok(letter);
  assert.match(letter.letter, /给未来的我/);
  assert.ok(fs.existsSync(letter.file));
  const current = db.getActiveSession();
  assert.notEqual(current.id, old.id);
  assert.equal(db.kvGet('latest_handover').includes('早睡'), true);
  assert.ok(memory.listLetters().some((item) => item.kind === '交接信'));
});

test('周记会写入长期记忆与文件', async () => {
  const session = db.getActiveSession();
  for (let i = 0; i < 8; i += 1) {
    db.addMessage({
      sessionId: session.id,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `周记素材 ${i}`,
      tokens: 10,
    });
  }
  const result = await memory.weeklyDiary({
    llm: fakeLlm,
    settings: { companion: { name: '小知' } },
    force: true,
  });
  assert.ok(result);
  assert.ok(fs.existsSync(result.file));
  assert.ok(memory.listLetters().some((item) => item.kind === '周记'));
  const longMemories = db.listMemories({ layer: 'long', limit: 20 });
  assert.ok(longMemories.some((item) => item.tags.includes('周记')));
});

test('记忆检索会把相关回忆挑出来', () => {
  db.addMemory({ layer: 'mid', content: '他生日是 3 月 14 日，不吃香菜', importance: 5 });
  const block = memory.getMemoryBlock({
    query: '我生日你还记得吗',
    settings: { memory: { retrieveBudgetTokens: 1000, retrieveCount: 5 } },
  });
  assert.ok(block.mid.some((item) => item.content.includes('3 月 14 日')));
});

test.after(() => {
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
