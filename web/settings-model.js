export const SETTINGS_CARDS = {
  identity: ['identity', 'persona'], chat: ['model', 'memory', 'search'], proactive: ['proactive'],
  voice: ['voice', 'rvc', 'presence'], qq: ['qq-login', 'qq'], social: ['social'],
  xhs: ['xhs'], x: ['x'], system: ['background', 'ui', 'data', 'sentinel'],
};

export function settingsScopePatch(values, scope) {
  if (scope === 'all') return values;
  const domains = { identity: ['companion'], chat: ['model', 'memory', 'search'], voice: ['tts', 'presence'], qq: ['qq'], system: ['ui', 'cost'] };
  const patch = Object.fromEntries((domains[scope] || []).map(key => [key, values[key]]));
  if (scope === 'chat' || scope === 'proactive') patch.proactive = Object.fromEntries(Object.entries(values.proactive).filter(([key]) => ['dreamEnabled', 'dreamHour'].includes(key) === (scope === 'chat')));
  if (['social', 'x', 'xhs'].includes(scope)) patch.social = Object.fromEntries(Object.entries(values.social).filter(([key]) => scope === 'xhs' ? key.startsWith('xhs') : scope === 'x' ? key.startsWith('x') && !key.startsWith('xhs') : !key.startsWith('x')));
  return patch;
}

export function catalogPage(models, { query = '', filter = 'all', selected = '', page = 0, size = 6 } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  const matches = models.filter(model => (!needle || `${model.title} ${model.family}`.toLocaleLowerCase().includes(needle)) && (filter !== 'ready' || model.available) && (filter !== 'selected' || model.id === selected));
  const pages = Math.max(1, Math.ceil(matches.length / size));
  const current = Math.max(0, Math.min(page, pages - 1));
  return { items: matches.slice(current * size, (current + 1) * size), page: current, pages, total: matches.length };
}
