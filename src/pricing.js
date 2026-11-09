// USD per million tokens, checked against DeepSeek's official pricing on 2026-11-09.
// Holiday dates follow the State Council's published 2026 schedule.
const HOLIDAYS_2026 = [
  ['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'],
  ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07'],
];

export function officialRate(model, at = new Date()) {
  const local = new Date(new Date(at).getTime() + 8 * 3600000);
  const date = local.toISOString().slice(0, 10);
  const year = local.getUTCFullYear();
  const holiday = year === 2026 && HOLIDAYS_2026.some(([start, end]) => date >= `2026-${start}` && date <= `2026-${end}`);
  const hour = local.getUTCHours();
  const weekday = local.getUTCDay() >= 1 && local.getUTCDay() <= 5;
  const peak = weekday && !holiday && (hour >= 9 && hour < 12 || hour >= 14 && hour < 18);
  const pro = model === 'deepseek-v4-pro';
  const flash = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model);
  if (!pro && !flash) return null;
  const factor = peak ? 2 : 1;
  const base = pro ? { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 } : { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 };
  return {
    cacheHit: base.cacheHit * factor, cacheMiss: base.cacheMiss * factor, output: base.output * factor,
    usdToCny: 7.15,
    version: `deepseek-20261109-${peak ? 'peak' : 'offpeak'}${year === 2026 ? '' : '-calendar-estimate'}-fx-estimate`,
  };
}
