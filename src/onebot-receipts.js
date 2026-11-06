import crypto from 'node:crypto';
import { getDb } from './db.js';

const initialized = new WeakSet();
export function normalizeOneBotEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const result = { ...event };
  for (const field of ['self_id', 'user_id', 'group_id', 'message_id']) {
    if (result[field] == null) continue;
    const value = result[field];
    if (typeof value === 'number' && !Number.isSafeInteger(value) || !['string', 'number'].includes(typeof value)) return null;
    result[field] = String(value).trim();
  }
  if (Number.isFinite(Number(result.time)) && Number(result.time) > 1e12) result.time = Math.floor(Number(result.time) / 1000);
  return result;
}
function journal() {
  const db = getDb();
  if (initialized.has(db)) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_message_receipts (key TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS qq_message_receipts_received ON qq_message_receipts(received_at);
    CREATE TABLE IF NOT EXISTS qq_inbox (
      key TEXT PRIMARY KEY, provider TEXT NOT NULL, bot TEXT NOT NULL, owner TEXT NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL, received_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS qq_inbox_state ON qq_inbox(state, received_at);
    CREATE TABLE IF NOT EXISTS qq_outbox (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, bot TEXT NOT NULL,
      action TEXT NOT NULL, params TEXT NOT NULL, receipt_keys TEXT NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      message_id TEXT, reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS qq_outbox_state ON qq_outbox(state, created_at);
  `);
  initialized.add(db);
  return db;
}

export function messageReceiptKey(event) {
  event = normalizeOneBotEvent(event) || event;
  // Include the account, chat and sender: OneBot IDs are adapter-local and can
  // collide between conversations. Do not merge distinct messages by text.
  const scope = [String(event.self_id || ''), event.message_type || '', String(event.group_id || ''), String(event.user_id || '')];
  const identity = event.message_id != null
    ? ['id', String(event.message_id), String(event.time || '')]
    : ['event', String(event.time || ''), event.message || [], event.raw_message || ''];
  return crypto.createHash('sha256').update(JSON.stringify([scope, identity])).digest('hex');
}

// A bounded receipt ledger survives application restart. This is duplicate
// suppression, not an exactly-once transaction with the external QQ service.
export function claimMessageReceipt(event, now = Date.now(), context = {}) {
  const db = journal();
  db.prepare('DELETE FROM qq_message_receipts WHERE received_at < ?').run(now - 24 * 3600000);
  const key = messageReceiptKey(event);
  if (db.prepare('SELECT 1 FROM qq_inbox WHERE key=?').get(key)) return { key, claimed: false };
  db.exec('BEGIN IMMEDIATE');
  try {
    const claimed = db.prepare('INSERT OR IGNORE INTO qq_message_receipts(key, received_at) VALUES (?, ?)').run(key, now).changes === 1;
    if (claimed) db.prepare('INSERT INTO qq_inbox(key,provider,bot,owner,payload,state,received_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(key, context.provider || 'napcat', String(event.self_id || ''), String(context.owner || ''), JSON.stringify(event), 'received', now, now);
    db.exec('COMMIT');
    return { key, claimed };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function inboxState(keys, state, reason = '') {
  const allowed = {
    dispatching: ['received', 'buffered'], buffered: ['dispatching'],
    processing: ['buffered'], completed: ['dispatching', 'processing'],
    review: ['received', 'buffered', 'dispatching', 'processing'],
  };
  if (!allowed[state]) throw new Error('入站队列状态不合法');
  const db = journal();
  for (const key of keys || []) {
    const row = db.prepare('SELECT state FROM qq_inbox WHERE key=?').get(key);
    if (!row) continue;
    if (row.state === state) continue;
    if (!allowed[state].includes(row.state)) throw new Error(`入站队列不能从 ${row.state} 转为 ${state}`);
    db.prepare('UPDATE qq_inbox SET state=?, updated_at=?, reason=? WHERE key=?').run(state, Date.now(), String(reason).slice(0, 240), key);
  }
}

export function beginOutbound({ provider, bot, action, params, receiptKeys = [], sequence = null }) {
  const id = receiptKeys.length && sequence != null
    ? crypto.createHash('sha256').update(JSON.stringify([provider, String(bot), [...receiptKeys].sort(), sequence, action])).digest('hex')
    : crypto.randomUUID();
  const previous = journal().prepare('SELECT * FROM qq_outbox WHERE id=?').get(id);
  if (previous) {
    if (previous.state === 'sent' || previous.state === 'confirmed') return { id, receipt: { status: 'ok', retcode: 0, data: { message_id: previous.message_id } } };
    throw Object.assign(new Error('此段回复已尝试发送，不自动重发，请核对投递台账'), { code: 'DELIVERY_UNKNOWN' });
  }
  const now = Date.now();
  journal().prepare('INSERT INTO qq_outbox(id,provider,bot,action,params,receipt_keys,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, provider, String(bot), action, JSON.stringify(params), JSON.stringify(receiptKeys), 'sending', now, now);
  return { id };
}

export function finishOutbound(id, state, { messageId = null, reason = '' } = {}) {
  if (!id) return;
  if (!['sent', 'failed', 'unknown'].includes(state)) throw new Error('出站队列状态不合法');
  journal().prepare("UPDATE qq_outbox SET state=?,message_id=?,reason=?,updated_at=? WHERE id=? AND state='sending'")
    .run(state, messageId == null ? null : String(messageId), String(reason).slice(0, 240), Date.now(), id);
}

export function recoverJournal() {
  const db = journal();
  db.prepare("UPDATE qq_outbox SET state='unknown',reason='服务中断，发送结果待核对',updated_at=? WHERE state='sending'").run(Date.now());
  db.prepare("UPDATE qq_inbox SET state='review',reason='处理过程中服务中断，不自动重跑副作用',updated_at=? WHERE state IN ('dispatching','processing')").run(Date.now());
  db.exec("UPDATE messages SET meta=json_set(meta,'$.qqDelivery','unknown') WHERE role='assistant' AND channel IN ('qq','qq-group','qq-guest') AND json_extract(meta,'$.qqDelivery')='pending'");
  // Retain unresolved work. Only terminal records are eligible for retention cleanup.
  db.prepare("DELETE FROM qq_inbox WHERE state IN ('completed','discarded') AND updated_at < ?").run(Date.now() - 7 * 86400000);
  db.prepare("DELETE FROM qq_outbox WHERE state IN ('sent','failed','confirmed','not_sent') AND updated_at < ?").run(Date.now() - 7 * 86400000);
}

export function bindInboxOwner(key, owner) {
  journal().prepare("UPDATE qq_inbox SET owner=? WHERE key=? AND owner='' AND state='dispatching'").run(String(owner), key);
}

export function pendingInbox({ provider, bot, owner, maxAgeMs = 3600000, excludeKeys = [] } = {}) {
  const rows = journal().prepare("SELECT * FROM qq_inbox WHERE state IN ('received','buffered') ORDER BY received_at,key LIMIT 1000").all();
  const eligible = [];
  const excluded = new Set(excludeKeys);
  for (const row of rows) {
    if (excluded.has(row.key)) continue;
    if (row.provider !== provider || row.bot !== String(bot) || row.owner !== String(owner) || Date.now() - row.received_at > maxAgeMs) {
      inboxState([row.key], 'review', '账号、主人、协议端或消息时效已变化，须核对');
    } else eligible.push({ key: row.key, event: JSON.parse(row.payload) });
  }
  return eligible;
}

export function journalStatus() {
  const db = journal();
  const counts = (table) => Object.fromEntries(db.prepare(`SELECT state,count(*) AS count FROM ${table} GROUP BY state`).all().map(r => [r.state, r.count]));
  return { inbox: counts('qq_inbox'), outbox: counts('qq_outbox') };
}

export function journalReview() {
  const db = journal();
  // Do not return message bodies, media references, tokens or recipient numbers.
  return {
    counts: journalStatus(),
    inbox: db.prepare("SELECT key,provider,state,received_at,updated_at,reason FROM qq_inbox WHERE state='review' ORDER BY received_at LIMIT 100").all(),
    outbox: db.prepare("SELECT id,provider,action,state,created_at,updated_at,message_id,reason FROM qq_outbox WHERE state='unknown' ORDER BY created_at LIMIT 100").all(),
  };
}

export function resolveJournal({ kind, id, resolution }) {
  if (!['inbox', 'outbox'].includes(kind)) throw new Error('核对类型不合法');
  const allowed = kind === 'inbox' ? ['completed', 'discarded'] : ['confirmed', 'not_sent'];
  if (!allowed.includes(resolution)) throw new Error('核对结论不合法');
  const table = kind === 'inbox' ? 'qq_inbox' : 'qq_outbox';
  const key = kind === 'inbox' ? 'key' : 'id';
  const current = kind === 'inbox' ? 'review' : 'unknown';
  const changed = journal().prepare(`UPDATE ${table} SET state=?,reason='操作者已人工核对；未自动补发',updated_at=? WHERE ${key}=? AND state=?`)
    .run(resolution, Date.now(), String(id), current).changes;
  if (!changed) throw new Error('记录不存在或状态已变化，请刷新后核对');
}
