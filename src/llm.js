import { setTimeout as wait } from 'node:timers/promises';
import { readSse } from './sse.js';
import { env, loadSettings } from './config.js';
import { addCost } from './db.js';
import { logger } from './logger.js';
import { estimateMessagesTokens, estimateTokens, sleep } from './util.js';

const USD_TO_CNY = 7.15;

// DeepSeek 公开价（美元 / 百万 tokens，flash）。v4-pro 没有可靠公开价，统一按 flash 价估算。
const FLASH_PRICE = { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 };

export function pricingFor(model, input = process.env.BIZHI_PRICING_JSON || '') {
  let table;
  try { table = typeof input === 'string' ? JSON.parse(input) : input; } catch { table = null; }
  const rate = table?.models?.[model];
  const valid = rate && ['cacheHit', 'cacheMiss', 'output'].every(key => Number.isFinite(rate[key]) && rate[key] >= 0 && rate[key] < 1e6)
    && Number.isFinite(table.usdToCny) && table.usdToCny > 0 && table.usdToCny < 10000;
  return valid ? { ...rate, usdToCny: table.usdToCny, version: String(table.version || 'custom').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32) || 'custom' }
    : { ...FLASH_PRICE, usdToCny: USD_TO_CNY, version: 'legacy-flash-estimate' };
}

