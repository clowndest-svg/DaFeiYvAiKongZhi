import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { conversationQueue } from './serial.js';
import { costBlocked } from './budget.js';
import {
  addEvent,
  addMemory,
  archiveSession,
  createSession,
  findQuotedLines,
  getActiveSession,
  getDb,
  getRecentMessages,
  getSession,
  getUncompactedMessages,
  kvGet,
  kvGetJson,
  kvSet,
  kvSetJson,
  lastAssistantContextTokens,
  listMemories,
  markMessagesCompacted,
  searchableMidMemories,
  setActiveSession,
  touchMemories,
} from './db.js';
import { logger } from './logger.js';
import { noteBrainLink } from './brain.js';
import { memoryStrength } from './forgetting.js';
import { getMood } from './mood.js';
import {
  buildCompactionPrompt,
  buildDailyPrompt,
  buildHandoverPrompt,
  buildWeeklyPrompt,
} from './prompt.js';
import {
  estimateTokens,
  formatLocal,
  keywordSet,
  nowIso,
  overlapScore,
  stripMarkdownLite,
  truncate,
} from './util.js';

function localDateString(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
}

/** 他在问旧事时，把她能翻到的原话逐字带回去——她记不准的就是这里记错的那句。 */
export function findQuotesForQuery(query, options = {}) {
  const q = String(query || '');
  if (!/(上次|之前|说过|说过的|提过|来着|记得|还记得|什么时候|哪天|是不是|有没有|答应|承诺|原话|几次|第[一二三四五六七八九十0-9]+次)/.test(q)) {
    return [];
  }
  return findQuotedLines(q, { limit: 5, days: 120, skipRecent: 0, ...options });
}

export function getMemoryBlock({ query = '', settings, recordUsage = true, sessionId = null, excludeQuoteIds = [] }) {
  const core = listMemories({ layer: 'core', limit: 40 });
  const long = listMemories({ layer: 'long', limit: 8 });
  const midAll = searchableMidMemories(800);
  const qset = keywordSet(query);
  const now = Date.now();
  const decayOn = Boolean(settings?.presence?.forgettingCurve);

  const scored = midAll
    .map((memory) => {
      const ageDays = Math.max(0, (now - new Date(memory.updated_at).getTime()) / 86400000);
      const recency = Math.exp(-ageDays / 45);
      const relevance = overlapScore(qset, `${memory.content} ${(memory.tags || []).join(' ')}`);
      const score =
        relevance * 1.8 + (memory.importance / 5) * 0.9 + recency * 0.45 + Math.min(0.2, (memory.use_count || 0) * 0.01);
      return { memory, score: decayOn ? score * (0.55 + 0.45 * Math.min(1, memoryStrength(memory, now))) : score };
    })
    .sort((a, b) => b.score - a.score);

  const picked = [];
  let budget = Number(settings.memory.retrieveBudgetTokens || 2200);
  for (const { memory, score } of scored) {
    if (picked.length >= Number(settings.memory.retrieveCount || 10)) break;
    if (score < 0.22 && picked.length >= 3) break;
    if ((memory.tags || []).includes('会话摘要')) continue;
    const cost = estimateTokens(memory.content) + 8;
    if (cost > budget) continue;
    picked.push(memory);
    budget -= cost;
  }
  if (recordUsage) touchMemories(picked.map((m) => m.id));
  if (recordUsage && picked.length) noteBrainLink('recall', picked.length);

  const session = sessionId ? getSession(sessionId) : getActiveSession();
  const summary = kvGet(`session_summary:${session.id}`) || '';
  const handoverAt = kvGet('latest_handover_at');
  const handoverFresh = !handoverAt || Date.now() - new Date(handoverAt).getTime() < 14 * 86400000;
  const handover = handoverFresh ? kvGet('latest_handover') || '' : '';
  const recent = getRecentMessages(session.id, 12);
  const innerThoughts = recent
    .filter((m) => m.role === 'assistant' && m.meta?.innerThought)
    .slice(-3)
    .map((m) => m.meta.innerThought);
  const dailyRecent = kvGetJson('daily_digests', []).slice(-3);
  const diaryMatches = findDiaryMatches(query);
  const quotes = findQuotesForQuery(query, { excludeIds: excludeQuoteIds });
  if (recordUsage && quotes.length) noteBrainLink('quote', quotes.length);

  return { core, long, mid: picked, summary, handover, innerThoughts, session, dailyRecent, diaryMatches, quotes };
}

export function listDailyDigests() {
  return kvGetJson('daily_digests', []);
}

