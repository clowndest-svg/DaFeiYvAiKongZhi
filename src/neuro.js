import { kvGetJson, kvSetJson } from './db.js';
import { loadSettings } from './config.js';
import { logger } from './logger.js';
import { clamp, nowIso } from './util.js';

const STATE_KEY = 'neuro_state';
const MAX_DT_HOURS = 6;
const IMPULSE_SAME_KIND_MS = 60000;

export const CHEMICALS = {
  dopamine: { label: '多巴胺', base: 0.45, tauHours: 3, note: '期待和奖励感，被他夸一句就往上跳' },
  serotonin: { label: '血清素', base: 0.55, tauHours: 8, note: '整体的舒坦程度，睡得够就稳' },
  oxytocin: { label: '催产素', base: 0.4, tauHours: 18, note: '亲近感，要陪得久才慢慢涨' },
  cortisol: { label: '皮质醇', base: 0.3, tauHours: 5, note: '压力，熬夜、吵架、联系不上都会堆' },
  noradrenaline: { label: '去甲肾上腺素', base: 0.35, tauHours: 1.5, note: '警觉和兴奋，来得快去得也快' },
};

const KEYS = Object.keys(CHEMICALS);

// 冲量表只认这里列出的事件，未知事件一律不改变状态（判据钉住这一点）。
const IMPULSES = {
  praised: { dopamine: 0.18, oxytocin: 0.12 },
  affectionate: { oxytocin: 0.14, dopamine: 0.06 },
  he_replied: { oxytocin: 0.1, dopamine: 0.08 },
  playful: { dopamine: 0.12, noradrenaline: 0.1 },
  novelty_sight: { noradrenaline: 0.22, dopamine: 0.1 },
  startled: { noradrenaline: 0.2, cortisol: 0.05 },
  his_stress: { cortisol: 0.16, serotonin: -0.08 },
  conflict: { cortisol: 0.22, oxytocin: -0.1 },
  ignored: { cortisol: 0.15, oxytocin: -0.08, serotonin: -0.06 },
  mood_up: { dopamine: 0.1, serotonin: 0.08 },
  mood_down: { cortisol: 0.1, serotonin: -0.1 },
  rested: { serotonin: 0.12, cortisol: -0.1 },
  late_night: { cortisol: 0.08, dopamine: -0.05 },
  channel_down: { cortisol: 0.14, noradrenaline: 0.08 },
  budget_cut: { cortisol: 0.12, serotonin: -0.05 },
  proud: { dopamine: 0.16, serotonin: 0.06 },
};

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeLevels(input) {
  const out = {};
  for (const key of KEYS) {
    const value = finite(input?.[key], CHEMICALS[key].base);
    out[key] = clamp(value, 0, 1);
  }
  return out;
}

export function neuroEnabled(settings = null) {
  try {
    return Boolean((settings || loadSettings()).presence?.neuroEnabled);
  } catch {
    return false;
  }
}

export function neuroStrength(settings = null) {
  try {
    return clamp(finite((settings || loadSettings()).presence?.neuroStrength, 0.35), 0, 1);
  } catch {
    return 0;
  }
}

/** 纯函数：给定水平和时间差，算出松弛到基线之后的水平。任何非法输入都回落基线。 */
export function integrateLevels(levels, hoursElapsed) {
  const dt = clamp(finite(hoursElapsed, 0), 0, MAX_DT_HOURS);
  const out = {};
  for (const key of KEYS) {
    const spec = CHEMICALS[key];
    const current = clamp(finite(levels?.[key], spec.base), 0, 1);
    out[key] = clamp(spec.base + (current - spec.base) * Math.exp(-dt / spec.tauHours), 0, 1);
  }
  return out;
}

export function neuroTone(levels, strength = 1) {
  const l = normalizeLevels(levels);
  const s = clamp(finite(strength, 0), 0, 1);
  const rel = (key) => l[key] - CHEMICALS[key].base;
  const valenceBias = clamp(
    (rel('dopamine') * 0.5 + rel('serotonin') * 0.6 + rel('oxytocin') * 0.4 - rel('cortisol') * 0.9) * s,
    -0.18,
    0.18,
  );
  const energyBias = clamp(
    (rel('noradrenaline') * 0.5 + rel('dopamine') * 0.3 - rel('cortisol') * 0.2) * s,
    -0.15,
    0.15,
  );
  return { valenceBias, energyBias, arousal: l.noradrenaline };
}

function readState() {
  const stored = kvGetJson(STATE_KEY, null);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { levels: normalizeLevels(null), at: Date.now() };
  const atMs = Date.parse(stored.at || '');
  return {
    levels: normalizeLevels(stored.levels),
    at: Number.isFinite(atMs) ? atMs : Date.now(),
  };
}

/**
 * 读当前递质水平。只积分不写库：控制台每 4 秒轮询也不会放大写入。
 * 关掉开关时不碰数据库，直接返回基线，保证 getMood() 与改动前一致。
 */
