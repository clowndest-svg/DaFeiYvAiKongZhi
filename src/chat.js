import { loadSettings } from './config.js';
import { conversationQueue } from './serial.js';
import { addEvent, addMessage, getActiveSession, getMessagesForPrompt, getSession, updateMessageMeta } from './db.js';
import { DeepSeek, LlmError } from './llm.js';
import { logger } from './logger.js';
import { compactIfNeeded, getMemoryBlock, handoverIfNeeded } from './memory.js';
import { getRecentXhsActivity } from './channels/xhs-actions.js';
import { listIntentions } from './intentions.js';
import { getMood } from './mood.js';
import { buildChatPayload } from './prompt.js';
import { scheduleReflection } from './reflect.js';
import { estimateTokens, stripWrappingQuotes, truncate } from './util.js';

let maintenanceChain = Promise.resolve();

function parseReply(text, name = '小知') {
  let hint = null;
  let s = String(text || '');
  s = s.replace(/\[\[\s*sticker\s*:\s*(happy|shy|surprised|blink|normal|face|mface)\s*\]\]/gi, (_, name) => {
    if (!hint) hint = name.toLowerCase();
    return '';
  });
  const safeName = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (safeName) s = s.replace(new RegExp(`^${safeName}[:：]\\s*`, 'u'), '');
  s = stripWrappingQuotes(s).trim();
  let voice = false;
  s = s.replace(/\[\[\s*voice\s*\]\]/gi, () => {
    voice = true;
    return '';
  });

  return { text: s, hint, voice };
}

export function parseStickerHint(text) {
  return parseReply(text);
}

export class Companion {
  constructor({ llm = new DeepSeek(), onTurnComplete = null } = {}) {
    this.llm = llm;
    this.onTurnComplete = onTurnComplete;
  }

  prepare({ text = '', images = [], channel = 'web', sessionId = null, displayName = '', extraContext = '' }) {
    const settings = loadSettings();
    if (!this.llm.configured && process.env.LLM_MOCK !== '1') {
      throw new LlmError('还没有配置 DeepSeek API Key，请先编辑 .env 里的 DEEPSEEK_API_KEY。', { code: 'NO_KEY' });
    }
    const cleanText = String(text || '').trim().slice(0, 20000);
    const cleanImages = (Array.isArray(images) ? images : [])
      .filter((url) => typeof url === 'string' && /^data:image\/(png|jpe?g|webp);base64,/i.test(url))
      .filter((url) => url.length < 8 * 1024 * 1024)
      .slice(0, 4);
    if (!cleanText && !cleanImages.length) throw new Error('消息不能为空');

    const session = sessionId ? getSession(sessionId) : null;
    const active = session || getActiveSession();
    if (!active || active.status !== 'active') throw new Error('当前会话不可用');

    const userMessage = addMessage({
      sessionId: active.id,
      role: 'user',
      content: cleanText || '（发来了一张图片）',
      channel,
      meta: { hasImage: cleanImages.length > 0, displayName },
      tokens: estimateTokens(cleanText) + cleanImages.length * 900,
    });

    const restricted = channel === 'qq-group' || channel === 'qq-guest';
    const history = getMessagesForPrompt(active.id, settings.memory.shortTurns)
      .filter((message) => restricted ? message.channel === channel : ['web', 'qq'].includes(message.channel || 'web'));
    const mood = getMood();
    const block = restricted
      ? {
          core: [],
          long: [],
          mid: [],
          summary: '',
          handover: '',
          innerThoughts: [],
          intentions: [],
          session: active,
          dailyRecent: [],
          diaryMatches: [],
          quotes: [],
        }
      : getMemoryBlock({ query: cleanText, settings, sessionId: active.id, excludeQuoteIds: history.map((m) => m.id) });
    if (!restricted) {
      block.xhsActivity = getRecentXhsActivity({ hours: 48, limit: 8 });
      block.intentions = listIntentions({ limit: 5, forPrompt: true });
    }
    const payload = buildChatPayload({
      settings,
      mood,
      block,
      history,
      images: cleanImages,
      maxContextTokens: settings.memory.maxContextTokens,
      channel,
      extraContext,
    });

    return {
      settings,
      session: active,
      userMessage,
      history,
      mood,
      block,
      payload,
      channel,
      restricted,
      text: cleanText,
      images: cleanImages,
    };
  }

