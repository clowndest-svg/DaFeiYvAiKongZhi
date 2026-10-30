import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-dream-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.LLM_MOCK = '1';
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    proactive: { enabled: true, dreamEnabled: true, dreamHour: 0, idleMinutesMin: 25, idleMinutesMax: 40, maxPerDay: 5, maxUnanswered: 2 },
    social: { enabled: false },
    qq: { enabled: false },
  }),
  'utf8',
);
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { DeepSeek } = await import('../src/llm.js');
const { Companion } = await import('../src/chat.js');
const { Scheduler } = await import('../src/scheduler.js');
const { addMessage, getActiveSession, kvGet, kvGetJson, kvSet, kvSetJson, listEvents, closeDb } = await import('../src/db.js');
const { listIntentions } = await import('../src/intentions.js');

const llm = new DeepSeek();
const companion = new Companion({ llm });
const scheduler = new Scheduler({ llm, companion });

test('睡前她会一个人想一遍，并留下明天想说的话', async () => {
  addMessage({ sessionId: getActiveSession().id, role: 'user', content: '你今天怎么这么乖', channel: 'web' });
  const result = await scheduler.maybeDream();
  assert.ok(result && result.dream, '要写出那段心里话');
  assert.ok(result.opener, '要留一句明天的开头');
  const stored = kvGetJson('last_dream', null);
  assert.ok(stored && stored.used === false);
  assert.match(stored.dream, /记很久/);
  const intentions = listIntentions({ limit: 5 });
  assert.ok(intentions.some((i) => i.source === 'dream'), '睡前想到的事要进惦记清单');
});

test('同一天不重复想；想过的开头会被下一次主动消息用掉', async () => {
  assert.equal(await scheduler.maybeDream(), null, '一天只做一次');
  const before = kvGetJson('last_dream', null);
  assert.equal(before.used, false);
  await scheduler.triggerProactive({ reason: 'manual', unanswered: 0 });
  const after = kvGetJson('last_dream', null);
  assert.equal(after.used, true, '用过的开头不能反复用');
});

test('今天写的日记真的会进睡前反思（不是查一个不存在的标签）', async () => {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  kvSet(`dream_done:${today}`, '');
  kvSet(`dream_fail:${today}`, '0');
  kvSetJson('daily_digests', [{ date: today, digest: '今天他把耳机落在我这儿了', name: 'd.md', createdAt: new Date().toISOString() }]);
  const seen = [];
  const real = llm.chat.bind(llm);
  llm.chat = async (messages, opts) => {
    if (opts && opts.kind === 'dream') seen.push(messages);
    return real(messages, opts);
  };
  const result = await scheduler.runDream();
  llm.chat = real;

  assert.ok(result && result.dream, JSON.stringify(result));
  assert.equal(seen.length, 1, '应该只调一次 dream');
  const prompt = seen[0].find((m) => m.role === 'user').content;
  assert.match(prompt, /今天他把耳机落在我这儿了/);
  assert.ok(kvGet(`dream_done:${today}`), '写成了才钉"今天已做"');
});

test('模型挂了不装成功：留失败事件，也不把今天钉死', async () => {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  kvSet(`dream_done:${today}`, '');
  kvSet(`dream_fail:${today}`, '0');
  kvSet(`dream_fail_at:${today}`, '');
  const real = llm.chat.bind(llm);
  llm.chat = async () => {
    throw new Error('模拟里模型挂了');
  };
  const result = await scheduler.runDream();
  llm.chat = real;

  assert.equal(result.dream, undefined, JSON.stringify(result));
  assert.match(result.skipped, /没写成/);
  assert.equal(kvGet(`dream_done:${today}`), '', '失败不能把今天钉死');
  assert.equal(kvGet(`dream_fail:${today}`), '1', '失败要计数');
  assert.ok(listEvents(10).some((e) => e.type === 'dream_failed'), '失败要落事件');
});

test('连续失败两次今天就放弃，不再烧钱', async () => {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  kvSet(`dream_done:${today}`, '');
  kvSet(`dream_fail:${today}`, '2');
  const real = llm.chat.bind(llm);
  let called = 0;
  llm.chat = async (messages, opts) => {
    called += 1;
    return real(messages, opts);
  };
  const result = await scheduler.runDream();
  llm.chat = real;
  assert.equal(called, 0, '已经失败两次就不该再调模型');
  assert.match(result.skipped, /明天再说/);
});

test('关掉开关她就不做睡前反思', async () => {
  fs.writeFileSync(settingsFile, JSON.stringify({ proactive: { dreamEnabled: false, dreamHour: 0 } }), 'utf8');
  assert.equal(await scheduler.maybeDream(), null);
});

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
