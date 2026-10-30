import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from './config.js';
import { logger } from './logger.js';
import { hashText, keywordSet, normalizeMemoryText, nowIso, overlapScore, startOfShanghaiDayIso } from './util.js';

let instance = null;

export function initDb(file = paths.db) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      archived_at TEXT,
      token_used INTEGER NOT NULL DEFAULT 0,
      handover TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT 'web',
      meta TEXT NOT NULL DEFAULT '{}',
      tokens INTEGER NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      compacted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layer TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      tags TEXT NOT NULL DEFAULT '[]',
      reasoning TEXT NOT NULL DEFAULT '',
      source_session TEXT,
      dedupe TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      use_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer, importance);

    CREATE TABLE IF NOT EXISTS moods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      valence REAL NOT NULL,
      energy REAL NOT NULL,
      affection REAL NOT NULL,
      label TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      session_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      approved_at TEXT,
      posted_at TEXT,
      external_url TEXT,
      error TEXT,
      meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, id);

    CREATE TABLE IF NOT EXISTS costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'chat',
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
      cost_cny REAL NOT NULL DEFAULT 0,
      session_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_costs_created ON costs(created_at);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'messages', 'context_tokens', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_moods_created ON moods(created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  `);
  instance = db;
  maybeBackup(db, file);
  return db;
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function maybeBackup(db, file) {
  if (!file || file === ':memory:' || process.env.BIZHI_NO_BACKUP === '1') return;
  try {
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const dir = path.join(paths.data, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `bizhi-${day}.db`);
    if (fs.existsSync(target)) return;
    const temporary = `${target}.tmp-${process.pid}`;
    try {
      db.exec(`VACUUM INTO '${temporary.replace(/'/g, "''")}'`);
      const snapshot = new DatabaseSync(temporary, { readOnly: true });
      const result = snapshot.prepare('PRAGMA integrity_check').get();
      snapshot.close();
      if (Object.values(result)[0] !== 'ok') throw new Error('备份完整性校验失败');
      fs.renameSync(temporary, target);
    } finally { try { fs.unlinkSync(temporary); } catch { /* 已重命名 */ } }
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.db'))
      .sort();
    for (const old of files.slice(0, Math.max(0, files.length - 7))) {
      fs.rmSync(path.join(dir, old), { force: true });
    }
    logger.info('数据库已备份', { file: path.basename(target) });
  } catch (error) {
    logger.warn('数据库备份失败', { error: error.message });
  }
}

export function getDb() {
  if (!instance) initDb();
  return instance;
}