  async *streamReply(opts) {
    const key = ['qq-group', 'qq-guest'].includes(opts.channel) ? opts.sessionId || opts.channel : 'owner';
    const release = await conversationQueue.acquire(key, { signal: opts.signal });
    try { yield* this.streamReplyLocked(opts); } finally { release(); }
  }

  async *streamReplyLocked(opts) {
    opts.signal?.throwIfAborted();
    const prep = this.prepare(opts);
    let content = '';
    let usage = null;
    let model = prep.settings.model.name;
    let costCny = 0;
    let completed = false;
    let saved = null;

    const finalize = () => {
      if (saved) return saved;
      const parsed = parseReply(content, prep.settings.companion?.name);
      const text = parsed.text;
      if (!text) return null;
      saved = addMessage({
        sessionId: prep.session.id,
        role: 'assistant',
        content: text,
        channel: opts.channel || 'web',
        meta: {
          model,
          usage,
          costCny,
          streamed: true,
          latencyMs: Date.now() - startedAt,
          aborted: false,
          stickerHint: parsed.hint || null,
        voice: parsed.voice || null,
        },
        tokens: usage?.completion || estimateTokens(text),
        contextTokens: usage ? Number(usage.prompt || 0) + Number(usage.completion || 0) : 0,
      });
      this.afterTurn(prep, saved);
      return saved;
    };

    const startedAt = Date.now();
    const streamAbort = new AbortController();
    const signal = opts.signal ? AbortSignal.any([streamAbort.signal, opts.signal]) : streamAbort.signal;
    try {
      const stream = this.llm.stream(prep.payload.messages, {
        model: prep.settings.model.name,
        temperature: prep.settings.model.temperature,
        maxTokens: prep.settings.model.chatMaxTokens,
        reasoningEffort: prep.settings.model.reasoningEffort,
        kind: 'chat',
        sessionId: prep.session.id,
        signal,
        onUsage: (result) => { usage = result.usage; costCny = result.costCny; if (saved) updateMessageMeta(saved.id, { usage, costCny, usageEstimated: result.usageEstimated }); },
      });
      for await (const event of stream) {
        if (event.type === 'content') {
          content += event.delta;
          yield { type: 'delta', delta: event.delta };
        } else if (event.type === 'reasoning') {
          yield { type: 'thinking' };
        } else if (event.type === 'done') {
          usage = event.usage;
          model = event.model || model;
          costCny = event.costCny || 0;
          completed = true;
          if (event.content && !content) content = event.content;
        }
      }
    } catch (error) {
      logger.error('流式回复失败', { error: error.message, partial: content.length });
      const timedOut =
        error?.name === 'TimeoutError' ||
        error?.name === 'AbortError' ||
        /timed? ?out|aborted due to timeout/i.test(String(error?.message || ''));
      if (timedOut) {
        throw new LlmError('DeepSeek 这次回得太慢，已经停了；再发一次吧。', { code: 'TIMEOUT', cause: error });
      }
      throw error;
    } finally {
      streamAbort.abort();
      if (!completed && !saved && content.trim()) {
        const parsed = parseReply(content, prep.settings.companion?.name);
        if (parsed.text) {
          saved = addMessage({
            sessionId: prep.session.id,
            role: 'assistant',
            content: parsed.text,
            channel: opts.channel || 'web',
            meta: {
              model,
              usage,
              costCny,
              streamed: true,
              aborted: true,
              latencyMs: Date.now() - startedAt,
              stickerHint: parsed.hint || null,
              voice: parsed.voice || null,
            },
            tokens: estimateTokens(parsed.text),
            contextTokens: 0,
          });
          addEvent('chat_aborted_partial', '她话说到一半断了，半截已经记下来', {
            chars: parsed.text.length,
            usageEstimated: !usage,
          });
          logger.warn('流式回复中断，半截已标记保存，费用由上游 usage 或估算台账记录', { chars: parsed.text.length });
        }
      }
    }

    if (!completed) {
      logger.warn('流式回复没有正常结束，半截不会进入自动记忆', { chars: content.length });
      throw new LlmError('她这次没说完，重新发一次吧。', { code: 'STREAM_INCOMPLETE' });
    }

    const message = finalize();
    if (!message) {
      throw new LlmError('她这次没有说出完整的话，再试一次吧。', { code: 'EMPTY_REPLY' });
    }
    if (this.onTurnComplete) this.onTurnComplete({ prep, message });
    yield {
      type: 'done',
      message,
      usage,
      costCny,
      model,
      mood: getMood(),
      sessionId: prep.session.id,
    };
  }

