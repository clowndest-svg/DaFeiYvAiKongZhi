// DeepSeek 官方 Search / Fetch 接口（2026-11-01 上线，用同一个 API Key 直接 POST）。
// 为什么值得从"扒 Bing HTML"换过来：结果自带可信度分数（rerank_score 0～3，≥1.5 算优质）、
// 权威性、发布时间和 600～800 字的长摘要，不用再靠正则猜哪条是正主。
//
// 三条硬规矩：
// 1) 按次收钱（5 元/1000 次成功请求），只有"HTTP 200 且真拿到结果"才记账，失败与空结果不记；
// 2) 分数不够的当成不可信，宁可回落到免费抓取，也不把低质量页当资料喂给她；
// 3) 只重试官方点名的 408/429/5xx；401/402/400 改了请求或充钱才有意义，重试只是白烧额度。

import { env } from './config.js';
import { addCost } from './db.js';
import { logger } from './logger.js';

export const PRICE_PER_REQUEST_CNY = 5 / 1000;
export const QUALITY_SCORE = 1.5;
const RETRY_STATUS = new Set([408, 429, 500, 504]);
const SEARCH_PATH = '/v1/tools/search';
const FETCH_PATH = '/v1/tools/fetch';

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function toolSearchConfigured() {
  return Boolean(env.apiKey);
}

function errorHint(status, payload) {
  const message = text(payload?.error?.message, 120);
  if (status === 401) return `DeepSeek Key 不通（401）${message ? '：' + message : ''}`;
  if (status === 402) return 'DeepSeek 余额不足（402），充钱之前她查不了';
  if (status === 403) return '被 DeepSeek 安全策略拒了（403）';
  if (status === 404) return '这个地址抓不到正文（404）';
  if (status === 408) return 'DeepSeek 读请求体超时（408）';
  if (status === 413) return '请求体太大（413）';
  if (status === 429) return 'DeepSeek 搜索每秒请求数超了（429）';
  if (status === 500) return 'DeepSeek 搜索服务端错误（500）';
  if (status === 504) return 'DeepSeek 上游超时（504）';
  if (status >= 400) return `DeepSeek 返回 HTTP ${status}${message ? '：' + message : ''}`;
  return message || 'DeepSeek 搜索没给原因';
}

// 一次 POST，带超时；网络层错误一律收成 { status: 0 }，不在这里判成败。
async function postOnce(pathname, body, { timeoutMs, fetchImpl }) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetchImpl(env.baseUrl + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    const raw = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    if (!res.ok) return { status: res.status, payload, ok: false };
    return { status: res.status, payload, ok: true };
  } catch (error) {
    const name = String(error?.name || '');
    const why = name === 'TimeoutError' ? `搜索超时（${Math.round(timeoutMs / 1000)} 秒没返回）` : String(error?.message || name || '请求失败').slice(0, 80);
    return { status: 0, payload: null, ok: false, transportError: why };
  }
}

// 只有能改好结果的动作才值得再来一次：官方点名 408/429/5xx。
function shouldRetry(status) {
  return status === 0 || RETRY_STATUS.has(status);
}

async function callTool(pathname, body, { timeoutMs, fetchImpl, wait }) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    last = await postOnce(pathname, body, { timeoutMs, fetchImpl });
    if (last.ok || !shouldRetry(last.status)) return { ...last, attempts: attempt + 1 };
    if (attempt === 0) await wait(700);
  }
  return { ...last, attempts: 2 };
}