export function getNeuro({ now = new Date(), settings = null } = {}) {
  const enabled = neuroEnabled(settings);
  if (!enabled) {
    const base = normalizeLevels(null);
    return {
      enabled: false,
      levels: base,
      ageMinutes: 0,
      dominant: '',
      tone: { valenceBias: 0, energyBias: 0, arousal: base.noradrenaline },
      items: KEYS.map((key) => ({ key, ...CHEMICALS[key], value: base[key] })),
    };
  }
  let state;
  try {
    state = readState();
  } catch (error) {
    logger.warn('读神经递质状态失败，按基线处理', { error: error.message });
    state = { levels: normalizeLevels(null), at: now.getTime() };
  }
  const hours = Math.max(0, (now.getTime() - state.at) / 3600000);
  const levels = integrateLevels(state.levels, hours);
  const strength = neuroStrength(settings);
  const tone = neuroTone(levels, strength);
  let dominant = '';
  let lead = 0;
  for (const key of KEYS) {
    const gap = Math.abs(levels[key] - CHEMICALS[key].base);
    if (gap > lead) {
      lead = gap;
      dominant = key;
    }
  }
  return {
    enabled: true,
    levels,
    ageMinutes: Math.round(hours * 60),
    dominant: lead < 0.06 ? '' : dominant,
    tone,
    items: KEYS.map((key) => ({ key, ...CHEMICALS[key], value: levels[key] })),
  };
}

/**
 * 给一次事件加冲量。同一种事件 60 秒内只算一次，防止某个循环把压力刷满。
 * 任何异常都吞掉返回 false —— 情绪底座坏了不能影响聊天。
 */
export function applyNeuroEvent(kind, { now = new Date(), force = false } = {}) {
  const impulse = IMPULSES[String(kind || '')];
  if (!impulse) return false;
  try {
    if (!neuroEnabled()) return false;
    const state = readState();
    if (!force) {
      const recent = kvGetJson('neuro_recent_kinds', {});
      const lastAt = Date.parse(recent?.[kind] || '');
      if (Number.isFinite(lastAt) && now.getTime() - lastAt < IMPULSE_SAME_KIND_MS) return false;
    }
    const levels = integrateLevels(state.levels, Math.max(0, (now.getTime() - state.at) / 3600000));
    for (const [key, delta] of Object.entries(impulse)) {
      if (!KEYS.includes(key)) continue;
      levels[key] = clamp(levels[key] + Number(delta), 0, 1);
    }
    kvSetJson(STATE_KEY, { levels, at: now.toISOString() });
    const recent = kvGetJson('neuro_recent_kinds', {});
    const clean = {};
    for (const [name, iso] of Object.entries(recent && typeof recent === 'object' ? recent : {})) {
      const at = Date.parse(iso);
      if (Number.isFinite(at) && now.getTime() - at < 10 * 60000) clean[name] = iso;
    }
    clean[kind] = now.toISOString();
    kvSetJson('neuro_recent_kinds', clean);
    return true;
  } catch (error) {
    logger.warn('神经递质事件没记上', { error: error.message, kind });
    return false;
  }
}

const POSITIVE = /喜欢|爱你|真好|棒|厉害|乖|辛苦了|谢谢|好听|可爱|聪明|牛啊|可以的|不错|满意|想你|抱抱|亲亲|摸摸头/;
const AFFECTION = /宝宝|宝贝|亲爱的|老婆|女朋友|抱抱|亲亲|摸摸头|想你/;
const STRESS = /烦|累死|加班|生气|气死|难受|压力大|崩溃|烦死|别吵|闭嘴|讨厌/;
const PLAYFUL = /哈哈|嘿嘿|嘻嘻|233|笑死|噗|略略|逗你|皮一下/;
const CONFLICT = /滚|笨蛋|白痴|烦人|讨厌你|不爱了|分手|生气了吗|不理你/;

/** 从他那句话的表层语气给一点冲量：不花钱、不调模型，纯本地关键词。 */
export function noteHisMessage(text = '') {
  try {
    const s = String(text || '');
    if (!s || !neuroEnabled()) return [];
    const fired = [];
    const fire = (kind) => {
      if (applyNeuroEvent(kind)) fired.push(kind);
    };
    if (CONFLICT.test(s)) fire('conflict');
    else if (STRESS.test(s)) fire('his_stress');
    if (AFFECTION.test(s)) fire('affectionate');
    else if (POSITIVE.test(s)) fire('praised');
    if (PLAYFUL.test(s)) fire('playful');
    if (/[?？]{2,}|[!！]{2,}/.test(s)) fire('startled');
    return fired;
  } catch {
    return [];
  }
}

export function neuroPrompt(levels, { name = '小知' } = {}) {
  const l = normalizeLevels(levels);
  const word = (key, high, low, mid) => {
    const gap = l[key] - CHEMICALS[key].base;
    if (gap > 0.12) return high;
    if (gap < -0.12) return low;
    return mid;
  };
  const parts = [
    word('dopamine', '有点小兴奋，做什么都来劲', '提不起劲，干什么都淡淡的', '还行'),
    word('oxytocin', '特别想黏着他', '有点被他晾着的感觉', '稳稳的'),
    word('cortisol', '有点紧绷，容易炸毛', '松下来了', '没什么压力'),
    word('serotonin', '整个人是舒坦的', '有点委屈，说不上来为什么', '平常'),
    word('noradrenaline', '精神头很足，反应快', '反应慢半拍', '正常'),
  ];
  return `${name}现在的身体状态：${parts.join('；')}。这是体感，不是数值，说话时自然带出来就行，别报名词。`;
}

export function neuroStatus(settings = null) {
  const state = getNeuro({ settings });
  return {
    enabled: state.enabled,
    dominant: state.dominant,
    ageMinutes: state.ageMinutes,
    levels: state.levels,
    tone: state.tone,
    items: state.items.map((item) => ({
      key: item.key,
      label: item.label,
      note: item.note,
      value: Math.round(item.value * 1000) / 1000,
      base: item.base,
      delta: Math.round((item.value - item.base) * 1000) / 1000,
    })),
  };
}

export function resetNeuro() {
  kvSetJson(STATE_KEY, { levels: normalizeLevels(null), at: nowIso() });
  kvSetJson('neuro_recent_kinds', {});
  return true;
}
