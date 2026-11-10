// 一处解析「聊天用哪个接口、哪个 Key、哪个模型」：控制台设置优先，.env 兜底。
// 搜索/读页/余额这些 DeepSeek 专属能力，只在接口确实是官方地址时才走。
import { env, loadSettings } from './config.js';

export const API_KEY_MASK = '••••••••';

export function isOfficialDeepSeekBase(baseUrl) {
  try {
    const host = new URL(String(baseUrl || '')).hostname.toLowerCase();
    return host === 'api.deepseek.com' || host.endsWith('.deepseek.com');
  } catch {
    return false;
  }
}

export function resolveModelRuntime(defaults = {}) {
  let model = {};
  try { model = loadSettings().model || {}; } catch { /* 设置读不到就用默认值 */ }
  const baseUrl = String(model.apiBase || '').trim().replace(/\/+$/, '') || defaults.baseUrl || env.baseUrl;
  const apiKey = String(model.apiKey || '').trim() || defaults.apiKey || env.apiKey;
  return {
    baseUrl,
    apiKey,
    model: String(model.name || '').trim() || defaults.model || env.defaultModel || 'deepseek-flash',
    officialDeepSeek: isOfficialDeepSeekBase(baseUrl),
  };
}

// 给控制台的设置副本把 Key 换成掩码；保存时把掩码还原成原来的 Key。
export function maskSettingsKey(settings) {
  if (!settings?.model || !settings.model.apiKey) return settings;
  return { ...settings, model: { ...settings.model, apiKey: API_KEY_MASK } };
}

export function restoreMaskedKey(incoming, previous) {
  const next = incoming || {};
  if (!next.model) return next;
  const value = String(next.model.apiKey ?? '');
  if (value !== API_KEY_MASK) return next;
  return { ...next, model: { ...next.model, apiKey: String(previous?.model?.apiKey || '') } };
}
