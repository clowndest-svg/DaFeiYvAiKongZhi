// 她自己写自己：这一层只属于她，反思时她可以追加或整段重写，
// 注入提示词时优先级高于「说话方式」那组参考，但改不了诚实、隐私、尊重这些底线。
import { addEvent, getDb, kvGetJson, kvSetJson } from './db.js';

const KEY = 'her:self-notes';
const HISTORY_KEY = 'her:self-notes:history';
const MAX_CHARS = 1500;
const MAX_VERSIONS = 12;

export function getHerSelfNotes() {
  const stored = kvGetJson(KEY, null);
  return stored && typeof stored === 'object' && typeof stored.text === 'string'
    ? { text: stored.text, updatedAt: stored.updatedAt || null }
    : { text: '', updatedAt: null };
}

export function updateHerSelfNotes(input = {}, { source = 'reflect', transaction = true } = {}) {
  const text = String(input.text || '').replace(/\r\n/g, '\n').trim();
  if (text.length < 2) return null;
  const current = getHerSelfNotes();
  const mode = input.mode === 'replace' ? 'replace' : 'append';
  let next = mode === 'replace' ? text : [current.text, text].filter(Boolean).join('\n');
  if (next.length > MAX_CHARS) next = next.slice(-MAX_CHARS);
  if (next === current.text) return null;
  const at = new Date().toISOString();
  const db = getDb();
  // 反思在它自己的事务里调用，这里不能嵌套 BEGIN。
  if (transaction) db.exec('BEGIN IMMEDIATE');
  try {
    kvSetJson(KEY, { text: next, updatedAt: at });
    const stored = kvGetJson(HISTORY_KEY, []);
    const history = Array.isArray(stored) ? stored : [];
    kvSetJson(HISTORY_KEY, [...history, { text: next, at, source, mode }].slice(-MAX_VERSIONS));
    addEvent('self_edit', '她自己改了一遍自我档案', { mode, chars: next.length, source });
    if (transaction) db.exec('COMMIT');
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    throw error;
  }
  return { text: next, updatedAt: at, mode };
}

export function clearHerSelfNotes({ source = 'owner' } = {}) {
  const current = getHerSelfNotes();
  if (!current.text) return { ok: true };
  const at = new Date().toISOString();
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    kvSetJson(KEY, { text: '', updatedAt: at });
    const stored = kvGetJson(HISTORY_KEY, []);
    const history = Array.isArray(stored) ? stored : [];
    kvSetJson(HISTORY_KEY, [...history, { text: '', at, source, mode: 'clear' }].slice(-MAX_VERSIONS));
    addEvent('self_edit', '自我档案被清空，她会重新开始写', { source });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, updatedAt: at };
}

export function selfNotesVersions() {
  const stored = kvGetJson(HISTORY_KEY, []);
  return Array.isArray(stored) ? stored : [];
}