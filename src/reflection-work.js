import { getDb, kvGet, kvSet, parseJson } from './db.js';
import { estimateMessagesTokens } from './util.js';

export function queueReflection(sessionId, messageId, now = Date.now()) {
  const db = getDb();
  const message = db.prepare("SELECT id,meta FROM messages WHERE id=? AND session_id=? AND role='assistant' AND channel IN ('web','qq')").get(messageId, sessionId);
  if (!message) return;
  const meta = parseJson(message.meta, {});
  if (meta.aborted || ['failed','not_sent','pending','unknown'].includes(meta.qqDelivery)) return;
  const previous = db.prepare(`SELECT coalesce(max(id),0) AS id FROM messages WHERE session_id=?
    AND role='assistant' AND channel IN ('web','qq') AND id<?
    AND coalesce(json_extract(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END,'$.aborted'),0)=0
    AND coalesce(json_extract(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END,'$.qqDelivery'),'sent')='sent'`).get(sessionId, messageId);
  db.prepare('INSERT OR IGNORE INTO reflection_work(message_id,session_id,from_id,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(messageId, sessionId, previous.id, now, now);
}

function batchMessages(rows) {
  const first = rows[0];
  const last = rows.at(-1);
  return getDb().prepare(`SELECT * FROM messages WHERE session_id=? AND id>? AND id<=?
    AND role IN ('user','assistant') AND channel IN ('web','qq') ORDER BY id`)
    .all(first.session_id, first.from_id, last.message_id)
    .map(message => ({ ...message, meta: parseJson(message.meta, {}) }))
    .filter(message => {
      const meta = message.meta;
      return !meta.aborted && (message.role !== 'assistant' || !['failed','not_sent','pending','unknown'].includes(meta.qqDelivery));
    });
}

export function claimReflection(settings, now = Date.now()) {
  const db = getDb();
  const groups = db.prepare(`SELECT session_id,count(*) AS count,min(created_at) AS oldest
    FROM reflection_work WHERE state='pending' GROUP BY session_id ORDER BY oldest`).all();
  const intervalMs = Number(settings.model?.reflectMinSeconds ?? 120) * 1000;
  const every = Number(settings.model?.reflectEvery || 4);
  for (const group of groups) {
    const lastAttempt = Number(kvGet(`reflect_attempt_at:${group.session_id}`, '0'));
    if (now - lastAttempt < intervalMs) continue;
    if (group.count < every && now - group.oldest < intervalMs) continue;
    // Older failed work is visible for review. A later batch never includes it
    // implicitly, so retrying it cannot apply the same mood update twice.
    let rows = db.prepare("SELECT * FROM reflection_work WHERE session_id=? AND state='pending' ORDER BY message_id LIMIT ?")
      .all(group.session_id, Math.min(8, every));
    const firstId = rows[0].message_id;
    // Restrict a batch to consecutive work rows. Done/failed rows form a boundary.
    const boundary = db.prepare("SELECT min(message_id) AS id FROM reflection_work WHERE session_id=? AND message_id>? AND state<>'pending'")
      .get(group.session_id, firstId).id;
    if (boundary) rows = rows.filter(row => row.message_id < boundary);
    let messages = batchMessages(rows);
    while (rows.length > 1 && estimateMessagesTokens(messages) > 3200) {
      rows.pop();
      messages = batchMessages(rows);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) db.prepare("UPDATE reflection_work SET state='running',attempts=attempts+1,updated_at=? WHERE message_id=? AND state='pending'").run(now, row.message_id);
      kvSet(`reflect_attempt_at:${group.session_id}`, String(now));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { rows, messages, sessionId: group.session_id, messageId: rows.at(-1).message_id };
  }
  return null;
}

export function finishReflection(batch, state, error = '') {
  const db = getDb();
  for (const row of batch.rows) {
    db.prepare("UPDATE reflection_work SET state=?,error=?,updated_at=? WHERE message_id=? AND state='running'")
      .run(state, error.slice(0, 180), Date.now(), row.message_id);
    if (error === 'REFLECTION_BUDGET') db.prepare('UPDATE reflection_work SET attempts=max(0,attempts-1) WHERE message_id=?').run(row.message_id);
  }
}

export function recoverReflections() {
  // Applying the model result and marking done share one transaction. A crash
  // before that commit leaves no memory/mood changes to apply twice.
  getDb().prepare("UPDATE reflection_work SET state=CASE WHEN attempts<2 THEN 'pending' ELSE 'failed' END,updated_at=? WHERE state='running'").run(Date.now());
  const db = getDb();
  const baseline = kvGet('reflection_work_baseline');
  if (baseline === null || baseline === undefined || baseline === '') {
    kvSet('reflection_work_baseline', String(db.prepare('SELECT coalesce(max(id),0) AS id FROM messages').get().id));
    return;
  }
  const missing = db.prepare(`SELECT id,session_id FROM messages WHERE id>?
    AND role='assistant' AND channel IN ('web','qq') AND json_extract(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END,'$.usage') IS NOT NULL
    AND coalesce(json_extract(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END,'$.aborted'),0)=0
    AND coalesce(json_extract(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END,'$.qqDelivery'),'sent')='sent'
    AND NOT EXISTS(SELECT 1 FROM reflection_work w WHERE w.message_id=messages.id) ORDER BY id`).all(Number(baseline));
  for (const row of missing) queueReflection(row.session_id, row.id);
}

export function reflectionWorkStatus() {
  return getDb().prepare("SELECT state,count(*) AS count,sum(CASE WHEN error='REFLECTION_BUDGET' THEN 1 ELSE 0 END) AS budgetPaused FROM reflection_work GROUP BY state").all();
}

export function retryFailedReflections() {
  return getDb().prepare("UPDATE reflection_work SET state='pending',error='',updated_at=? WHERE state='failed'").run(Date.now()).changes;
}
