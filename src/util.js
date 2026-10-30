import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  let han = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) han += 1;
    else other += 1;
  }
  return Math.ceil(han * 0.9 + other / 3.5);
}

export function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => {
    if (typeof m.content === 'string') return sum + estimateTokens(m.content) + 4;
    if (Array.isArray(m.content)) {
      return sum + 4 + m.content.reduce((s, part) => {
        if (part.type === 'text') return s + estimateTokens(part.text);
        return s + 800;
      }, 0);
    }
    return sum + 4;
  }, 0);
}

export function parseJsonLoose(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(fenced.slice(start, end + 1));
  }
  return JSON.parse(fenced);
}

export function stripWrappingQuotes(text) {
  return String(text ?? '')
    .trim()
    .replace(/^["“”'‘’]+/, '')
    .replace(/["“”'‘’]+$/, '')
    .trim();
}

export function stripMarkdownLite(text) {
  return String(text ?? '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#+\s*/gm, '')
    .trim();
}

export function splitForQQ(text, maxLen = 180, maxChunks = 12) {
  const s = String(text ?? '');
  if (!s.trim()) return [];
  if (s.length <= maxLen) return [s.trim()];
  const parts = s.split(/(?<=[。！？!?~～…\n])/).filter((part) => part.length > 0);
  const chunks = [];
  let current = '';
  for (const part of parts) {
    let rest = part;
    while (rest.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(rest.slice(0, maxLen));
      rest = rest.slice(maxLen);
    }
    if (!rest) continue;
    if (!current) current = rest;
    else if (current.length + rest.length <= maxLen) current += rest;
    else {
      chunks.push(current);
      current = rest;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length > maxChunks) {
    return chunks.map((chunk) => chunk.trim()).filter(Boolean);
  }
  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}

export function hashText(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

export function normalizeMemoryText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function keywordSet(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  const ascii = s.match(/[a-z0-9_]{2,}/g) || [];
  for (const w of ascii) out.add(w);
  const hanRuns = s.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of hanRuns) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2));
  }
  return out;
}

export function overlapScore(querySet, text) {
  if (!querySet.size) return 0;
  const target = keywordSet(text);
  if (!target.size) return 0;
  let hit = 0;
  for (const k of querySet) if (target.has(k)) hit += 1;
  return hit / Math.sqrt(querySet.size * target.size);
}

export function formatLocal(date = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    hour12: false,
  }).format(date);
}

export function localHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return hour + minute / 60;
}

export function parseClock(value, fallback) {
  const m = String(value ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? hour + minute / 60 : fallback;
}

export function shanghaiDayKey(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
}

export function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** 上海没有夏令时，固定 +08:00；不依赖运行机器的本地时区。 */
export function shanghaiTimeToIso({ year, month, day, hour = 0, minute = 0 }) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute)).toISOString();
}

export function nextShanghaiClock(hour, minute, now = new Date()) {
  const p = shanghaiParts(now);
  let ts = Date.UTC(p.year, p.month - 1, p.day, hour - 8, minute);
  if (ts <= now.getTime()) ts += 86400000;
  return new Date(ts);
}

export function startOfShanghaiDayIso(now = new Date()) {
  const p = shanghaiParts(now);
  return shanghaiTimeToIso({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 });
}

export function isWithinWindow(start, end, now = new Date()) {
  const s = parseClock(start, 0);
  const e = parseClock(end, 24);
  const h = localHour(now);
  if (s === e) return true;
  if (s < e) return h >= s && h < e;
  return h >= s || h < e;
}

export function relativeTimeCn(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 已重命名或未创建 */ }
  }
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function deepMerge(base, override) {
  if (Array.isArray(override)) return override.slice();
  if (override === null || typeof override !== 'object') {
    return override === undefined ? base : override;
  }
  if (typeof base !== 'object' || base === null || Array.isArray(base)) base = {};
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    out[key] = deepMerge(Object.hasOwn(base, key) ? base[key] : undefined, value);
  }
  return out;
}

export function formatMoneyCny(value) {
  return `¥${Number(value || 0).toFixed(3)}`;
}

export function uniqueBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