export function closeDb() {
  if (!instance) return;
  try {
    instance.close();
  } catch {
    // ignore
  }
  instance = null;
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/* ---------------- kv ---------------- */

export function kvGet(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function kvSet(key, value) {
  getDb()
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function kvGetJson(key, fallback = null) {
  const raw = kvGet(key);
  if (raw == null) return fallback;
  return parseJson(raw, fallback);
}

export function kvSetJson(key, value) {
  kvSet(key, JSON.stringify(value));
}

export function kvDeletePrefix(prefix) {
  const key = String(prefix || '');
  if (!key) return 0;
  return getDb().prepare('DELETE FROM kv WHERE substr(key,1,?) = ?').run(key.length, key).changes;
}

/* ---------------- sessions ---------------- */

function mapSession(row) {
  if (!row) return null;
  return { ...row };
}

export function createSession(title = '我们的日常') {
  const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  getDb()
    .prepare('INSERT INTO sessions (id, title, status, created_at) VALUES (?, ?, ?, ?)')
    .run(id, title, 'active', nowIso());
  return getSession(id);
}

export function getSession(id) {
  return mapSession(getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id));
}

export function getActiveSession() {
  const id = kvGet('active_session_id');
  let session = id ? getSession(id) : null;
  if (!session || session.status !== 'active') {
    session = createSession('我们的日常');
    kvSet('active_session_id', session.id);
  }
  return session;
}

export function setActiveSession(id) {
  kvSet('active_session_id', id);
}

export function archiveSession(id, handover = '') {
  getDb()
    .prepare("UPDATE sessions SET status = 'archived', archived_at = ?, handover = ? WHERE id = ?")
    .run(nowIso(), handover, id);
  if (kvGet('active_session_id') === id) kvSet('active_session_id', '');
}

export function listSessions(limit = 20) {
  return getDb().prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function addSessionTokens(sessionId, tokens) {
  if (!tokens) return;
  getDb().prepare('UPDATE sessions SET token_used = token_used + ? WHERE id = ?').run(Math.round(tokens), sessionId);
}

/* ---------------- messages ---------------- */

function mapMessage(row) {
  if (!row) return null;
  return { ...row, meta: parseJson(row.meta, {}) };
}

export function addMessage({ sessionId, role, content, channel = 'web', meta = {}, tokens = 0, contextTokens = 0 }) {
  const info = getDb()
    .prepare(
      'INSERT INTO messages (session_id, role, content, channel, meta, tokens, context_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      sessionId,
      role,
      content,
      channel,
      JSON.stringify(meta || {}),
      Math.round(tokens),
      Math.round(contextTokens),
      nowIso(),
    );
  addSessionTokens(sessionId, tokens);
  return mapMessage(getDb().prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid)));
}

export function getMessage(id) {
  return mapMessage(getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id));
}

export function updateMessageMeta(id, patch) {
  const current = getMessage(id);
  if (!current) return null;
  const meta = { ...current.meta, ...patch };
  getDb().prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
  return { ...current, meta };
}

export function updateMessageContent(id, content, tokens) {
  getDb()
    .prepare('UPDATE messages SET content = ?, tokens = ? WHERE id = ?')
    .run(content, Math.round(tokens || 0), id);
}

export function getRecentMessages(sessionId, limit = 24, includeCompacted = false) {
  const sql = includeCompacted
    ? 'SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM messages WHERE session_id = ? AND compacted = 0 ORDER BY id DESC LIMIT ?';
  return getDb().prepare(sql).all(sessionId, limit).reverse().map(mapMessage);
}

export function getMessagesForPrompt(sessionId, limit = 24) {
  return getRecentMessages(sessionId, limit, false).filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.meta?.aborted);
}

export function recentUserMessages(limit = 60) {
  const session = getActiveSession();
  if (!session) return [];
  return getRecentMessages(session.id, limit, true)
    .filter((m) => m.role === 'user')
    .map((m) => m.content);
}

