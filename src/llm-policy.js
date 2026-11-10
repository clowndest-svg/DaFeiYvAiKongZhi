const BACKGROUND_TASKS = new Set(['reflect', 'compact', 'handover']);
const SOCIAL_TASKS = new Set(['post', 'comments', 'x_comment', 'x_reply', 'x_post', 'xhs_comment', 'xhs_reply']);

export function boundedBackground(kind = '') {
  return BACKGROUND_TASKS.has(String(kind).split(':')[0]);
}

export function socialTask(kind = '') {
  return SOCIAL_TASKS.has(String(kind).split(':')[0]);
}

export function chatThinking(text, settings) {
  const mode = settings.model?.thinkingMode || 'adaptive';
  if (mode === 'enabled') return true;
  if (mode === 'disabled') return false;
  return /推导|证明|解题|计算|排查|调试|代码|算法|架构|详细分析|制定.*方案|逐步分析|debug|algorithm|derive|prove|architecture|\bcode\b|traceback/i.test(text || '');
}
