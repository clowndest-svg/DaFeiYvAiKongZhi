import { addEvent, costSummary, kvGetJson, kvSetJson } from './db.js';
import { loadSettings } from './config.js';
import { logger } from './logger.js';
import { nowIso, shanghaiDayKey } from './util.js';
import { costReservationStatus } from './cost-reservations.js';

// 名单和消费点必须两边对上（tests/budget-gate.test.js 会逐条核对）：
// 漏注册 = 熔断线到了它还照样花钱；注册了没人查 = 名单上写着暂停，其实没人执行。
export const COST_FEATURES = ['proactive', 'selfFollowUp', 'voice', 'xhsAuto', 'xAuto', 'qzoneAuto', 'douyinAuto', 'look', 'daily', 'weekly', 'dream', 'reflect', 'compact', 'handover', 'search'];
// 余额低只停"她自己主动花"的部分；回他、看他发来的东西、帮他查资料照旧。
export const LOW_BALANCE_PAUSE = ['voice', 'xhsAuto', 'xAuto', 'qzoneAuto', 'douyinAuto', 'dream', 'weekly', 'reflect'];

export function evaluateBudget({ balanceCny = null, todayCostCny = 0, settings }) {
  const cost = settings?.cost || {};
  const low = Math.max(0.1, Number(cost.lowBalanceCny ?? 5));
  const stop = Math.max(0, Number(cost.stopBalanceCny ?? 1.5));
  const dailyCap = Math.max(0, Number(cost.maxDailyCostCny ?? 3));
  const spent = Math.max(0, Number(todayCostCny) || 0);
  const value = balanceCny != null && Number.isFinite(Number(balanceCny)) ? Number(balanceCny) : null;
  const capped = dailyCap > 0 && spent >= dailyCap;
  const blocked = new Set();
  const reasons = [];
  if (value !== null && value <= stop) {
    COST_FEATURES.forEach((feature) => blocked.add(feature));
    reasons.push(`余额只剩 ${value.toFixed(2)} 元，熔断线 ${stop} 元：只留着回你，额外动作暂停`);
  } else if (value !== null && value <= low) {
    LOW_BALANCE_PAUSE.forEach((feature) => blocked.add(feature));
    reasons.push(`余额 ${value.toFixed(2)} 元低于 ${low} 元：暂停语音和自动运营，主动间隔拉长`);
  }
  if (capped) {
    COST_FEATURES.forEach((feature) => blocked.add(feature));
    reasons.push(`今天已经花了 ${spent.toFixed(2)} 元，到你设的上限 ${dailyCap} 元：额外花费型动作暂停`);
  }
  if (value === null) reasons.push('余额还没读到（本地日账单上限仍然生效）');
  return {
    level: capped || value !== null && value <= stop ? 'stop' : blocked.size ? 'low' : value === null ? 'unknown' : 'normal',
    blocked: [...blocked], reasons, balanceCny: value, todayCostCny: spent, low, stop, dailyCap,
    day: shanghaiDayKey(), checkedAt: nowIso(),
  };
}

export function writeCostState(state) {
  kvSetJson('cost_state', { ...state, at: nowIso() });
  return state;
}

export function readCostState() {
  const raw = kvGetJson('cost_state', null);
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const reservations = costReservationStatus();
  const settled = costSummary(1).todayCostCny;
  const current = evaluateBudget({ balanceCny: stored.balanceCny ?? null, todayCostCny: settled + reservations.pendingEstimateCny, settings: loadSettings() });
  if (reservations.pendingCount) current.reasons.push(`含 ${reservations.pendingCount} 笔未结算费用预留，估计 ${reservations.pendingEstimateCny.toFixed(4)} 元；需对账后结算，不会自动归零`);
  return { ...current, todaySettledCostCny: settled, pendingEstimateCny: reservations.pendingEstimateCny, pendingCount: reservations.pendingCount, checkedAt: stored.checkedAt || stored.at || null, balanceStale: !stored.at || Date.now() - Date.parse(stored.at) > 20 * 60000 };
}

export function costBlocked(feature, state = readCostState()) {
  return Array.isArray(state.blocked) && state.blocked.includes(feature);
}

export function noteCostSkip(feature, reason) {
  const key = `cost_skip_notified:${shanghaiDayKey()}:${feature}`;
  if (kvGetJson(key, null)) return false;
  kvSetJson(key, { at: nowIso(), reason });
  logger.warn('花费熔断挡下了这个动作', { feature, reason });
  addEvent('cost_blocked', `省钱模式：${feature} 这次不做了`, { reason, feature });
  return true;
}