const QUOTE_JUNK = /(\[[^\]]{1,6}\]|（[^）]*）|\([^)]*\))/g;
const SQUASH_RE = /[\s，。！？、,.!?~～：:；;“”"'‘’（）()【】\[\]]/g;

/** 他亲口说过的原话：只查 role='user'，逐字返回，不改写、不摘要。 */
export function findQuotedLines(query, { limit = 5, minScore = 0.14, days = 120, skipRecent = 0, excludeIds = [] } = {}) {
  const qset = keywordSet(query);
  const qBare = String(query || '').replace(SQUASH_RE, '');
  if (qset.size < 2 && qBare.length < 3) return [];
  const since = new Date(Date.now() - Math.max(1, Number(days) || 120) * 86400000).toISOString();
  const rows = getDb()
    .prepare(
      "SELECT id, content, channel, created_at, session_id FROM messages WHERE role = 'user' AND created_at >= ? AND (channel IS NULL OR channel IN ('web','qq')) ORDER BY id DESC LIMIT 1200",
    )
    .all(since);
  const scored = [];
  for (const [index, row] of rows.entries()) {
    if (index < skipRecent || excludeIds.includes(Number(row.id))) continue;
    const raw = String(row.content || '').trim();
    const bare = raw.replace(QUOTE_JUNK, '').replace(/\s+/g, '');
    if (bare.length < 3 || bare.length > 400) continue;
    const exact = qBare.length >= 3 && bare.includes(qBare);
    let hits = 0;
    const lineSet = keywordSet(bare);
    for (const k of qset) if (lineSet.has(k)) hits += 1;
    if (!exact && hits < 2) continue;
    const score = exact ? 1 : overlapScore(qset, bare);
    if (!exact && score < minScore) continue;
    scored.push({
      id: Number(row.id),
      text: raw,
      channel: row.channel,
      createdAt: row.created_at,
      sessionId: row.session_id,
      score: Math.round(score * 1000) / 1000,
      hits: exact ? Math.max(2, hits) : hits,
      order: index,
    });
  }
  scored.sort((a, b) => b.hits - a.hits || b.score - a.score || a.order - b.order);
  return scored.slice(0, Math.max(1, Number(limit) || 5));
}

export function getUncompactedMessages(sessionId) {
  return getDb()
    .prepare('SELECT * FROM messages WHERE session_id = ? AND compacted = 0 ORDER BY id ASC')
    .all(sessionId)
    .map(mapMessage);
}

export function markMessagesCompacted(ids) {
  const stmt = getDb().prepare('UPDATE messages SET compacted = 1 WHERE id = ?');
  for (const id of ids) stmt.run(id);
}

export function countMessages(sessionId) {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId);
  return Number(row?.n || 0);
}

export function lastUserMessageAt() {
  const row = getDb()
    .prepare(
      "SELECT created_at FROM messages WHERE role = 'user' AND channel IN ('web','qq') ORDER BY id DESC LIMIT 1",
    )
    .get();
  return row?.created_at || null;
}

export function lastAssistantContextTokens(sessionId) {
  const row = getDb()
    .prepare(
      "SELECT context_tokens FROM messages WHERE session_id = ? AND role = 'assistant' AND context_tokens > 0 ORDER BY id DESC LIMIT 1",
    )
    .get(sessionId);
  return Number(row?.context_tokens || 0);
}

/* ---------------- memories ---------------- */

function mapMemory(row) {
  if (!row) return null;
  return { ...row, tags: parseJson(row.tags, []) };
}

