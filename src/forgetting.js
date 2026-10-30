import { clamp } from './util.js';

const DAY_MS = 86400000;
const MIN_HALF_LIFE_DAYS = 2;
const MAX_STRENGTH = 1.5;

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 半衰期：越重要、越常被想起，记得越久。纯函数，不读库。 */
export function memoryHalfLifeDays({ importance = 3, useCount = 0 } = {}) {
  const imp = clamp(finite(importance, 3), 1, 5);
  const uses = Math.max(0, finite(useCount, 0));
  const days = 12 * (0.5 + imp * 0.35) * (1 + Math.min(2, uses * 0.25));
  return Math.max(MIN_HALF_LIFE_DAYS, days);
}

/**
 * 记忆强度（拟人遗忘曲线）：按半衰期指数衰减，重要性和召回次数抬底。
 * 返回 0..1.5，1 附近表示“现在还想得起来很清楚”。
 */
export function memoryStrength(memory = {}, now = Date.now()) {
  const at = Date.parse(memory.updated_at || memory.created_at || '');
  const ageDays = Number.isFinite(at) ? Math.max(0, (now - at) / DAY_MS) : 0;
  const halfLife = memoryHalfLifeDays({
    importance: memory.importance,
    useCount: memory.use_count ?? memory.useCount,
  });
  const imp = clamp(finite(memory.importance, 3), 1, 5);
  const uses = Math.max(0, finite(memory.use_count ?? memory.useCount, 0));
  const decay = Math.exp(-ageDays / halfLife);
  const floor = (0.4 + imp * 0.15) * (1 + Math.min(0.6, uses * 0.05));
  return clamp(decay * floor, 0, MAX_STRENGTH);
}

/** 距离“忘掉一半”还要多少天（以最后一次更新为起点）。 */
export function memoryRemainingHalfDays(memory = {}, now = Date.now()) {
  const halfLife = memoryHalfLifeDays({
    importance: memory.importance,
    useCount: memory.use_count ?? memory.useCount,
  });
  const at = Date.parse(memory.updated_at || memory.created_at || '');
  const ageDays = Number.isFinite(at) ? Math.max(0, (now - at) / DAY_MS) : 0;
  return Math.max(0, Math.round((halfLife - ageDays) * 10) / 10);
}

/** 画遗忘曲线用的样本点：t 为「从现在起再过多少天」，起点用这条记忆当前的参数。 */
export function forgettingCurve(memory = {}, { days = 60, points = 13 } = {}) {
  const total = clamp(Number(days) || 60, 7, 365);
  const count = clamp(Number(points) || 13, 5, 40);
  const start = Date.now();
  const probe = { ...memory, updated_at: new Date(start).toISOString(), created_at: new Date(start).toISOString() };
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const ageDays = (total * i) / (count - 1);
    out.push({
      ageDays: Math.round(ageDays * 10) / 10,
      strength: Math.round(memoryStrength(probe, start + ageDays * DAY_MS) * 1000) / 1000,
    });
  }
  return out;
}

export { DAY_MS };
