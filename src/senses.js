import { addEvent, kvGetJson, kvSetJson } from './db.js';
import { loadSettings } from './config.js';
import { clamp, hashText, nowIso } from './util.js';

const KEY = 'sensory_memory';
const MAX_ITEMS = 24;
const MAX_AGE_DAYS = 30;

export const SENSE_KINDS = {
  taste: { label: '尝到', hint: '味道、口感、吃过什么' },
  smell: { label: '闻到', hint: '气味' },
  touch: { label: '摸到', hint: '触感、温度、抱着什么' },
  sight: { label: '看到', hint: '眼睛或摄像头看到的画面' },
  sound: { label: '听到', hint: '真实听到的声音' },
};

function squash(text) {
  return String(text || '').replace(/[\s，。！？、,.!?~～：:；;“”"'‘’（）()【】\[\]]/g, '');
}

function cleanKind(kind) {
  return Object.hasOwn(SENSE_KINDS, String(kind)) ? String(kind) : '';
}

function readAll() {
  const stored = kvGetJson(KEY, []);
  if (!Array.isArray(stored)) return [];
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  return stored
    .filter((item) => item && typeof item === 'object' && cleanKind(item.kind))
    .filter((item) => {
      const at = Date.parse(item.at || '');
      return Number.isFinite(at) ? at >= cutoff : false;
    })
    .slice(0, MAX_ITEMS);
}

function writeAll(items) {
  kvSetJson(KEY, items.slice(0, MAX_ITEMS));
  return items;
}

export function listSenses({ limit = 12, kind = '' } = {}) {
  const all = readAll();
  const filtered = cleanKind(kind) ? all.filter((item) => item.kind === kind) : all;
  return filtered.slice(0, clamp(Number(limit) || 12, 1, MAX_ITEMS));
}

/**
 * 记一条感官记忆。硬要求：evidence 必须真的出现在他说的话里，
 * 否则她会把没发生过的气味味道当真实经历讲出来。
 */
export function addSense({ kind, text, detail = '', evidence = '', sourceText = '', source = 'chat' } = {}) {
  const cleanKindValue = cleanKind(kind);
  const content = String(text || '').trim().slice(0, 80);
  if (!cleanKindValue || content.length < 2) return { ok: false, reason: 'kind 或正文不合法' };
  if (source === 'camera') {
    // 摄像头看到的是真实输入，不需要他亲口说过。
  } else {
    const normalized = squash(evidence);
    const sourceNorm = squash(sourceText);
    if (normalized.length < 3 || !sourceNorm.includes(normalized)) {
      addEvent('sense_rejected', '想记一条没在他原话里出现过的感官经历，已拒绝', {
        kind: cleanKindValue,
        text: content.slice(0, 40),
        evidence: String(evidence || '').slice(0, 40),
      });
      return { ok: false, reason: '证据不在他的原话里' };
    }
  }
  const item = {
    id: `${cleanKindValue}-${hashText(content).slice(0, 10)}`,
    kind: cleanKindValue,
    text: content,
    detail: String(detail || '').trim().slice(0, 120),
    evidence: String(evidence || '').trim().slice(0, 80),
    source: String(source || 'chat').slice(0, 20),
    at: nowIso(),
  };
  const items = readAll();
  const kept = items.filter((old) => old.id !== item.id);
  writeAll([item, ...kept]);
  return { ok: true, item };
}

export function clearSenses() {
  kvSetJson(KEY, []);
  return true;
}

export function sensesEnabled(settings = null) {
  try {
    return Boolean((settings || loadSettings()).presence?.sensesEnabled);
  } catch {
    return false;
  }
}

export function sensesPrompt(items = []) {
  if (!items.length) return '';
  const lines = items.map((item) => {
    const label = SENSE_KINDS[item.kind]?.label || item.kind;
    const detail = item.detail ? `（${item.detail}）` : '';
    return `- ${label}：${item.text}${detail}，${item.at?.slice(5, 10) || ''}`;
  });
  return `【你的感官记忆（只有真经历过才在里面）】\n${lines.join('\n')}\n清单里没有的味道、气味、画面就是没经历过，别编；里面的也可以不提。`;
}

export function sensesStatus() {
  const items = listSenses({ limit: MAX_ITEMS });
  return {
    enabled: sensesEnabled(),
    count: items.length,
    items: items.map((item) => ({
      kind: item.kind,
      kindLabel: SENSE_KINDS[item.kind]?.label || item.kind,
      text: item.text,
      detail: item.detail,
      source: item.source,
      at: item.at,
    })),
  };
}