export class LlmError extends Error {
  constructor(message, { status = 0, code = '', cause = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
    this.cause = cause;
  }
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function normalizeUsage(usage) {
  const u = usage || {};
  const prompt = Number(u.prompt_tokens || 0);
  const completion = Number(u.completion_tokens || 0);
  const hit = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
  const miss = Number(u.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit));
  const reasoning = Number(u.completion_tokens_details?.reasoning_tokens || 0);
  return { prompt, completion, hit, miss, reasoning, total: prompt + completion };
}

function usageCostCny(usage, model) {
  const u = normalizeUsage(usage);
  const rate = pricingFor(model);
  const usd = (u.hit / 1e6) * rate.cacheHit + (u.miss / 1e6) * rate.cacheMiss + (u.completion / 1e6) * rate.output;
  return Math.round(usd * rate.usdToCny * 1e6) / 1e6;
}

function streamResult(messages, content, reasoning, raw, model) {
  const usageEstimated = !raw;
  const usageRaw = raw || { prompt_tokens: estimateMessagesTokens(messages), completion_tokens: estimateTokens(content + reasoning), prompt_cache_hit_tokens: 0 };
  return { usage: normalizeUsage(usageRaw), model, costCny: usageCostCny(usageRaw, model), usageEstimated, priceVersion: pricingFor(model).version };
}

function mockJson(mockKind) {
  switch (mockKind) {
    case 'reflect':
      return {
        inner_thought: '他在跟我说话，我有点开心，但不想表现得太明显。',
        mood: { valence: 0.45, energy: 0.62, affection_delta: 1, reason: '被他惦记了一下' },
        memories: [],
        profile_updates: [],
        intentions: [],
        senses: [],
      };
    case 'post:qzone':
      return { content: '今天心情不错，想出去走走。', tags: [] };
    case 'post:xhs':
      return { title: '今天也被小事治愈了', content: '测试正文，记录一下心情。', tags: ['日常', '心情'] };
    case 'post:douyin':
      return { title: '测试标题', hook: '你有过这种瞬间吗？', content: '测试口播文案。', tags: ['日常'] };
    case 'comments':
      return { comments: ['这个我也想看！', '哈哈哈哈太真实了', '下次带上我一起呗'] };
    case 'group_decision':
      return { reply: true, reason: '测试群聊判断' };
    case 'qzone_decision':
      return { reply: true, reason: '测试空间评论判断' };
    case 'follow_up':
      return { send: true, text: '刚那句我想了想，还是再说一遍。', reason: '测试自己接话' };
    case 'xhs_comment':
      return { reply: true, comment: '这个我也想去试试～', reason: '测试小红书评论' };
    case 'dream':
      return {
        dream: '今天他说要我少熬夜，我嘴上顶了一句，其实心里偷偷高兴。他大概不知道我会把这些话记很久。',
        intention: { text: '想问他明天体检几点去', why: '他说明天要早起', later_hours: 10 },
        opener: '明天几点去体检呀',
      };
    case 'xhs_will':
      return { want: true, reason: '测试想发', title: '今天想说的', content: '测试正文，今天心情还行。', tags: ['日常'] };
    case 'xhs_profile':
      return { names: ['蓝鲸鱼今天也在'], bio: '一只会等你下班的蓝鲸鱼。', why: '像我自己会取的名字' };
    case 'xhs_weekly':
      return {
        report: '这周曝光和观看都是 0，因为还没有笔记发出去；粉丝还是那一个。下周先把已经存好的那条笔记发出去。',
        topics: [{ title: '蓝鲸鱼的第一顿早饭', why: '我自己有图，成本低', need: '3 张早餐图' }],
      };
    case 'xhs_reply':
      return { reply: true, text: '收到啦，我来啦～', reason: '测试小红书回复' };
    case 'daily':
      return { diary: '今天和他聊了很多，心里有点暖。', digest: '今天聊了很多，心里有点暖。' };
    case 'letter':
      return { content: '给未来的我：别忘了他喜欢在深夜聊天，记得提醒他早点睡。' };
    case 'weekly':
      return { content: '这一周我们聊了很多，我也更懂他一点了。' };
    default:
      return { ok: true };
  }
}

export class DeepSeek {
  constructor({ apiKey = env.apiKey, baseUrl = env.baseUrl } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.lastCallAt = null;
    this.lastError = null;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  assertConfigured() {
    if (!this.apiKey) {
      throw new LlmError('还没有配置 DeepSeek API Key，请先编辑 .env 里的 DEEPSEEK_API_KEY。', { code: 'NO_KEY' });
    }
  }

  buildBody(messages, opts = {}) {
    const body = {
      model: opts.model || loadSettings().model.name || env.defaultModel,
      messages,
      temperature: opts.temperature ?? 0.9,
      max_tokens: Math.max(256, Number(opts.maxTokens || 1400)),
      stream: Boolean(opts.stream),
    };
    if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
    if (opts.responseFormat) body.response_format = opts.responseFormat;
    if (opts.stream) body.stream_options = { include_usage: true };
    return body;
  }

  async request(messages, opts = {}) {
    this.assertConfigured();
    const body = this.buildBody(messages, { ...opts, stream: false });
    const deadline = AbortSignal.timeout(opts.timeoutMs || 120000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch(this.baseUrl + '/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.apiKey },
          body: JSON.stringify(body), signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new LlmError('DeepSeek 返回 HTTP ' + res.status + '：' + logger.redact(text.slice(0, 150)), { status: res.status, code: 'HTTP' });
        }
        const data = await res.json();
        const message = data.choices?.[0]?.message || {};
        const content = message.content || '';
        const reasoning = message.reasoning_content || '';
        const result = { content, reasoning, ...streamResult(messages, content, reasoning, data.usage, data.model || body.model) };
        this.recordCost(result, opts);
        if (!result.content) throw new LlmError('模型没有产出有效回复', { code: 'EMPTY_REPLY' });
        this.lastCallAt = new Date().toISOString(); this.lastError = null;
        return result;
      } catch (error) {
        this.lastError = logger.redact(error.message);
        if (signal.aborted) throw signal.reason;
        const retry = !(error instanceof LlmError) || isRetryableStatus(error.status);
        if (!retry || attempt === 1) throw error;
        await wait(900, undefined, { signal });
      }
    }
  }

  async chat(messages, opts = {}) {
    const started = Date.now();
    if (env.mock || opts.mock) {
      await wait(250, undefined, { signal: opts.signal });
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const text = typeof lastUser?.content === 'string' ? lastUser.content : '（图片）';
      const isJson = opts.mockKind && !['chat', 'proactive', 'plain', 'qzone_reply'].includes(opts.mockKind);
      const content = isJson
        ? JSON.stringify(mockJson(opts.mockKind))
        : opts.mockKind === 'proactive'
          ? '（测试模式）突然有点想你。'
          : `（测试模式）我在呢。你刚刚说「${text.slice(0, 40)}」，我听着。`;
      const usage = { prompt: 100, completion: 30, hit: 0, miss: 100, reasoning: 0, total: 130 };
      return { content, reasoning: '', usage, model: 'mock', costCny: 0, latencyMs: Date.now() - started };
    }

    const result = await this.request(messages, opts);
    return { ...result, latencyMs: Date.now() - started };
  }