export function mapSearchItem(raw) {
  const url = text(raw?.url, 400);
  if (!/^https?:\/\//i.test(url)) return null;
  const score = Number(raw?.rerank_score);
  const summary = text(raw?.summary, 320);
  const snippet = text(raw?.snippet, 200);
  const content = text(raw?.content, 1600);
  return {
    title: text(raw?.title, 160) || '（没有标题）',
    url,
    // 长摘要给模型读，短摘要给界面显示；两个都没有就如实留空。
    snippet: (summary || snippet).slice(0, 320),
    short: snippet,
    // need_content 时要过正文：这是网页版那种"读过原文"的底气，没有就留空去补抓。
    content: content || '',
    score: Number.isFinite(score) ? Number(score.toFixed(2)) : null,
    authority: Number.isFinite(Number(raw?.authority)) ? Number(raw.authority) : null,
    site: text(raw?.site_name, 60),
    date: text(raw?.date, 10),
    source: 'deepseek',
  };
}

// 分数不够不当资料；排序按分数从高到低（-1/null 当最低）。
export function pickQualityResults(payload, { minScore = QUALITY_SCORE, limit = 5 } = {}) {
  const mapped = (Array.isArray(payload?.results) ? payload.results : []).map(mapSearchItem).filter(Boolean);
  const rank = (item) => (item.score == null ? -1 : item.score);
  const sorted = [...mapped].sort((a, b) => rank(b) - rank(a));
  const kept = sorted.filter((item) => rank(item) >= Number(minScore)).slice(0, Math.max(1, Math.min(Number(limit) || 5, 50)));
  return { all: sorted, items: kept, topScore: sorted.length ? rank(sorted[0]) : null };
}

function bill(kind, note) {
  addCost({ model: `deepseek-${kind}`, kind, costCny: PRICE_PER_REQUEST_CNY });
  logger.info('DeepSeek 工具按次记账', { kind, cny: PRICE_PER_REQUEST_CNY, note });
}

// 搜索：{ ok, engine, items, ms, reason, attempts, status }
// 空结果不计费、也不算失败到"引擎坏了"——她要知道的是"网上没匹配到"。
export async function deepseekSearch(query, {
  count = 5,
  limit = count,
  oriQuestion = '',
  minScore = QUALITY_SCORE,
  timeoutMs = 6000,
  needContent = false,
  fetchImpl = globalThis.fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const started = Date.now();
  const engine = 'deepseek';
  if (!env.apiKey) return { ok: false, engine, items: [], reason: '还没配 DeepSeek Key', unavailable: true, ms: 0 };
  const q = text(query, 128);
  if (q.length < 2) return { ok: false, engine, items: [], reason: '没摘出要查的词', ms: 0 };

  const body = { query: q, count: Math.max(1, Math.min(50, Number(count) || 5)) };
  const ori = text(oriQuestion, 128);
  if (ori) body.ori_question = ori;
  if (needContent) body.need_content = true;

  const result = await callTool(SEARCH_PATH, body, { timeoutMs, fetchImpl, wait });
  const ms = Date.now() - started;
  if (!result.ok) {
    const reason = result.transportError || errorHint(result.status, result.payload);
    return { ok: false, engine, items: [], reason, status: result.status, attempts: result.attempts, ms };
  }
  const { all, items, topScore } = pickQualityResults(result.payload, { minScore, limit });
  // 计费只看上游有没有给出结果，跟我们留不留无关：200 + results 非空就要付这一次钱。
  if (all.length) bill('search', topScore == null ? '' : `最高 ${topScore} 分`);
  if (!all.length) return { ok: false, engine, items: [], reason: '搜索引擎没有匹配结果', empty: true, attempts: result.attempts, ms };
  if (!items.length) {
    return {
      ok: false, engine, items: [], all,
      reason: `搜到 ${all.length} 条但可信度都低（最高 ${topScore == null ? '?' : topScore} 分，门槛 ${minScore}）`,
      lowQuality: true, attempts: result.attempts, ms,
    };
  }
  logger.info('DeepSeek 搜索成功', { count: items.length, ms, topScore });
  return { ok: true, engine, items, attempts: result.attempts, ms };
}

// 读网页：正文交给调用方截断，这里只如实报"拿到了多少字"。
export async function deepseekFetch(url, {
  timeoutMs = 8000,
  maxChars = 6000,
  fetchImpl = globalThis.fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const started = Date.now();
  if (!env.apiKey) return { ok: false, reason: '还没配 DeepSeek Key', unavailable: true, ms: 0 };
  const target = String(url || '').trim();
  if (!isPublicHttpUrl(target)) return { ok: false, reason: '这个地址不像能公开访问的网页，我不发出去', refused: true, ms: 0 };

  const result = await callTool(FETCH_PATH, { url: target }, { timeoutMs, fetchImpl, wait });
  const ms = Date.now() - started;
  if (!result.ok) {
    return { ok: false, reason: result.transportError || errorHint(result.status, result.payload), status: result.status, attempts: result.attempts, ms };
  }
  const content = String(result.payload?.content || '');
  const title = text(result.payload?.title, 160);
  if (!content.trim()) return { ok: false, reason: '这页没有可提取的正文', empty: true, title, attempts: result.attempts, ms };
  bill('fetch', `${content.length} 字`);
  const cap = Math.max(400, Math.min(Number(maxChars) || 6000, 20000));
  return { ok: true, url: target, title, content: content.slice(0, cap), fullChars: content.length, truncated: content.length > cap, attempts: result.attempts, ms };
}

// 只允许公网可访问的 http(s) 地址：本机、内网、带账号密码的 URL 一律不发出去
// （既是不泄露，也是因为那类地址本来就不该让外部服务替我们打开）。
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const PRIVATE_V4 = /^((127|0|10)\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function isPublicHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 8192) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (IPV4.test(host)) return !PRIVATE_V4.test(host);
  if (/^[0-9a-f:]+$/.test(host) && host.includes(':')) return false; // IPv6 字面量：::1、fe80:、fd00: 一律不碰
  // 裸 localhost 走下面"必须带点"那条；带后缀的 foo.localhost / .internal 是内网常见写法，单独挡掉。
  if (/\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return false;
  // 没有点的是内网单机名（nas、fileserver…），公网解析不到，也不该发出去。
  return host.includes('.') && !host.endsWith('.');
}

export function toolPricing() {
  return { pricePerRequestCny: PRICE_PER_REQUEST_CNY, qualityScore: QUALITY_SCORE, retryStatus: [...RETRY_STATUS].sort() };
}
