const BACKGROUND_TASKS = new Set(['reflect', 'compact', 'handover']);

export function boundedBackground(kind = '') {
  return BACKGROUND_TASKS.has(String(kind).split(':')[0]);
}

export function chatThinking(text, settings) {
  const mode = settings.model?.thinkingMode || 'adaptive';
  if (mode === 'enabled') return true;
  if (mode === 'disabled') return false;
  return /推导|证明|解题|计算|排查|调试|代码|算法|架构|详细分析|制定.*方案|逐步分析|debug|algorithm|derive|prove|architecture|\bcode\b|traceback/i.test(text || '');
}