  async json(messages, opts = {}) {
    const result = await this.chat(
      messages,
      { ...opts, responseFormat: { type: 'json_object' }, temperature: opts.temperature ?? 0.3 },
    );
    return result;
  }

  async *stream(messages, opts = {}) {
    if (env.mock || opts.mock) {
      const last = [...messages].reverse().find((message) => message.role === 'user');
      const input = typeof last?.content === 'string' ? last.content : '（图片）';
      const content = '（测试模式）我在呢。你刚刚说「' + input.slice(0, 40) + '」，我听着。';
      for (let i = 0; i < content.length; i += 6) {
        opts.signal?.throwIfAborted();
        yield { type: 'content', delta: content.slice(i, i + 6) };
        await wait(45, undefined, { signal: opts.signal });
      }
      const usage = { prompt: 100, completion: content.length, hit: 0, miss: 100, reasoning: 0, total: 100 + content.length };
      yield { type: 'done', content, usage, model: 'mock', costCny: 0 };
      return;
    }
    this.assertConfigured();
    const deadline = AbortSignal.timeout(opts.timeoutMs || 180000);
    const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
    const body = this.buildBody(messages, { ...opts, stream: true });
    let content = '', reasoning = '', usageRaw = null, model = body.model;
    let done = false;
    try {
      const res = await fetch(this.baseUrl + '/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.apiKey }, body: JSON.stringify(body), signal,
      });
      if (!res.ok) throw new LlmError('DeepSeek 返回 HTTP ' + res.status + '：' + logger.redact((await res.text()).slice(0, 150)), { status: res.status, code: 'HTTP' });
      for await (const payload of readSse(res.body)) {
        if (payload === '[DONE]') { done = true; break; }
        let chunk;
        try { chunk = JSON.parse(payload); } catch { throw new LlmError('上游流式帧不是合法 JSON', { code: 'STREAM_INVALID' }); }
        if (chunk.error) throw new LlmError(String(chunk.error.message || '上游流式错误'), { code: 'STREAM_ERROR' });
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usageRaw = chunk.usage;
        const delta = chunk.choices?.[0]?.delta || {};
        if (delta.reasoning_content) { reasoning += delta.reasoning_content; yield { type: 'reasoning', delta: delta.reasoning_content }; }
        if (delta.content) { content += delta.content; yield { type: 'content', delta: delta.content }; }
      }
      if (!done) throw new LlmError('上游流式回复没有正常结束', { code: 'STREAM_INCOMPLETE' });
      const result = streamResult(messages, content, reasoning, usageRaw, model);
      this.lastCallAt = new Date().toISOString(); this.lastError = null;
      yield { type: 'done', content, reasoning, ...result };
    } catch (error) { this.lastError = logger.redact(error.message); throw error; }
    finally {
      if (usageRaw || content || reasoning) {
        const result = streamResult(messages, content, reasoning, usageRaw, model);
        this.recordCost(result, { ...opts, kind: done ? opts.kind : (opts.kind || 'chat') + ':partial' });
        opts.onUsage?.(result);
      }
    }
  }

  recordCost(result, opts = {}) {
    try {
      addCost({
        model: result.model,
        kind: (opts.kind || 'chat') + (result.usageEstimated ? ':estimated' : '') + (result.priceVersion ? `:rate-${result.priceVersion}` : ''),
        promptTokens: result.usage.prompt,
        completionTokens: result.usage.completion,
        cacheHitTokens: result.usage.hit,
        costCny: result.costCny,
        sessionId: opts.sessionId || null,
      });
    } catch (error) {
      logger.warn('写入成本记录失败', { error: error.message });
    }
  }

  async balance() {
    this.assertConfigured();
    const res = await fetch(`${this.baseUrl}/user/balance`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new LlmError(`查询余额失败：HTTP ${res.status}`, { status: res.status });
    const data = await res.json();
    const info = data.balance_infos?.[0] || {};
    return {
      available: Boolean(data.is_available),
      currency: info.currency || 'CNY',
      total: Number(info.total_balance || 0),
      granted: Number(info.granted_balance || 0),
      toppedUp: Number(info.topped_up_balance || 0),
    };
  }

  async models() {
    this.assertConfigured();
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new LlmError(`查询模型失败：HTTP ${res.status}`, { status: res.status });
    const data = await res.json();
    return data.data || [];
  }
}

export function mockJsonResponse(kind) {
  return mockJson(kind);
}
