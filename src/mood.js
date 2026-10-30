import { addMood, latestMood } from './db.js';
import { getNeuro } from './neuro.js';
import { clamp, localHour, nowIso } from './util.js';

const DEFAULT_MOOD = {
  valence: 0.35,
  energy: 0.65,
  affection: 20,
  label: '有点好奇',
  reason: '刚认识，还在观察他',
};

function circadianEnergy(date = new Date()) {
  const hour = localHour(date);
  if (hour < 6) return 0.18;
  if (hour < 8) return 0.38;
  if (hour < 11) return 0.72;
  if (hour < 14) return 0.82;
  if (hour < 16) return 0.6;
  if (hour < 20) return 0.78;
  if (hour < 23) return 0.55;
  return 0.32;
}

export function moodLabel({ valence, energy }) {
  const v = Number(valence);
  const e = Number(energy);
  if (v >= 0.6 && e >= 0.6) return '开心得冒泡';
  if (v >= 0.3 && e >= 0.6) return '元气满满';
  if (v >= 0.3 && e < 0.35) return '懒懒的温柔';
  if (v >= 0.2) return '心情不错';
  if (v <= -0.55) return '委屈巴巴';
  if (v <= -0.3 && e >= 0.5) return '有点小别扭';
  if (v <= -0.3) return '闷闷的';
  if (e < 0.3) return '困困的';
  if (e > 0.75) return '有点兴奋';
  return '平静';
}

function shiftMood(base, tone) {
  const valence = clamp(base.valence + tone.valenceBias, -1, 1);
  const energy = clamp(base.energy + tone.energyBias, 0, 1);
  if (valence === base.valence && energy === base.energy) return { ...base, neuro: tone };
  return { ...base, valence, energy, label: moodLabel({ valence, energy }), neuro: tone };
}

function readMood(now = new Date(), { applyNeuro = false } = {}) {
  const row = latestMood();
  const targetEnergy = circadianEnergy(now);
  const base = !row
    ? { ...DEFAULT_MOOD, energy: targetEnergy, created_at: nowIso() }
    : (() => {
        const created = new Date(row.created_at || 0).getTime();
        const ageHours = Number.isFinite(created) ? Math.max(0, (now.getTime() - created) / 3600000) : 24;
        // 心情会回落：几个小时后还带着“他说晚安”的语气就不像人了。
        const valencePull = Math.min(1, ageHours / 8) * 0.6;
        const energyPull = Math.min(1, ageHours / 4) * 0.8;
        const valence = clamp(Number(row.valence) + (0.25 - Number(row.valence)) * valencePull, -1, 1);
        const energy = clamp(Number(row.energy) + (targetEnergy - Number(row.energy)) * energyPull, 0, 1);
        return {
          valence,
          energy,
          affection: Number(row.affection),
          label: moodLabel({ valence, energy }),
          reason: ageHours <= 2 ? String(row.reason || '') : '',
          created_at: row.created_at,
        };
      })();
  if (!applyNeuro) return base;
  let tone;
  try {
    tone = getNeuro({ now });
  } catch {
    return base;
  }
  if (!tone.enabled) return base;
  return shiftMood(base, tone.tone);
}

export function getMood(now = new Date()) {
  return readMood(now, { applyNeuro: true });
}

/** 不带递质影响的“账面上的心情”，写库时用这个，避免自我放大。 */
export function getMoodRaw(now = new Date()) {
  return readMood(now, { applyNeuro: false });
}

export function applyMood(update = {}, { reason = '', sessionId = null } = {}) {
  const current = getMoodRaw();
  const targetValence = Number.isFinite(Number(update.valence)) ? Number(update.valence) : current.valence;
  const targetEnergy = Number.isFinite(Number(update.energy)) ? Number(update.energy) : current.energy;
  // 情绪有惯性：单轮只走 35%，避免一句好话就飘上天、一句重话就崩
  const valence = clamp(current.valence + (targetValence - current.valence) * 0.35, -1, 1);
  const energy = clamp(current.energy + (targetEnergy - current.energy) * 0.35, 0, 1);
  const affection = clamp(current.affection + (Number(update.affection_delta) || 0), 0, 100);
  const label = moodLabel({ valence, energy });
  const why = String(update.reason || reason || '').slice(0, 120);

  const changed =
    Math.abs(valence - current.valence) > 0.02 ||
    Math.abs(energy - current.energy) > 0.03 ||
    Math.abs(affection - current.affection) >= 0.5;

  if (changed) {
    addMood({ valence, energy, affection, label, reason: why, sessionId });
  }
  return { valence, energy, affection, label, reason: why, created_at: nowIso() };
}

export function moodPrompt(mood) {
  return `${mood.label}（愉悦 ${mood.valence.toFixed(2)} / 精力 ${mood.energy.toFixed(2)} / 亲密度 ${Math.round(mood.affection)}）。${mood.reason ? `原因：${mood.reason}。` : ''}用语气自然表达，不要说出这些数值。`;
}

export function affectionLabel(value) {
  const n = Number(value) || 0;
  if (n >= 85) return '很在乎你';
  if (n >= 65) return '很喜欢你';
  if (n >= 45) return '黏你';
  if (n >= 25) return '亲近';
  return '刚熟悉';
}