  async reply(opts) {
    const key = ['qq-group', 'qq-guest'].includes(opts.channel) ? opts.sessionId || opts.channel : 'owner';
    return conversationQueue.run(key, () => this.replyLocked(opts), { signal: opts.signal });
  }

  async replyLocked(opts) {
    opts.signal?.throwIfAborted();
    const prep = this.prepare(opts);
    const startedAt = Date.now();
    const mood = getMood();
    const baseTemp = Number(prep.settings.model.temperature) || 0.95;
    const temperature = Math.min(1.2, Math.max(0.55, baseTemp + (mood.valence - 0.2) * 0.12 + (mood.energy - 0.5) * 0.08));
    const baseMax = Number(prep.settings.model.chatMaxTokens) || 1400;
    const maxTokens = Math.round(Math.min(baseMax, Math.max(300, baseMax * (0.62 + mood.energy * 0.55))));
    const result = await this.llm.chat(prep.payload.messages, {
      model: prep.settings.model.name,
      temperature,
      maxTokens,
      reasoningEffort: prep.settings.model.reasoningEffort,
      kind: 'chat',
      sessionId: prep.session.id,
      mockKind: 'chat',
      signal: opts.signal,
    });
    opts.signal?.throwIfAborted();
    const parsed = parseReply(result.content, prep.settings.companion?.name);
    const text = parsed.text;
    if (!text) throw new LlmError('她这次没有说出完整的话，再试一次吧。', { code: 'EMPTY_REPLY' });

    const message = addMessage({
      sessionId: prep.session.id,
      role: 'assistant',
      content: text,
      channel: opts.channel || 'web',
      meta: {
        model: result.model,
        usage: result.usage,
        costCny: result.costCny,
        latencyMs: Date.now() - startedAt,
        streamed: false,
        stickerHint: parsed.hint || null,
        voice: parsed.voice || null,
      },
      tokens: result.usage?.completion || estimateTokens(text),
      contextTokens: result.usage ? Number(result.usage.prompt || 0) + Number(result.usage.completion || 0) : 0,
    });
    this.afterTurn(prep, message);
    if (this.onTurnComplete) this.onTurnComplete({ prep, message });
    return {
      prep,
      message,
      text,
      stickerHint: parsed.hint || null,
      voice: parsed.voice === true,
      usage: result.usage,
      costCny: result.costCny,
      model: result.model,
    };
  }

  afterTurn(prep, message) {
    if (prep.restricted) return;
    scheduleReflection({
      llm: this.llm,
      sessionId: prep.session.id,
      assistantMessageId: message.id,
      settings: prep.settings,
      messages: [...prep.history, message],
    });
    maintenanceChain = maintenanceChain
      .then(() => conversationQueue.run('owner', async () => {
        const settings = loadSettings();
        await compactIfNeeded({ llm: this.llm, sessionId: prep.session.id, settings });
        await handoverIfNeeded({ llm: this.llm, sessionId: prep.session.id, settings });
      }))
      .catch((error) => logger.warn('会话维护失败', { error: error.message }));
  }

  saveFollowUpMessage(text, channel = 'qq') {
    const settings = loadSettings();
    const sessionId = getActiveSession().id;
    const parsed = parseReply(text, settings.companion?.name);
    if (!parsed.text) return null;
    return addMessage({
      sessionId,
      role: 'assistant',
      content: parsed.text,
      channel,
      meta: { followUp: true, model: settings.model.name, stickerHint: parsed.hint || null },
      tokens: estimateTokens(parsed.text),
    });
  }

  saveProactiveMessage(text, channel = 'web') {
    const settings = loadSettings();
    const sessionId = getActiveSession().id;
    const parsed = parseReply(text, settings.companion?.name);
    const message = addMessage({
      sessionId,
      role: 'assistant',
      content: parsed.text,
      channel,
      meta: { proactive: true, model: settings.model.name, stickerHint: parsed.hint || null },
      tokens: estimateTokens(parsed.text),
    });
    if (this.onTurnComplete) this.onTurnComplete({ prep: { session: { id: sessionId }, settings }, message });
    return message;
  }
}