export function addMemory({
  layer = 'mid',
  content,
  importance = 3,
  tags = [],
  reasoning = '',
  sourceSession = null,
}) {
  const norm = normalizeMemoryText(content);
  if (!norm) return null;
  const safeImportance = Math.min(5, Math.max(1, Number(importance) || 3));
  const safeTags = Array.isArray(tags) ? tags.slice(0, 8) : [];

  // 相似记忆合并：避免“他累了需要陪伴”被反复记成三条。
  // 但如果两边带着不同的数字（例如生日 3/14 和 3/15），绝不合并，宁可分开记。
  const keyword = keywordSet(norm);
  const numbersOf = (text) => (String(text).match(/\d+/g) || []).sort().join(',');
  const newNumbers = numbersOf(norm);
  const candidates = getDb()
    .prepare('SELECT * FROM memories WHERE layer = ? ORDER BY updated_at DESC LIMIT 200')
    .all(layer)
    .map(mapMemory);
  for (const existing of candidates) {
    const score = overlapScore(keyword, existing.content);
    if (score > 0.68) {
      const oldNumbers = numbersOf(existing.content);
      if (newNumbers && oldNumbers && newNumbers !== oldNumbers) continue;
      const hasNegation = (text) => /(?:^|[^不])不|没|别|勿|无需/.test(String(text));
      if (hasNegation(norm) !== hasNegation(existing.content)) continue;
      const useNew = norm.length > existing.content.length;
      const mergedTags = [...new Set([...(existing.tags || []), ...safeTags])].slice(0, 8);
      getDb()
        .prepare(
          `UPDATE memories SET content = ?, importance = MAX(importance, ?), tags = ?,
             reasoning = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          useNew ? norm : existing.content,
          safeImportance,
          JSON.stringify(mergedTags),
          reasoning || existing.reasoning,
          nowIso(),
          existing.id,
        );
      return mapMemory(getDb().prepare('SELECT * FROM memories WHERE id = ?').get(existing.id));
    }
  }

  const dedupe = hashText(`${layer}|${norm.toLowerCase()}`);
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO memories (layer, content, importance, tags, reasoning, source_session, dedupe, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe) DO UPDATE SET
         importance = MAX(memories.importance, excluded.importance),
         updated_at = excluded.updated_at`,
    )
    .run(
      layer,
      norm,
      safeImportance,
      JSON.stringify(safeTags),
      String(reasoning || ''),
      sourceSession,
      dedupe,
      now,
      now,
    );
  return mapMemory(getDb().prepare('SELECT * FROM memories WHERE dedupe = ?').get(dedupe));
}

export function listMemories({ layer = null, limit = 200 } = {}) {
  const sql = layer
    ? 'SELECT * FROM memories WHERE layer = ? ORDER BY importance DESC, updated_at DESC LIMIT ?'
    : 'SELECT * FROM memories ORDER BY layer ASC, importance DESC, updated_at DESC LIMIT ?';
  const rows = layer ? getDb().prepare(sql).all(layer, limit) : getDb().prepare(sql).all(limit);
  return rows.map(mapMemory);
}

export function searchableMidMemories(limit = 800) {
  return getDb()
    .prepare("SELECT * FROM memories WHERE layer = 'mid' ORDER BY importance DESC, updated_at DESC LIMIT ?")
    .all(limit)
    .map(mapMemory);
}

export function touchMemories(ids) {
  if (!ids?.length) return;
  const stmt = getDb().prepare('UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?');
  const now = nowIso();
  for (const id of ids) stmt.run(now, id);
}

export function deleteMemory(id) {
  getDb().prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function countMemories() {
  const rows = getDb().prepare('SELECT layer, COUNT(*) AS n FROM memories GROUP BY layer').all();
  const out = { core: 0, mid: 0, long: 0 };
  for (const row of rows) out[row.layer] = Number(row.n);
  return out;
}

/* ---------------- moods ---------------- */

export function addMood({ valence, energy, affection, label, reason = '', sessionId = null }) {
  const info = getDb()
    .prepare(
      'INSERT INTO moods (valence, energy, affection, label, reason, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(valence, energy, affection, label, reason, sessionId, nowIso());
  return getDb().prepare('SELECT * FROM moods WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function latestMood() {
  return getDb().prepare('SELECT * FROM moods ORDER BY id DESC LIMIT 1').get() || null;
}

export function listMoods(limit = 30) {
  return getDb().prepare('SELECT * FROM moods ORDER BY id DESC LIMIT ?').all(limit);
}

/* ---------------- posts ---------------- */

function mapPost(row) {
  if (!row) return null;
  return { ...row, tags: parseJson(row.tags, []), meta: parseJson(row.meta, {}) };
}

export function addPost({ kind, title = '', content, tags = [], status = 'draft', meta = {} }) {
  const info = getDb()
    .prepare(
      'INSERT INTO posts (kind, title, content, tags, status, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(kind, title, content, JSON.stringify(tags), status, nowIso(), JSON.stringify(meta));
  return getPost(Number(info.lastInsertRowid));
}

export function getPost(id) {
  return mapPost(getDb().prepare('SELECT * FROM posts WHERE id = ?').get(id));
}

export function listPosts({ status = null, limit = 50 } = {}) {
  const rows = status
    ? getDb().prepare('SELECT * FROM posts WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : getDb().prepare('SELECT * FROM posts ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map(mapPost);
}

export function updatePost(id, patch) {
  const current = getPost(id);
  if (!current) return null;
  const next = {
    status: patch.status ?? current.status,
    approved_at: Object.hasOwn(patch, 'approved_at') ? patch.approved_at : current.approved_at,
    posted_at: Object.hasOwn(patch, 'posted_at') ? patch.posted_at : current.posted_at,
    external_url: Object.hasOwn(patch, 'external_url') ? patch.external_url : current.external_url,
    error: Object.hasOwn(patch, 'error') ? patch.error : current.error,
    meta: JSON.stringify(patch.meta ? { ...current.meta, ...patch.meta } : current.meta),
  };
  getDb()
    .prepare('UPDATE posts SET status = ?, approved_at = ?, posted_at = ?, external_url = ?, error = ?, meta = ? WHERE id = ?')
    .run(next.status, next.approved_at, next.posted_at, next.external_url, next.error, next.meta, id);
  return getPost(id);
}

export function deletePost(id) {
  getDb().prepare('DELETE FROM posts WHERE id = ?').run(id);
}

export function countPendingPosts() {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'draft'").get();
  return Number(row?.n || 0);
}

/* ---------------- costs ---------------- */

export function addCost({
  model,
  kind = 'chat',
  promptTokens = 0,
  completionTokens = 0,
  cacheHitTokens = 0,
  costCny = 0,
  sessionId = null,
}) {
  getDb()
    .prepare(
      'INSERT INTO costs (model, kind, prompt_tokens, completion_tokens, cache_hit_tokens, cost_cny, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(model, kind, Math.round(promptTokens), Math.round(completionTokens), Math.round(cacheHitTokens), costCny, sessionId, nowIso());
}

export function costSummary(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const today = startOfShanghaiDayIso();
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(cache_hit_tokens),0) AS cache_hit_tokens,
              COALESCE(SUM(cost_cny),0) AS cost_cny
       FROM costs WHERE created_at >= ?`,
    )
    .get(since);
  const todayRow = getDb()
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(cost_cny),0) AS cost_cny,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens
       FROM costs WHERE created_at >= ?`,
    )
    .get(today);
  const todayPromptTokens = Number(todayRow?.prompt_tokens || 0);
  const todayCompletionTokens = Number(todayRow?.completion_tokens || 0);
  return {
    days,
    calls: Number(row?.calls || 0),
    promptTokens: Number(row?.prompt_tokens || 0),
    completionTokens: Number(row?.completion_tokens || 0),
    cacheHitTokens: Number(row?.cache_hit_tokens || 0),
    costCny: Number(row?.cost_cny || 0),
    todayCalls: Number(todayRow?.calls || 0),
    todayCostCny: Number(todayRow?.cost_cny || 0),
    todayPromptTokens,
    todayCompletionTokens,
    todayTokens: todayPromptTokens + todayCompletionTokens,
  };
}

/* ---------------- events ---------------- */

export function addEvent(type, message = '', data = {}) {
  getDb()
    .prepare('INSERT INTO events (type, message, data, created_at) VALUES (?, ?, ?, ?)')
    .run(type, message, JSON.stringify(data || {}), nowIso());
}

export function listEvents(limit = 40) {
  return getDb()
    .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((row) => ({ ...row, data: parseJson(row.data, {}) }));
}

export function countUsers() {
  const row = getDb().prepare("SELECT COUNT(DISTINCT session_id) AS n FROM messages WHERE role = 'user'").get();
  return Number(row?.n || 0);
}

export function backupDatabase() {
  maybeBackup(getDb(), paths.db);
}

const MEDIA_TTL = [
  { prefix: 'xhs-shot-', ms: 7 * 86400000 },
  { prefix: 'xhs-draft-', ms: 7 * 86400000 },
  { prefix: 'voice-', ms: 6 * 3600000 },
];

function sweepMedia(now) {
  let files = 0;
  let bytes = 0;
  try {
    for (const entry of fs.readdirSync(paths.media)) {
      const rule = MEDIA_TTL.find((item) => entry.startsWith(item.prefix));
      if (!rule) continue;
      const file = path.join(paths.media, entry);
      const stat = fs.statSync(file);
      if (!stat.isFile() || now - stat.mtimeMs <= rule.ms) continue;
      fs.unlinkSync(file);
      files += 1;
      bytes += stat.size;
    }
  } catch (error) {
    logger.warn('媒体清理没跑成', { error: error.message });
  }
  return { files, bytes };
}

function sweepPresenceTmp(now) {
  let files = 0;
  try {
    for (const entry of fs.readdirSync(paths.presenceTmp)) {
      if (!entry.startsWith('hear-')) continue;
      const file = path.join(paths.presenceTmp, entry);
      const stat = fs.statSync(file);
      if (!stat.isFile() || now - stat.mtimeMs <= 3600000) continue;
      fs.unlinkSync(file);
      files += 1;
    }
  } catch {
    // 还没用过麦克风，目录是空的
  }
  return files;
}

export function maintenance() {
  const db = getDb();
  const now = Date.now();
  const isoDaysAgo = (days) => new Date(now - days * 86400000).toISOString();
  const swept = sweepMedia(now);
  const removed = {
    events: Number(db.prepare('DELETE FROM events WHERE created_at < ?').run(isoDaysAgo(90)).changes || 0),
    costs: Number(db.prepare('DELETE FROM costs WHERE created_at < ?').run(isoDaysAgo(365)).changes || 0),
    moods: Number(db.prepare('DELETE FROM moods WHERE created_at < ?').run(isoDaysAgo(365)).changes || 0),
    kv: 0,
    media: swept.files,
    mediaBytes: swept.bytes,
    presenceTmp: sweepPresenceTmp(now),
  };

  const datedPrefixes = [
    'qzone_publish_day:',
    'xhs_dm_day:',
    'xhs_dm_target:',
    'xhs_publish_target:',
    'cost_skip_notified:',
    'daily_fail:',
    'qzone_reply_hour:',
    'qzone_reply_day:',
    'proactive_count:',
    'post_count:',
    'daily_attempt:',
    'daily_skip:',
    'weekly_done:',
    'weekly_attempt:',
    'dream_done:',
    'dream_fail:',
    'dream_fail_at:',
    'voice_day:',
    'heard_day:',
    'qq_follow_up_day:',
    'tick_fail:',
    'sticker_adopt_day:',
    'xhs_action_hour:',
    'xhs_comment_day:',
    'xhs_reply_day:',
    'xhs_like_day:',
    'xhs_collect_day:',
    'xhs_publish_day:',
    'xhs_publish_attempt:',
    'presence_look_day:',
    'presence_speak_day:',
  ];
  const cutoffDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(
    new Date(now - 30 * 86400000),
  );
  const del = db.prepare('DELETE FROM kv WHERE key = ?');
  for (const row of db.prepare('SELECT key FROM kv').all()) {
    const key = row.key;
    if (!datedPrefixes.some((prefix) => key.startsWith(prefix))) continue;
    const date = String(key).match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (date && date < cutoffDate) {
      del.run(key);
      removed.kv += 1;
    }
  }

  const failed = kvGetJson('qzone_failed_comments', {});
  const recentFailed = Object.fromEntries(
    Object.entries(failed).filter(([, at]) => at && now - new Date(at).getTime() < 7 * 86400000),
  );
  if (Object.keys(recentFailed).length !== Object.keys(failed).length) {
    kvSetJson('qzone_failed_comments', recentFailed);
    removed.kv += Object.keys(failed).length - Object.keys(recentFailed).length;
  }

  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch {
    // ignore
  }
  if (removed.events || removed.costs || removed.moods || removed.kv || removed.media) {
    logger.info('旧数据清理完成', removed);
  }
  backupDatabase();
  return removed;
}
