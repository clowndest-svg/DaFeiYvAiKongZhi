import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-proactive-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.LLM_MOCK = '1';

const shHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date()));
const pad = (n) => String(((n % 24) + 24) % 24).padStart(2, '0');
const quietStart = pad(shHour + 3) + ':00';
const quietEnd = pad(shHour + 4) + ':00';
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    proactive: {
      enabled: true,
      idleMinutesMin: 25,
      idleMinutesMax: 120,
      quietStart,
      quietEnd,
      maxPerDay: 5,
      maxUnanswered: 2,
    },
    social: { enabled: false },
    qq: { enabled: false },
  }),
  'utf8',
);
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { DeepSeek } = await import('../src/llm.js');
const { Companion } = await import('../src/chat.js');
const { Scheduler } = await import('../src/scheduler.js');
const { addMessage, getActiveSession, getDb, kvSet, kvSetJson, listEvents, closeDb } = await import('../src/db.js');

const llm = new DeepSeek();
const companion = new Companion({ llm });
const scheduler = new Scheduler({ llm, companion });

function ageLastUserMessage(minutes) {
  const at = new Date(Date.now() - minutes * 60000).toISOString();
  const row = getDb().prepare('SELECT id FROM messages WHERE role = ? ORDER BY id DESC LIMIT 1').get('user');
  getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(at, row.id);
  return at;
}

function userMessage(text) {
  return addMessage({ sessionId: getActiveSession().id, role: 'user', content: text, channel: 'web' });
}

function assistantCount() {
  return Number(getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND json_extract(meta, '$.proactive') = 1").get().n);
}

test('刚说过话时她不会立刻追，而是先抽一个“想起你”的时间点', async () => {
  userMessage('刚聊完');
  kvSet('next_proactive_at', new Date(Date.now() - 1000).toISOString());
  const result = await scheduler.maybeProactive();
  assert.equal(result, null, '还没到她想的点，不该发');
  const stored = await import('../src/db.js').then((m) => m.kvGetJson('proactive_plan', null));
  assert.ok(stored && stored.targetAt, '应该记下她打算什么时候主动找你');
  const waitMinutes = (new Date(stored.targetAt).getTime() - Date.now()) / 60000;
  assert.ok(waitMinutes >= 24 && waitMinutes <= 121, '等待点要落在 25–120 分钟之间，实际 ' + waitMinutes.toFixed(1));
  assert.equal(assistantCount(), 0);
});

test('到点了她会自己发一条，并记下“他没回”的账', async () => {
  userMessage('我去忙会儿');
  const at = ageLastUserMessage(200);
  kvSetJson('proactive_plan', { lastAt: at, targetAt: new Date(Date.now() - 1000).toISOString(), waitMinutes: 30 });
  kvSet('next_proactive_at', new Date(Date.now() - 2000).toISOString());
  const result = await scheduler.maybeProactive();
  assert.ok(result && result.text, '到点应该主动发一条：' + JSON.stringify(result));
  assert.equal(assistantCount(), 1);
  const db = await import('../src/db.js');
  assert.equal(db.kvGet('proactive_unanswered'), '1');
  assert.ok(db.kvGet('proactive_last_sent_at'), '要记下上一条主动消息的时间');
  const nextAt = new Date(db.kvGet('next_proactive_at')).getTime();
  const leadMinutes = (nextAt - Date.now()) / 60000;
  assert.ok(leadMinutes > 0 && leadMinutes <= 125, '下一次检查要落在分钟级窗口里，实际 ' + leadMinutes.toFixed(1));
});

test('连着两次没回，她就先不打扰了', async () => {
  const db = await import('../src/db.js');
  // 他还是没说话：只推进“到点时间”，不动他最后一条消息
  const fireAgain = () => {
    const anchor = scheduler.proactiveAnchor();
    kvSetJson('proactive_plan', { lastAt: anchor, targetAt: new Date(Date.now() - 1000).toISOString(), waitMinutes: 30 });
    kvSet('next_proactive_at', new Date(Date.now() - 2000).toISOString());
  };
  fireAgain();
  const second = await scheduler.maybeProactive();
  assert.ok(second && second.text, '第二次还可以发');
  assert.equal(db.kvGet('proactive_unanswered'), '2');

  fireAgain();
  const third = await scheduler.maybeProactive();
  assert.equal(third, null, '连着两次没回之后不该再发');
  assert.equal(assistantCount(), 2);
  const events = listEvents(20);
  assert.ok(events.some((e) => e.type === 'proactive_pause'), '要留下“先不打扰”的事件');
});

test('他一回话，之前的账就清掉，她又能主动找他', async () => {
  const db = await import('../src/db.js');
  userMessage('刚才是我不好，忽略你了');
  const anchor = scheduler.proactiveAnchor();
  kvSetJson('proactive_plan', { lastAt: anchor, targetAt: new Date(Date.now() - 1000).toISOString(), waitMinutes: 30 });
  kvSet('next_proactive_at', new Date(Date.now() - 2000).toISOString());
  const result = await scheduler.maybeProactive();
  assert.ok(result && result.text, '他回过话之后应该又能主动发');
  assert.equal(db.kvGet('proactive_unanswered'), '1', '计数要重新从这次开始');
});

process.on('exit', () => {
  try { closeDb(); } catch { /* ignore */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