export function findDiaryMatches(query) {
  const q = String(query || '');
  if (!/日记|昨天|前天|上周|那天|\d{1,2}[月\-/]\d{1,2}/.test(q)) return [];
  const list = kvGetJson('daily_digests', []);
  if (!list.length) return [];

  const targetDates = new Set();
  const daysAgo = (n) => localDateString(new Date(Date.now() - n * 86400000));
  if (/昨天/.test(q)) targetDates.add(daysAgo(1));
  if (/前天/.test(q)) targetDates.add(daysAgo(2));
  if (/上周/.test(q)) {
    for (let i = 7; i <= 13; i += 1) targetDates.add(daysAgo(i));
  }
  const dateMatch = q.match(/(\d{1,2})[月\-/](\d{1,2})/);
  if (dateMatch) {
    const year = new Date().getFullYear();
    targetDates.add(`${year}-${String(dateMatch[1]).padStart(2, '0')}-${String(dateMatch[2]).padStart(2, '0')}`);
  }

  const qset = keywordSet(q);
  const scored = list
    .map((item) => {
      let score = 0;
      if (targetDates.has(item.date)) score += 10;
      score += overlapScore(qset, item.digest) * 2;
      if (!targetDates.size && /日记/.test(q)) score += 0.12;
      return { item, score };
    })
    .filter((entry) => entry.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  return scored.map(({ item }) => {
    let excerpt = item.digest;
    try {
      const content = readLetter(item.name);
      excerpt = content.replace(/^#.*\r?\n+/, '').slice(0, 700);
    } catch {
      // ignore
    }
    return { date: item.date, digest: item.digest, excerpt };
  });
}

function formatTranscript(messages, maxEach = 500, maxChars = 5000) {
  let picked = [];
  let length = 0;
  for (const message of [...messages].reverse()) {
    const cost = Math.min(maxEach, String(message.content || "").length) + 8;
    if (length + cost > maxChars) break;
    picked.unshift(message); length += cost;
  }
  return picked
    .map((m) => {
      const who = m.role === 'user' ? '他' : '小知';
      return `${who}：${truncate(m.content || '（图片）', maxEach)}`;
    })
    .join('\n');
}

export async function compactIfNeeded({ llm, sessionId, settings, force = false, locked = false }) {
  if (costBlocked('compact')) return null;
  const all = getUncompactedMessages(sessionId);
  const storedTokens = all.reduce((sum, m) => sum + Number(m.tokens || 0), 0);
  const totalTokens = Math.max(lastAssistantContextTokens(sessionId), storedTokens + 3000);
  if (!force && totalTokens < Number(settings.memory.compactTokens || 24000)) return null;

  const keepCount = Math.max(8, Number(settings.memory.shortTurns || 24));
  if (all.length <= keepCount) return null;
  const older = all.slice(0, all.length - keepCount);
  // 只提交本批实际覆盖的内容；超长单条用持久化偏移续传，绝不截断后标整条完成。
  const covered = [];
  const segments = [];
  let budget = 5000;
  for (const message of older) {
    const content = String(message.content || '（图片）');
    const key = `compact_offset:${sessionId}:${message.id}`;
    const start = Math.max(0, Math.min(content.length, Number(kvGet(key, '0')) || 0));
    const size = Math.min(content.length - start, budget - 80);
    if (size <= 0) break;
    const end = start + size;
    segments.push({ id: message.id, key, start, end, complete: end === content.length });
    covered.push(`[消息 ${message.id}，字符 ${start}-${end}] ${message.role === 'user' ? '他' : '小知'}：${content.slice(start, end)}`);
    budget -= size + 80;
    if (end < content.length) break;
  }
  if (!segments.length) return null;

  const prev = kvGet(`session_summary:${sessionId}`) || '';
  const transcript = covered.join('\n');
  const result = await llm.chat(
    [
      { role: 'system', content: '你负责把对话压缩成可供长期记忆使用的摘要，只输出摘要正文。' },
      {
        role: 'user',
        content:
          (prev ? `【之前已经压缩过的摘要】\n${prev}\n\n` : '') +
          buildCompactionPrompt(transcript, settings.companion?.name || '小知'),
      },
    ],
    {
      kind: 'compact',
      sessionId,
      temperature: 0.3,
      maxTokens: 900,
      reasoningEffort: 'low',
      mockKind: 'plain',
    },
  );

  const summary = stripMarkdownLite(result.content).slice(0, 1600);
  if (!summary) return null;
  const db = getDb();
  db.exec('BEGIN');
  try {
    // LLM计算期间不占主人对话锁；提交时检查快照，过期结果不能覆盖新摘要。
    const unchanged = (kvGet(`session_summary:${sessionId}`) || '') === prev
      && getSession(sessionId)?.status === 'active'
      && segments.every(part => {
        const row = db.prepare('SELECT content, compacted FROM messages WHERE id = ? AND session_id = ?').get(part.id, sessionId);
        return row && !row.compacted && row.content === older.find(message => message.id === part.id)?.content
          && (Number(kvGet(part.key, '0')) || 0) === part.start;
      });
    if (!unchanged) { db.exec('ROLLBACK'); return null; }
    markMessagesCompacted(segments.filter((part) => part.complete).map((part) => part.id));
    for (const part of segments) kvSet(part.key, String(part.end));
    kvSet(`compact_coverage:${sessionId}:${segments[0].id}:${segments[0].start}`, JSON.stringify(segments));
    kvSet(`session_summary:${sessionId}`, summary);
    addMemory({
      layer: 'mid',
      content: summary,
      importance: 4,
      tags: ['会话摘要'],
      reasoning: '上下文压缩时保留的一段记忆',
      sourceSession: sessionId,
    });
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  }
  const count = segments.filter((part) => part.complete).length;
  addEvent('compact', `本批压缩 ${segments.length} 段内容，完成 ${count} 条消息`, { sessionId, coverage: segments });
  logger.info('会话压缩完成', { sessionId, messages: count, summaryLength: summary.length });
  return { summary, count, pending: older.length - count };
}

export function exportSessionMarkdown(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;
  const rows = getDb().prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC').all(sessionId);
  const lines = [
    `# 会话记录：${session.title || sessionId}`,
    '',
    `- 会话 ID：${session.id}`,
    `- 开始：${session.created_at}`,
    `- 归档：${session.archived_at || '未归档'}`,
    `- 累计 tokens：${session.token_used}`,
    '',
    '---',
    '',
  ];
  for (const row of rows) {
    const who = row.role === 'user' ? '他' : row.role === 'assistant' ? '小知' : row.role;
    lines.push(`### ${who} · ${new Date(row.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    lines.push('');
    lines.push(row.content || '（空）');
    let meta = {};
    try {
      meta = JSON.parse(row.meta || '{}');
    } catch {
      meta = {};
    }
    if (meta.innerThought) {
      lines.push('');
      lines.push(`> 她的心里话：${meta.innerThought}`);
    }
    lines.push('');
  }
  const file = path.join(paths.archives, `${sessionId}.md`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function writeLetterFile(prefix, text, dateOverride = null) {
  const date = dateOverride || localDateString();
  const dir = prefix === 'DAILY' ? paths.daily : prefix === 'WEEKLY' ? paths.weekly : paths.letters;
  let file = path.join(dir, `${prefix}-${date}.md`);
  if (fs.existsSync(file)) {
    const time = new Date()
      .toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
      .replace(/[^\d]/g, '');
    file = path.join(dir, `${prefix}-${date}-${time || Date.now().toString().slice(-4)}.md`);
  }
  const title = prefix === 'WEEKLY' ? '周记' : prefix === 'DAILY' ? '日记' : '给未来自己的信';
  const body = `# ${title} · ${date}\n\n${text}\n`;
  fs.writeFileSync(file, body, 'utf8');
  return { file, name: path.basename(file), dir };
}

export async function dailyDiary({ llm, settings, force = false, date = null, locked = false }) {
  const previousDaily = kvGet('last_daily_at');
  if (costBlocked('daily')) return null;
  const targetDate = date || localDateString();
  const start = new Date(`${targetDate}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 86400000);
  const rows = getDb()
    .prepare(
      `SELECT * FROM messages
       WHERE created_at >= ? AND created_at < ? AND role IN ('user','assistant')
         AND channel NOT IN ('qq-group','qq-guest')
       ORDER BY id DESC LIMIT 400`,
    )
    .all(start.toISOString(), end.toISOString())
    .reverse();
  if (rows.length < 4) return null;

  const digests = kvGetJson('daily_digests', []);
  if (!force && digests.some((item) => item.date === targetDate)) return null;

  const transcript = formatTranscript(rows.slice(-80), 300);
  const mood = getMood();
  const block = getMemoryBlock({ query: `今天的日记 ${targetDate}`, settings });
  const result = await llm.chat(
    [
      { role: 'system', content: '你正在写一篇日记，只输出严格 JSON。' },
      {
        role: 'user',
        content: buildDailyPrompt({ settings, mood, block, transcript, date: targetDate }),
      },
    ],
    {
      kind: 'daily',
      sessionId: getActiveSession().id,
      temperature: 0.85,
      maxTokens: 900,
      reasoningEffort: 'low',
      responseFormat: { type: 'json_object' },
      mockKind: 'daily',
    },
  );

  let diary = '';
  let digest = '';
  try {
    const data = JSON.parse(result.content);
    diary = stripMarkdownLite(String(data.diary || '')).slice(0, 2400);
    digest = String(data.digest || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    diary = stripMarkdownLite(result.content).slice(0, 2400);
  }
  if (!diary) return null;
  if (kvGet('last_daily_at') !== previousDaily) return null;
  if (!digest) digest = diary.replace(/\s+/g, ' ').slice(0, 120);

  const file = writeLetterFile('DAILY', diary, targetDate);
  let list = kvGetJson('daily_digests', []).filter((item) => item.date !== targetDate);
  list.push({ date: targetDate, digest, name: file.name, createdAt: nowIso() });
  list = list.sort((a, b) => a.date.localeCompare(b.date)).slice(-120);
  kvSetJson('daily_digests', list);
  kvSet('last_daily_at', nowIso());
  addEvent('daily', `写了 ${targetDate} 的日记`, { file: file.name, digest });
  logger.info('日记生成完成', { date: targetDate, file: file.name, messages: rows.length });
  return { diary, digest, file: file.file, name: file.name, date: targetDate, count: rows.length };
}

export async function handoverIfNeeded({ llm, sessionId, settings, force = false, locked = false }) {
  if (costBlocked('handover')) return null;
  const session = getSession(sessionId);
  if (!session || session.status !== 'active') return null;
  const all = getUncompactedMessages(sessionId);
  const storedTokens = all.reduce((sum, m) => sum + Number(m.tokens || 0), 0);
  const contextTokens = Math.max(lastAssistantContextTokens(sessionId), storedTokens + 3000);
  const ageDays = (Date.now() - new Date(session.created_at).getTime()) / 86400000;
  const sessionHandover = kvGet(`last_handover_at:${sessionId}`);
  const lastHandover = sessionHandover;
  const recentlyHandedOver = lastHandover && Date.now() - new Date(lastHandover).getTime() < 5 * 86400000;
  if (!force && all.length < 8) return null;
  const due =
    force ||
    contextTokens >= Number(settings.memory.handoverTokens || 48000) ||
    (!recentlyHandedOver && ageDays >= 7 && all.length >= 40);
  if (!due) return null;

  const summary = kvGet(`session_summary:${sessionId}`) || '';
  const snapshotLastId = getDb().prepare('SELECT MAX(id) id FROM messages WHERE session_id = ?').get(sessionId).id;
  const core = listMemories({ layer: 'core', limit: 40 });
  const weeklies = listMemories({ layer: 'long', limit: 5 });
  const recent = formatTranscript(all.slice(-24), 400);
  const result = await llm.chat(
    [
      { role: 'system', content: '你正在写一封给未来自己的交接信，只输出信的正文。' },
      {
        role: 'user',
        content: buildHandoverPrompt({ settings, summary, recent, weeklies, core }),
      },
    ],
    {
      kind: 'handover',
      sessionId,
      temperature: 0.85,
      maxTokens: 1600,
      reasoningEffort: 'low',
      mockKind: 'plain',
    },
  );
  const letter = stripMarkdownLite(result.content).slice(0, 2600);
  if (!letter) return null;

  return conversationQueue.run('owner', () => {
  // 写信时允许继续对话；若期间出现新消息或新摘要，放弃旧结果，绝不把新对话归档掉。
  if (getSession(sessionId)?.status !== 'active'
    || getDb().prepare('SELECT MAX(id) id FROM messages WHERE session_id = ?').get(sessionId).id !== snapshotLastId
    || (kvGet(`session_summary:${sessionId}`) || '') !== summary) return null;
  exportSessionMarkdown(sessionId);
  const file = writeLetterFile('LETTER', letter);
  const db = getDb();
  db.exec('BEGIN');
  try {
  addMemory({
    layer: 'long',
    content: letter,
    importance: 5,
    tags: ['交接信'],
    reasoning: '上下文交接时写给未来自己的信',
    sourceSession: sessionId,
  });
  archiveSession(sessionId, letter);
  const next = createSession(`${localDateString()} 起的新一页`);
  setActiveSession(next.id);
  kvSet('latest_handover', letter);
  kvSet('latest_handover_at', nowIso());
  kvSet('last_handover_at', nowIso());
  kvSet(`last_handover_at:${sessionId}`, nowIso());
  db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const next = getActiveSession();
  addEvent('handover', '她给未来的自己写了一封信，并开启了新会话', { sessionId, next: next.id, file: file.name });
  logger.info('完成会话交接', { sessionId, next: next.id, letter: file.name });
  return { letter, file: file.file, name: file.name, nextSession: next, archived: sessionId };
  });
}

export async function weeklyDiary({ llm, settings, force = false, locked = false }) {
  if (costBlocked('weekly')) return null;
  const last = kvGet('last_weekly_at');
  if (!force && last && Date.now() - new Date(last).getTime() < 6 * 86400000) return null;
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = getDb()
    .prepare(
      "SELECT * FROM messages WHERE created_at >= ? AND role IN ('user','assistant') AND channel NOT IN ('qq-group','qq-guest') ORDER BY id DESC LIMIT 500",
    )
    .all(since)
    .reverse();
  if (rows.length < 6) return null;

  const transcript = formatTranscript(rows, 260);
  const memories = listMemories({ layer: 'mid', limit: 40 });
  const sinceDate = localDateString(new Date(Date.now() - 7 * 86400000));
  const dailyDigests = kvGetJson('daily_digests', []).filter((item) => item.date >= sinceDate).slice(-7);
  const useDaily = dailyDigests.length >= 3;
  const result = await llm.chat(
    [
      { role: 'system', content: '你正在写一篇周记，只输出周记正文。' },
      {
        role: 'user',
        content: buildWeeklyPrompt({
          settings,
          transcript: useDaily ? '' : transcript,
          memories,
          dailyDigests: useDaily ? dailyDigests : [],
        }),
      },
    ],
    {
      kind: 'weekly',
      sessionId: getActiveSession().id,
      temperature: 0.9,
      maxTokens: 1200,
      reasoningEffort: 'low',
      mockKind: 'plain',
    },
  );
  const diary = stripMarkdownLite(result.content).slice(0, 2200);
  if (!diary) return null;
  if (kvGet('last_weekly_at') !== last) return null;
  const file = writeLetterFile('WEEKLY', diary);
  addMemory({
    layer: 'long',
    content: diary,
    importance: 5,
    tags: ['周记'],
    reasoning: '一周的共同记忆',
    sourceSession: getActiveSession().id,
  });
  kvSet('last_weekly_at', nowIso());
  addEvent('weekly', '小知写了一篇周记', { file: file.name });
  logger.info('周记生成完成', { file: file.name });
  return { diary, file: file.file, name: file.name };
}

export function listLetters() {
  const folders = [
    { dir: paths.daily, kind: '日记', folder: 'daily' },
    { dir: paths.weekly, kind: '周记', folder: 'weekly' },
    { dir: paths.letters, kind: '交接信', folder: 'letters' },
  ];
  const items = [];
  for (const { dir, kind, folder } of folders) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
    } catch {
      continue;
    }
    for (const name of files) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      items.push({ name, size: stat.size, mtime: stat.mtime.toISOString(), kind, folder });
    }
  }
  return items.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
}

export function readLetter(name) {
  const base = path.basename(String(name || ''));
  if (!base.endsWith('.md')) throw new Error('只允许读取 .md 信件');
  for (const dir of [paths.daily, paths.weekly, paths.letters]) {
    const root = path.resolve(dir) + path.sep;
    const full = path.resolve(dir, base);
    if (!full.startsWith(root)) continue;
    if (fs.existsSync(full)) return fs.readFileSync(full, 'utf8');
  }
  throw new Error('信件不存在');
}

export function getMemoryOverview({ query = '' } = {}) {
  const settings = { memory: { retrieveBudgetTokens: 2200, retrieveCount: 10 } };
  const block = getMemoryBlock({ query, settings, recordUsage: false });
  return {
    core: block.core,
    mid: block.mid,
    long: block.long,
    summary: block.summary,
    handover: block.handover,
    innerThoughts: block.innerThoughts,
    letters: listLetters(),
    session: block.session,
  };
}

export function recentMemoryCounts() {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM memories WHERE updated_at >= ?")
    .get(new Date(Date.now() - 7 * 86400000).toISOString());
  return Number(row?.n || 0);
}

export function archiveLabel(session) {
  return `${session.title || session.id} · ${formatLocal(new Date(session.created_at))}`;
}
