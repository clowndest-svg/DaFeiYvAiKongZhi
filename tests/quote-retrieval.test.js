import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', `test-quote-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_NO_BACKUP = '1';
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ qq: { enabled: false }, social: { enabled: false } }), 'utf8');
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { addMessage, createSession, findQuotedLines, getActiveSession, closeDb, setActiveSession } = await import('../src/db.js');
const { findQuotesForQuery } = await import('../src/memory.js');
const { buildSystemPrompt } = await import('../src/prompt.js');
const { loadSettings } = await import('../src/config.js');
const { getMood } = await import('../src/mood.js');

const SPOKEN = '我想吃番茄炒蛋但是不要放糖你记住';
const session = getActiveSession();

function seed(content, { role = 'user', sessionId = session.id, channel = 'web' } = {}) {
  return addMessage({ sessionId, role, content, channel });
}

// 目标那句要落在最近 10 条用户消息之外（那部分是当下这轮对话，本来就在上下文里）
seed(SPOKEN);
seed(SPOKEN.replace('番茄炒蛋', '番茄炒蛋蛋蛋'), { role: 'assistant' });
for (let i = 0; i < 12; i += 1) seed(`第 ${i} 句闲话，跟番茄没关系`);
seed('[表情][表情][表情]');
seed('[语音] （他发了一条语音，但我这边没听出内容）');

test('他能被逐字翻出来：命中那句原话，字面不许变', () => {
  const hits = findQuotedLines('我上次说番茄炒蛋不要放什么来着', { skipRecent: 0 });
  assert.ok(hits.length >= 1, '应该翻到那句原话');
  assert.equal(hits[0].text, SPOKEN, '返回的必须是原话本身，不是摘要');
  assert.ok(hits.every((h) => h.createdAt), '每条要带时间，她能说“你哪天说的”');
});

test('她自己也说过相似的话，不能把她那句当成他的原话', () => {
  const hits = findQuotedLines('我上次说番茄炒蛋不要放什么来着', { skipRecent: 0 });
  assert.ok(hits.length >= 1, '先确认这轮真有命中，不然这条判据是空的');
  for (const h of hits) assert.equal(h.text.includes('蛋蛋'), false, `助手的话混进来了：${h.text}`);
});

test('占位消息不算原话：纯表情/纯语音的条目要过滤掉', () => {
  const hits = findQuotedLines('我上次说番茄炒蛋不要放什么来着', { skipRecent: 0 });
  for (const h of hits) {
    assert.equal(/^\s*(\[[^\]]{1,6}\]\s*)+$/.test(h.text), false, `这种条目不该进来：${h.text}`);
    assert.ok(!h.text.startsWith('[语音] （'), `识别占位不该当成原话：${h.text}`);
  }
});

test('没说过的事不许被“找出来”：无关问题返回空', () => {
  const hits = findQuotedLines('我上次说明天要去火星穿什么衣服来着', { skipRecent: 0 });
  assert.deepEqual(hits, [], '没说过就不该硬凑一条');
});

test('只在“问旧事”时才挂原话：闲聊不占这份 token', () => {
  assert.deepEqual(findQuotesForQuery('哈哈哈哈'), [], '不是回忆类问题就别检索');
  assert.deepEqual(findQuotesForQuery('今天上班好累'), [], '同上');
  const block = findQuotesForQuery('你还记得我说过番茄炒蛋不要放什么吗');
  assert.ok(block.length >= 1, '回忆类问题要带回原话');
  assert.equal(block[0].text, SPOKEN);
});

test('只沾上一个词的不算“他说过的话”：必须两处以上对得上', () => {
  seed('最近买的番茄挺甜的');
  const hits = findQuotedLines('番茄多少钱', { skipRecent: 0 });
  assert.deepEqual(hits, [], '只重合「番茄」一个词，不能当成原话递给她');
});

test('跨会话也能翻到（她说“你以前说过”不该只在当前 session 里找）', () => {
  const other = createSession('另一个会话');
  setActiveSession(other.id);
  addMessage({ sessionId: other.id, role: 'user', content: '我说过周五要早点接你下班', channel: 'qq' });
  for (let i = 0; i < 12; i += 1) addMessage({ sessionId: other.id, role: 'user', content: `填充 ${i}`, channel: 'qq' });
  const hits = findQuotedLines('我上次说周五要干嘛来着', { skipRecent: 0 });
  assert.ok(hits.some((h) => h.text === '我说过周五要早点接你下班'), '别的会话里说过的话也要能引');
  setActiveSession(session.id);
});

test('原话进了系统提示词，并且明说照抄不许改', () => {
  const settings = loadSettings();
  const quotes = findQuotesForQuery('我上次说番茄炒蛋不要放什么来着');
  const mood = getMood();
  const prompt = buildSystemPrompt({
    settings,
    mood,
    block: {
      core: [],
      long: [],
      mid: [],
      summary: '',
      handover: '',
      innerThoughts: [],
      intentions: [],
      dailyRecent: [],
      diaryMatches: [],
      quotes,
    },
  });
  assert.match(prompt, /他说过的原话（照抄/);
  assert.match(prompt, /上面才是他亲口说过的话/);
  assert.ok(prompt.includes(SPOKEN), '提示词里必须有那句原话');
  assert.match(prompt, /上面没有出现过的，就别当他说过/);
});

test('没检索到原话时不许凭空出现这一段', () => {
  const settings = loadSettings();
  const prompt = buildSystemPrompt({
    settings,
    mood: getMood(),
    block: {
      core: [],
      long: [],
      mid: [],
      summary: '',
      handover: '',
      innerThoughts: [],
      intentions: [],
      dailyRecent: [],
      diaryMatches: [],
      quotes: [],
    },
  });
  assert.equal(prompt.includes('他说过的原话（照抄'), false, '空的时候整段标题都不该出现');
  assert.equal(prompt.includes('上面才是他亲口说过的话'), false, '空的时候不许留这段指令');
});

test.after(() => {
  try {
    closeDb();
  } catch {
    // 没开库
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
