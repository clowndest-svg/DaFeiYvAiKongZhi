import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, kvGetJson, kvSetJson } from './db.js';
import { paths } from './config.js';
import { logger } from './logger.js';
import { forgettingCurve, memoryStrength, memoryHalfLifeDays, memoryRemainingHalfDays } from './forgetting.js';
import { listSenses } from './senses.js';
import { clamp } from './util.js';

const LINK_KEY = 'brain_links';

export const LINK_KINDS = {
  recall: '检索时把回忆和这句话连上',
  quote: '引用了他的原话',
  compaction: '把长对话压成摘要',
  handover: '写交接信',
  diary: '写当天日记',
  weekly: '写周记',
  reflect: '事后反思新增记忆',
  intention: '惦记的事被提起',
  sense: '记下一条感官经历',
  look: '摄像头看到的画面进了对话',
};

const MOOD_GROUPS = {
  开心得冒泡: '兴奋',
  有点兴奋: '兴奋',
  元气满满: '元气',
  心情不错: '元气',
  懒懒的温柔: '温柔',
  平静: '平静',
  有点好奇: '平静',
  闷闷的: '低落',
  委屈巴巴: '低落',
  有点小别扭: '烦躁',
  困困的: '困倦',
};

/** 只在真的发生关联时 +1；写失败不影响主流程。 */
export function noteBrainLink(kind, count = 1) {
  if (!Object.hasOwn(LINK_KINDS, String(kind))) return false;
  try {
    const stored = kvGetJson(LINK_KEY, {});
    const links = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    const step = clamp(Number(count) || 1, 1, 20);
    links[kind] = Math.max(0, clamp(Number(links[kind]) || 0, 0, 1e9) + step);
    kvSetJson(LINK_KEY, links);
    return true;
  } catch (error) {
    logger.warn('大脑连接计数没记上', { error: error.message, kind });
    return false;
  }
}

export function brainLinks() {
  const stored = kvGetJson(LINK_KEY, {});
  const links = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const out = {};
  for (const kind of Object.keys(LINK_KINDS)) out[kind] = Math.max(0, Number(links[kind]) || 0);
  return out;
}

function countTable(name) {
  try {
    return Number(getDb().prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()?.n || 0);
  } catch {
    return 0;
  }
}

function moodMix() {
  try {
    const rows = getDb().prepare('SELECT label, COUNT(*) AS n FROM moods GROUP BY label').all();
    if (!rows.length) return null;
    const grouped = new Map();
    let total = 0;
    for (const row of rows) {
      const group = MOOD_GROUPS[String(row.label || '')] || '其他';
      const n = Number(row.n) || 0;
      grouped.set(group, (grouped.get(group) || 0) + n);
      total += n;
    }
    if (!total) return null;
    return [...grouped.entries()]
      .map(([group, count]) => ({ group, count, ratio: Math.round((count / total) * 1000) / 1000 }))
      .sort((a, b) => b.count - a.count);
  } catch {
    return null;
  }
}

function dirCount(dir, pattern) {
  try {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((name) => pattern.test(name)).length;
  } catch {
    return 0;
  }
}

function personaAnchor() {
  let text = '';
  try {
    text = fs.readFileSync(paths.persona, 'utf8');
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  return {
    sha256: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12),
    chars: text.length,
    file: path.basename(paths.persona),
    momLetter: (() => {
      try {
        return Boolean(fs.readFileSync(paths.momLetter, 'utf8').trim());
      } catch {
        return false;
      }
    })(),
    backups: dirCount(path.join(paths.data, 'backups'), /^bizhi-.*\.db$/),
    updatedAt: (() => {
      try {
        return fs.statSync(paths.persona).mtime.toISOString();
      } catch {
        return null;
      }
    })(),
  };
}

function forgettingSamples(limit = 8) {
  let rows = [];
  try {
    rows = getDb()
      .prepare("SELECT * FROM memories WHERE layer IN ('core','mid') ORDER BY importance DESC, updated_at DESC LIMIT ?")
      .all(clamp(Number(limit) || 8, 1, 30));
  } catch {
    return [];
  }
  const now = Date.now();
  return rows.map((row) => ({
    id: Number(row.id),
    layer: String(row.layer),
    content: String(row.content || '').slice(0, 60),
    importance: Number(row.importance) || 0,
    useCount: Number(row.use_count) || 0,
    strength: Math.round(memoryStrength(row, now) * 1000) / 1000,
    halfLifeDays: Math.round(memoryHalfLifeDays(row) * 10) / 10,
    remainingDays: memoryRemainingHalfDays(row, now),
    updatedAt: row.updated_at,
  }));
}

/** 全部数字来自库里真实计数；没有数据的项目返回 null，前端显示「无读数」。 */
export function brainStats({ now = new Date() } = {}) {
  let layers = { core: 0, mid: 0, long: 0 };
  try {
    layers = kvLayers();
  } catch (error) {
    logger.warn('读记忆分层计数失败', { error: error.message });
  }
  const links = brainLinks();
  const linkTotal = Object.values(links).reduce((sum, n) => sum + n, 0);
  const messages = countTable('messages');
  const sessions = countTable('sessions');
  const memoryTotal = layers.core + layers.mid + layers.long;
  const senses = listSenses({ limit: 24 });
  return {
    measuredAt: now.toISOString(),
    nodes: {
      memories: memoryTotal || null,
      core: layers.core || null,
      mid: layers.mid || null,
      long: layers.long || null,
      messages: messages || null,
      sessions: sessions || null,
      diaries: dirCount(paths.daily, /^DAILY-.*\.md$/) || null,
      weeklies: dirCount(paths.weekly, /^WEEK.*\.md$/) || null,
      letters: dirCount(paths.letters, /^LETTER-.*\.md$/) || null,
      senses: senses.length || null,
    },
    links: { ...links, total: linkTotal || null },
    moodMix: moodMix(),
    personality: personaAnchor(),
    forgetting: {
      samples: forgettingSamples(8),
      curve: null,
    },
  };
}

function kvLayers() {
  const rows = getDb().prepare('SELECT layer, COUNT(*) AS n FROM memories GROUP BY layer').all();
  const out = { core: 0, mid: 0, long: 0 };
  for (const row of rows) {
    if (Object.hasOwn(out, row.layer)) out[row.layer] = Number(row.n) || 0;
  }
  return out;
}

/** 给前端画曲线用：挑一条真实记忆，往后推 90 天。 */
export function curveForMemory(id, { days = 90, points = 16 } = {}) {
  const row = (() => {
    try {
      return getDb().prepare('SELECT * FROM memories WHERE id = ?').get(Number(id));
    } catch {
      return null;
    }
  })();
  if (!row) return null;
  return {
    id: Number(row.id),
    content: String(row.content || '').slice(0, 80),
    curve: forgettingCurve(row, { days, points }),
  };
}
