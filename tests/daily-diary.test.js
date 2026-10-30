import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(process.cwd(), 'data', `test-daily-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;

const db = await import('../src/db.js');
const memory = await import('../src/memory.js');
db.initDb(path.join(dataDir, 'test.db'));

const fakeLlm = {
  async chat() {
    return {
      content: JSON.stringify({ diary: '今天他说想看我写的日记，我嘴上没答应，心里其实有点高兴。', digest: '他问起日记，我有点高兴。' }),
      usage: { prompt: 100, completion: 50, hit: 0, miss: 100, reasoning: 0, total: 150 },
      costCny: 0,
      model: 'fake',
    };
  },
};

const settings = { companion: { name: '小知' }, memory: { retrieveBudgetTokens: 2200, retrieveCount: 10 } };

test('每日日记写文件、存摘要、不塞进长期记忆', async () => {
  const session = db.getActiveSession();
  for (let i = 0; i < 6; i += 1) {
    db.addMessage({
      sessionId: session.id,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `今天的测试消息 ${i}`,
      tokens: 10,
    });
  }
  const result = await memory.dailyDiary({ llm: fakeLlm, settings, force: true });
  assert.ok(result);
  assert.ok(fs.existsSync(result.file));
  assert.equal(path.basename(path.dirname(result.file)), 'daily');
  assert.match(fs.readFileSync(result.file, 'utf8'), /日记 ·/);
  assert.equal(memory.listDailyDigests().length, 1);
  assert.ok(memory.listLetters().some((item) => item.kind === '日记' && item.folder === 'daily'));
  assert.equal(db.listMemories({ layer: 'long', limit: 20 }).length, 0);
  const matches = memory.findDiaryMatches('今天的日记');
  assert.ok(matches.length >= 1);
  assert.match(matches[0].digest, /高兴/);
});

test('日记取当天最后 400 条，不丢傍晚对话', async () => {
  const target = '2026-10-20';
  const start = new Date(`${target}T00:00:00+08:00`).getTime();
  const session = db.createSession('长日测试');
  const insert = db.getDb().prepare(
    'INSERT INTO messages (session_id, role, content, channel, meta, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 450; i += 1) {
    insert.run(
      session.id,
      i % 2 === 0 ? 'user' : 'assistant',
      `素材 ${i}`,
      'web',
      '{}',
      1,
      new Date(start + i * 60000).toISOString(),
    );
  }
  let prompt = '';
  const captureLlm = {
    async chat(messages) {
      prompt = messages.map((m) => String(m.content || '')).join('\n');
      return {
        content: JSON.stringify({ diary: '长日测试日记', digest: '长日测试摘要' }),
        usage: { prompt: 100, completion: 50, hit: 0, miss: 100, reasoning: 0, total: 150 },
        costCny: 0,
        model: 'fake',
      };
    },
  };
  const result = await memory.dailyDiary({ llm: captureLlm, settings, date: target, force: true });
  assert.ok(result);
  assert.match(prompt, /素材 449/);
});

test('同一天不会重复自动写', async () => {
  const again = await memory.dailyDiary({ llm: fakeLlm, settings, force: false });
  assert.equal(again, null);
});

test.after(() => {
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
