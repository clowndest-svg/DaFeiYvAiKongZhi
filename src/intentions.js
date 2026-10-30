import { addEvent, kvGetJson, kvSetJson } from './db.js';
import { nowIso } from './util.js';

const KEY = 'open_intentions';
const MAX_OPEN = 12;
const TTL_MS = 4 * 86400000;
const STALE_DUE_MS = 12 * 3600000;

function squash(text) { return String(text || '').replace(/[\p{P}\p{Z}\s]/gu, ''); }
function readRaw() {
  const list = kvGetJson(KEY, []);
  return Array.isArray(list) ? list.filter((item) => item && typeof item.text === 'string') : [];
}
function read() {
  const now = Date.now();
  return readRaw().filter((item) => {
    const created = Date.parse(item.createdAt);
    const due = Date.parse(item.dueAt || item.createdAt);
    const expires = Math.min(created + TTL_MS, due + STALE_DUE_MS, item.expiresAt ? Date.parse(item.expiresAt) : Infinity);
    return Number.isFinite(created) && Number.isFinite(due) && Number.isFinite(expires) && created <= now && expires > now && Number(item.tries || 0) < 2;
  });
}

export function addIntention({ text = '', reason = '', dueInHours = 0, source = 'reflect' } = {}) {
  const value = String(text).replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!value) return null;
  const list = read();
  const next = squash(value);
  if (!next || list.some((item) => { const old = squash(item.text); return old && (old === next || old.includes(next) || next.includes(old)); })) return null;
  const newest = list.reduce((latest, item) => Math.max(latest, Date.parse(item.createdAt)), 0);
  if (Date.now() - newest < 20 * 60000) return null;
  const hours = Number.isFinite(Number(dueInHours)) ? Math.min(72, Math.max(0, Number(dueInHours))) : 0;
  const now = Date.now();
  const due = now + hours * 3600000;
  const item = {
    id: `${now}-${Math.random().toString(36).slice(2, 6)}`, text: value,
    reason: String(reason).replace(/\s+/g, ' ').trim().slice(0, 60), source: String(source).slice(0, 20),
    createdAt: new Date(now).toISOString(), dueAt: new Date(due).toISOString(),
    expiresAt: new Date(Math.min(now + TTL_MS, due + STALE_DUE_MS)).toISOString(), tries: 0, lastMentionedAt: null,
  };
  list.push(item);
  kvSetJson(KEY, list.slice(-MAX_OPEN));
  addEvent('intention', '她记下一件自己想做的事', { text: item.text });
  return item;
}

export function listIntentions({ limit = 6, forPrompt = false } = {}) {
  return read().filter((item) => !forPrompt || !item.lastMentionedAt || Date.now() - Date.parse(item.lastMentionedAt) >= STALE_DUE_MS)
    .sort((a, b) => Date.parse(a.dueAt || a.createdAt) - Date.parse(b.dueAt || b.createdAt))
    .slice(0, Math.max(0, Number(limit) || 0));
}

export function completeIntention(id, note = '') {
  const list = readRaw();
  const done = list.find((item) => item.id === id);
  if (!done) return false;
  kvSetJson(KEY, list.filter((item) => item.id !== id));
  addEvent('intention_done', '她那件惦记的事办完了', { text: done.text, note: String(note).slice(0, 60) });
  return true;
}

export function bumpIntention(id) {
  const list = readRaw();
  const item = list.find((item) => item.id === id);
  if (!item) return false;
  item.tries = Number(item.tries || 0) + 1;
  item.lastMentionedAt = nowIso();
  kvSetJson(KEY, list);
  return true;
}

export function pickDueIntention() {
  return listIntentions({ limit: MAX_OPEN, forPrompt: true }).find((item) => Date.parse(item.dueAt || item.createdAt) <= Date.now()) || null;
}
