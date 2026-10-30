import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { AsyncLocalStorage } from 'node:async_hooks';
import { env, loadSettings } from '../config.js';
import { DeliveryUnknownError } from '../effects.js';
import { addEvent, createSession, getSession, kvGet, kvGetJson, kvSet, kvSetJson } from '../db.js';
import { costBlocked, noteCostSkip } from '../budget.js';
import { getLearnedImageBase64, lastLearnedImage, learnImage, listLearnedImages, randomLearnedImage } from '../learned-images.js';
import { logger } from '../logger.js';
import { getMood } from '../mood.js';
import { synthesizeSpeech } from '../tts.js';
import { transcribeRecord, transcribeWav } from '../asr.js';
import { buildSelfFollowUpPrompt } from '../prompt.js';
import { generatePost, tryAutoPublish } from '../social.js';
import { getStickerBase64, pickSticker } from '../stickers.js';
import { localHour, nowIso, parseJsonLoose, safeEqual, shanghaiDayKey, sleep, splitForQQ } from '../util.js';

function wsToken(req) {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const q = url.searchParams.get('access_token') || url.searchParams.get('token');
    if (q) return q;
  } catch {
    // ignore
  }
  const auth = req.headers.authorization || '';
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

export function parseOwnerCommand(text) {
  const value = String(text || '').replace(/\s+/g, '').toLowerCase();
  if (!value) return null;
  if (/^(状态|查岗|你现在啥情况|现在怎么样)$/.test(value)) return 'status';
  if (/^(自动运营|小红书自动运营)(开|打开|开启|启动)$/.test(value)) return 'auto_on';
  if (/^(自动运营|小红书自动运营)(关|关掉|关闭|停|停下)$/.test(value)) return 'auto_off';
  if (/^(逛一下|去逛逛|刷一下小红书)$/.test(value)) return 'browse';
  if (/^(发一条|发个笔记|去发笔记)$/.test(value)) return 'publish';
  if (/^(今天做了啥|今天干了什么|今天都做了啥)$/.test(value)) return 'today';
  if (/^(发条语音|说句语音|用声音说)$/.test(value)) return 'voice';
  return null;
}

export function isQzonePostIntent(text, { previousText = '' } = {}) {
  const value = String(text || '').trim();
  if (!value || /不要|别|不许|不能|不想|不发|停止|取消|如果|假如|他说|她说|[“”「」"']/.test(value)) return false;
  if (/能不能|可不可以|能发|可以发|会不会|(?:吗|么|嘛|怎样|怎么)[？?]?\s*$/.test(value)) return false;
  const topic = /说说|空间动态|QQ\s*空间|发空间/i;
  const imperative = /^(?:(?:请|帮我|给我|替我|现在|马上|去|你|就)\s*)*发(?:布)?\s*(?:个|一条|条|一下)?\s*(?:QQ\s*)?(?:说说|空间(?:动态|说说)?)(?:吧|呀|啦|哦|一下|[！!。\s]|[:：].*)*$/i;
  if (value.split(/[，,\n]/).some((part) => imperative.test(part.trim()))) return true;
  return topic.test(previousText) && /^(?:你)?(?:现在|就|帮我|给我)?发(?:一下|个|一条)(?:我看看|看看)[！!。\s]*$/.test(value);
}

function maskQq(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 6) return '***';
  return `${s.slice(0, 3)}****${s.slice(-3)}`;
}

export { checkBotIdentity } from '../identity.js';
import { checkBotIdentity } from '../identity.js';

function isLocalHostname(hostname) {
  const name = String(hostname || '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

export { assertSafeImageUrl, fetchSafeImage } from '../net.js';
import { fetchSafeImage, imageType as detectImageType } from '../net.js';

async function imageUrlToDataUrl(url) {
  if (!/^https?:\/\//i.test(url || '')) return null;
  const buf = await fetchSafeImage(url, { timeoutMs: 20000 });
  const type = detectImageType(buf);
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) {
    throw new Error('图片内容不是支持的格式');
  }
  return `data:${type};base64,${buf.toString('base64')}`;
}

export function imageDataUrlFromPath(file) {
  const value = String(file || '');
  if (!value || /^https?:|^base64:|^data:/i.test(value)) return null;
  if (!fs.existsSync(value)) return null;
  const stat = fs.statSync(value);
  if (!stat.isFile() || stat.size > 7 * 1024 * 1024 || stat.size < 12) return null;
  const buf = fs.readFileSync(value);
  const type = detectImageType(buf);
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) return null;
  return `data:${type};base64,${buf.toString('base64')}`;
}

export function extractMessage(event) {
  const texts = [];
  const images = [];
  const faces = [];
  const mfaces = [];
  const voiceMessages = [];
  let hasUnsupported = false;
  for (const seg of event.message || []) {
    if (!seg || !seg.type) continue;
    if (seg.type === 'text') texts.push(String(seg.data?.text || ''));
    else if (seg.type === 'image') {
      const url = seg.data?.url || seg.data?.file;
      if (url) images.push(url);
    } else if (seg.type === 'face') {
      texts.push('[表情]');
      faces.push(seg.data || {});
    } else if (seg.type === 'mface' || seg.type === 'marketface') {
      texts.push('[表情包]');
      mfaces.push(seg.data || {});
    } else if (seg.type === 'record') {
      texts.push('[语音]');
      voiceMessages.push(seg.data || {});
    }
    else if (seg.type === 'video') texts.push('[视频]');
    else if (seg.type === 'at') continue;
    else hasUnsupported = true;
  }
  const text = texts.join('').replace(/\s+/g, ' ').trim();
  return { text, images, faces, mfaces, voiceMessages, hasUnsupported };
}

const FOLLOW_UP_HOUR_MS = 3600000;



export function followUpDelayMs(settings, rand = Math.random) {
  const base = Number(settings?.qq?.selfFollowUpDelaySeconds ?? 25) * 1000;
  return Math.round(Math.max(1000, base * (0.72 + rand() * 0.7)));
}

export function parseFollowUpDecision(raw) {
  let data;
  try {
    data = parseJsonLoose(raw);
  } catch {
    return { send: false, text: '', reason: '没解析出 JSON' };
  }
  const wants = data?.send === true || data?.send === 'true' || data?.send === 1;
  const text = String(data?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return {
    send: wants && Boolean(text),
    text: wants && text ? text : '',
    reason: String(data?.reason || '').slice(0, 40),
  };
}

export class OneBotChannel {
  constructor({ server, companion, onNeedRecover = null, onCommand = null, synthesize = synthesizeSpeech }) {
    this.companion = companion;
    this.synthesizeSpeech = synthesize;
    this.outboundScope = new AsyncLocalStorage();
    this.generation = 0;
    this.onNeedRecover = onNeedRecover;
    this.onCommand = onCommand;
    this.downSince = null;
    this.lastDownEventAt = 0;
    this.lastRecoverAt = 0;
    this.recoverTimestamps = [];
    this.recoverError = null;
    this.wss = new WebSocketServer({ server, path: '/onebot', maxPayload: 8 * 1024 * 1024 });
    this.clients = new Set();
    this.pending = new Map();
    this.seenMessages = new Map();
    this.buffers = new Map();
    this.flushing = new Set();
    this.deferredFlush = new Set();
    this.groupHistory = new Map();
    this.groupDecisionAt = new Map();
    this.groupReplyAt = new Map();
    this.lastQzonePostAt = 0;
    this.replyBuckets = { owner: [], group: [], guest: [] };
    this.followUpTimers = new Map();
    this.followUpTimestamps = [];
    this.lastInboundAt = new Map();
    this.selfId = null;
    this.lastStickerAt = 0;
    this.stickerTimes = new Map();
    this.lastEventAt = null;
    this.lastError = null;
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.heartbeat = setInterval(() => {
      this.pruneSeenMessages();
      this.checkConnectionHealth();
      for (const ws of this.clients) {
        if (ws.isAlive === false) {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          // ignore
        }
      }
    }, 30000);
  }

  checkConnectionHealth() {
    const settings = loadSettings();
    const now = Date.now();
    if (!settings.qq?.enabled || this.clients.size) {
      this.downSince = null;
      return { downMinutes: 0, recovered: false };
    }
    if (!this.downSince) {
      this.downSince = now;
      return { downMinutes: 0, recovered: false };
    }
    const downMinutes = (now - this.downSince) / 60000;
    if (downMinutes < 5) return { downMinutes, recovered: false };
    if (now - this.lastDownEventAt > 15 * 60000) {
      this.lastDownEventAt = now;
      addEvent('qq_down', `QQ 通道断了 ${Math.round(downMinutes)} 分钟，她收不到你的消息`, { downMinutes: Math.round(downMinutes) });
    }
    if (!settings.qq.autoRecover || !this.onNeedRecover) return { downMinutes, recovered: false };
    this.recoverTimestamps = this.recoverTimestamps.filter((t) => now - t < 3600000);
    if (this.recoverTimestamps.length >= 3 || now - this.lastRecoverAt < 20 * 60000) return { downMinutes, recovered: false };
    this.lastRecoverAt = now;
    this.recoverTimestamps.push(now);
    Promise.resolve()
      .then(() => this.onNeedRecover())
      .then(() => {
        this.recoverError = null;
        addEvent('qq_auto_recover', '她自己去把 QQ 登录重新拉起来了，可能要你扫一下码', { downMinutes: Math.round(downMinutes) });
      })
      .catch((error) => {
        this.recoverError = error.message;
        logger.warn('QQ 自动恢复失败', { error: error.message });
        addEvent('qq_auto_recover_error', 'QQ 自动恢复没成功', { error: error.message });
      });
    return { downMinutes, recovered: true };
  }

  pruneSeenMessages() {
    const cutoff = Date.now() - 10 * 60000;
    for (const [key, at] of this.seenMessages) {
      if (at < cutoff) this.seenMessages.delete(key);
    }
    const inboundCutoff = Date.now() - 2 * FOLLOW_UP_HOUR_MS;
    for (const [key, at] of this.lastInboundAt) {
      if (at < inboundCutoff) this.lastInboundAt.delete(key);
    }
  }

  scopedSession(key, title) {
    const stored = kvGet(key);
    let session = stored ? getSession(stored) : null;
    if (!session || session.status !== 'active') {
      session = createSession(title);
      kvSet(key, session.id);
    }
    return session.id;
  }

  handleConnection(ws, req) {
    const settings = loadSettings();
    if (!settings.qq.enabled) {
      ws.close(1008, 'qq disabled');
      return;
    }
    if (!env.onebotToken) {
      logger.error('ONEBOT_TOKEN 没有配置，已拒绝 OneBot 连接');
      ws.close(1008, 'token not configured');
      return;
    }
    if (!safeEqual(wsToken(req), env.onebotToken)) {
      logger.warn('OneBot 连接令牌不匹配，已拒绝');
      ws.close(1008, 'bad token');
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (!isLocalHostname(new URL(origin).hostname)) {
          logger.warn('OneBot 连接来源不合法，已拒绝');
          ws.close(1008, 'bad origin');
          return;
        }
      } catch {
        ws.close(1008, 'bad origin');
        return;
      }
    }
    ws.isAlive = true;
    ws.selfId = '';
    ws.lastPongAt = Date.now();
    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastPongAt = Date.now();
    });
    this.clients.add(ws);
    this.lastError = null;
    logger.info('NapCat 已连接到控制台');
    addEvent('qq_connected', 'NapCat 已连接到小知');
    ws.on('message', (data) => this.handleRaw(ws, data));
    ws.on('close', () => {
      this.clients.delete(ws);
      for (const [echo, entry] of this.pending) {
        if (entry.ws === ws) {
          clearTimeout(entry.timer);
          this.pending.delete(echo);
          entry.reject(String(entry.action || '').startsWith('send_') ? new DeliveryUnknownError('连接中断，QQ 发送结果未知，未自动重发') : new Error('NapCat 连接已断开'));
        }
      }
      logger.info('NapCat 连接已断开');
      addEvent('qq_disconnected', 'NapCat 连接断开');
    });
    ws.on('error', (error) => {
      this.lastError = error.message;
      logger.warn('OneBot WebSocket 错误', { error: error.message });
    });
  }

  handleRaw(ws, data) {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }
    this.lastEventAt = new Date().toISOString();
    if (payload.echo && this.pending.has(payload.echo)) {
      const entry = this.pending.get(payload.echo);
      if (entry.ws !== ws) {
        logger.warn('忽略来自其他连接的 OneBot 回包', { echo: payload.echo });
        return;
      }
      this.pending.delete(payload.echo);
      clearTimeout(entry.timer);
      const isSend = String(entry.action || '').startsWith('send_');
      const ok = payload.status === 'ok' && Number(payload.retcode) === 0;
      if (ok && (!isSend || payload.data?.message_id)) {
        if (isSend) this.lastError = null;
        entry.resolve(payload);
      } else {
        const message = payload.wording || payload.message || 'OneBot 没有确认消息已发出';
        if (isSend) {
          this.lastError = message;
          const last = Number(kvGet('qq_send_error_at', '0') || 0);
          if (Date.now() - last > 5 * 60000) {
            kvSet('qq_send_error_at', String(Date.now()));
            addEvent('qq_send_error', 'QQ 协议层发送失败（NapCat 连上了，但 QQ 账号发不出去）', {
              action: entry.action,
              error: String(message).slice(0, 160),
            });
          }
        }
        entry.reject(isSend && ok ? new DeliveryUnknownError(message) : new Error(message));
      }
      return;
    }
    if (payload.self_id) ws.selfId = String(payload.self_id);
    if (payload.post_type === 'meta_event') {
      if (payload.self_id) {
        this.selfId = String(payload.self_id);
        kvSet('qq_self_id', this.selfId);
        const identity = this.identityCheck();
        if (!identity.ok) this.noteIdentityMismatch(identity.reason);
        else this.identityError = '';
      }
      return;
    }
    if (payload.post_type !== 'message') return;
    const eventKey = payload.message_id
      ? `id:${payload.message_id}`
      : `sig:${payload.self_id || ''}:${payload.message_type || ''}:${payload.group_id || ''}:${payload.user_id || ''}:${payload.time || ''}:${payload.raw_message || ''}`;
    if (this.seenMessages.has(eventKey)) {
      logger.debug('忽略重复的 OneBot 消息', { eventKey });
      return;
    }
    this.seenMessages.set(eventKey, Date.now());
    if (this.seenMessages.size > 800) this.pruneSeenMessages();
    this.handleMessage(payload).catch((error) => {
      this.lastError = error.message;
      logger.warn('处理 QQ 消息失败', { error: error.message });
    });
  }

  async handleMessage(event) {
    const settings = loadSettings();
    if (!settings.qq.enabled) return;
    const identity = this.identityCheck(event.self_id);
    if (!identity.ok) {
      this.noteIdentityMismatch(identity.reason);
      return;
    }
    const selfId = String(event.self_id || this.selfId || kvGet('qq_self_id') || '');
    if (selfId) {
      this.selfId = selfId;
      kvSet('qq_self_id', selfId);
    }
    if (String(event.user_id) === selfId) return;
    if (event.post_type === 'message_sent') return;

    let conversationKey = '';
    let target = null;
    let sessionId = null;
    let guest = false;
    const nickname = event.sender?.card || event.sender?.nickname || String(event.user_id);
    const extracted = extractMessage(event);

    if (event.message_type === 'private') {
      const userId = String(event.user_id);
      const owner = kvGet('qq_owner_id');
      const whitelist = settings.qq.whitelist || [];
      const allowed =
        settings.qq.allowAllPrivate || whitelist.includes(userId) || owner === userId || (!owner && whitelist.length === 0);
      if (!allowed) {
        logger.info('忽略未授权的 QQ 私聊', { userId });
        return;
      }
      const autoBind = settings.qq.autoBindWhitelist !== false && whitelist.includes(userId);
      if (!owner && !autoBind) {
        const pending = kvGetJson('qq_owner_candidate', null);
        if (!pending || pending.userId !== userId) {
          kvSetJson('qq_owner_candidate', { userId, nickname, at: nowIso() });
          addEvent('qq_owner_candidate', '有一个 QQ 私聊在等你确认主人身份', { userId, nickname });
          logger.info('等待确认 QQ 主人', { userId, nickname });
        }
        return;
      }
      const isOwner = owner === userId || (!owner && whitelist.includes(userId));
      if (!owner && isOwner) {
        kvSet('qq_owner_id', userId);
        kvSetJson('qq_owner_candidate', null);
        addEvent('qq_owner', '已把白名单里的 QQ 绑定为主人', { userId, nickname });
        logger.info('绑定 QQ 主人', { userId });
      }
      guest = !isOwner;
      conversationKey = isOwner ? `private:${userId}` : `guest:${userId}`;
      sessionId = isOwner
        ? null
        : this.scopedSession(`qq_guest_session:${userId}`, `和 ${nickname} 的私聊`);
      target = { type: 'private', userId };
    } else if (event.message_type === 'group') {
      const groupId = String(event.group_id);
      const groupWhitelist = settings.qq.groupWhitelist || [];
      if (groupWhitelist.length && !groupWhitelist.includes(groupId)) return;
      const mentioned = (event.message || []).some(
        (seg) => seg.type === 'at' && String(seg.data?.qq) === selfId,
      );
      const groupText = extracted.text || (extracted.images.length ? '[图片]' : '');
      if (groupText) this.rememberGroupMessage(groupId, nickname, groupText);

      if (settings.qq.groupAtOnly) {
        if (!mentioned) return;
      } else if (!mentioned) {
        if (!groupWhitelist.length) return;
        const shouldReply = await this.shouldReplyInGroup(groupId, nickname, groupText, settings);
        if (!shouldReply) return;
      }
      guest = true;
      conversationKey = `group:${groupId}:${event.user_id}`;
      sessionId = this.scopedSession(`qq_group_session:${groupId}`, `QQ 群 ${groupId}`);
      target = { type: 'group', groupId };
    } else {
      return;
    }

    const isOwnerPrivate = event.message_type === 'private' && !guest;
    target.generation = this.generation || 0;
    target.ownerId = isOwnerPrivate ? String(kvGet('qq_owner_id') || '') : '';
    const { text, images, mfaces, hasUnsupported } = extracted;
    this.lastInboundAt.set(conversationKey, Date.now());
    this.cancelFollowUp(conversationKey);
    if (mfaces.length && isOwnerPrivate) this.rememberMfaces(mfaces);
    if (!text && !images.length) {
      if (hasUnsupported) {
        const kinds = (event.message || []).map((seg) => seg?.type).filter(Boolean).join('/');
        addEvent('qq_seg_skipped', '收到一种她处理不了的消息，先跳过了', { kinds: kinds.slice(0, 60) });
      }
      return;
    }

    const command = isOwnerPrivate ? parseOwnerCommand(text) : null;
    if (command) {
      this.lastInboundAt.set(conversationKey, Date.now());
      this.cancelFollowUp(conversationKey);
      await this.outboundScope.run(target, () => this.runOwnerCommand(command, target)).catch((error) => {
        logger.warn('QQ 口令执行失败', { command, error: error.message });
      });
      return;
    }

    let buffer = this.buffers.get(conversationKey);
    if (!buffer) {
      buffer = { texts: [], images: [], voices: [], target, nickname, timer: null, groupContext: '', guest, sessionId };
      this.buffers.set(conversationKey, buffer);
    }
    if (target.type === 'group') {
      const previous = (this.groupHistory.get(target.groupId) || []).slice(0, -1).slice(-6);
      buffer.groupContext = previous.map((m) => `${m.nickname}: ${m.text}`).join('\n');
    }
    if (text) buffer.texts.push(target.type === 'group' && nickname ? `${nickname}：${text}` : text);
    buffer.images.push(...images);
    if (extracted.voiceMessages?.length) buffer.voices.push(...extracted.voiceMessages);
    buffer.target = target;
    if (!buffer.nickname) buffer.nickname = nickname;
    buffer.guest = guest;
    buffer.sessionId = sessionId;
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => {
      this.flushBuffer(conversationKey).catch((error) => {
        this.lastError = error.message;
        logger.warn('QQ 回复失败', { error: error.message, conversationKey });
      });
    }, 2200);
  }

  rememberGroupMessage(groupId, nickname, text) {
    const value = String(text || '').trim().slice(0, 300);
    if (!value) return;
    let history = this.groupHistory.get(groupId) || [];
    history.push({ nickname: String(nickname || '').slice(0, 30), text: value, at: Date.now() });
    history = history.slice(-10);
    this.groupHistory.set(groupId, history);
  }

  async shouldReplyInGroup(groupId, nickname, text, settings) {
    if (!text) return false;
    const name = settings.companion?.name || '小知';
    const aliases = [...new Set([name, '小知', '鲸鲸', '大肥鱼', '鱼鱼'].filter(Boolean))];
    const withoutFalsePositive = text.split('小知识').join('');
    if (aliases.some((alias) => (alias === '小知' ? withoutFalsePositive.includes(alias) : text.includes(alias)))) {
      return true;
    }

    const now = Date.now();
    if (now - (this.groupReplyAt.get(groupId) || 0) < 20000) return false;
    if (now - (this.groupDecisionAt.get(groupId) || 0) < 8000) return false;
    this.groupDecisionAt.set(groupId, now);

    const history = (this.groupHistory.get(groupId) || [])
      .slice(-7)
      .map((item) => `${item.nickname}: ${item.text}`)
      .join('\n');
    const messages = [
      { role: 'system', content: '你是群聊插话判断器，只输出严格 JSON。' },
      {
        role: 'user',
        content: `你是「${name}」，在一个 QQ 群里。判断这条新消息你要不要主动插话。
规则：
- 只有被叫名字或 @ 才必须回；这些已经由程序处理。
- 问题、求助、聊到你在意的话题、气氛适合你接一句 → reply=true。
- 纯灌水、别人之间的对话、刷屏、广告、链接、吵架、隐私、敏感内容 → reply=false。
- 不要每条都回；如果最近主要不是跟你说话，倾向 false。
最近群聊：
${history}
只返回 JSON：{"reply":true 或 false, "reason":"20 字内"}`,
      },
    ];
    try {
      const result = await this.companion.llm.chat(messages, {
        kind: 'group_decision',
        model: settings.model.name,
        maxTokens: 60,
        temperature: 0.2,
        reasoningEffort: 'low',
        responseFormat: { type: 'json_object' },
        mockKind: 'group_decision',
      });
      const data = parseJsonLoose(result.content);
      const reply = data.reply === true || data.reply === 'true' || data.reply === 1;
      if (reply) this.groupReplyAt.set(groupId, now);
      logger.debug('群聊判断', { groupId, reply, reason: String(data.reason || '').slice(0, 40) });
      return reply;
    } catch (error) {
      logger.warn('群聊判断失败，默认不回', { error: error.message });
      return false;
    }
  }

  rememberMfaces(mfaces) {
    if (!Array.isArray(mfaces) || !mfaces.length) return;
    let learned = kvGetJson('learned_mfaces', []);
    for (const raw of mfaces) {
      const emojiId = String(raw?.emoji_id ?? raw?.emojiId ?? '').trim();
      if (!emojiId) continue;
      const record = {
        emoji_id: emojiId,
        emoji_package_id: String(raw?.emoji_package_id ?? raw?.emojiPackageId ?? ''),
        key: String(raw?.key ?? ''),
        summary: String(raw?.summary ?? '[表情包]'),
        url: String(raw?.url ?? ''),
        learnedAt: nowIso(),
      };
      learned = learned.filter(
        (item) => !(item.emoji_id === record.emoji_id && item.emoji_package_id === record.emoji_package_id),
      );
      learned.push(record);
      logger.info('收到 QQ 表情包', {
        emojiId: record.emoji_id,
        packageId: record.emoji_package_id,
        hasKey: Boolean(record.key),
        summary: record.summary,
      });
    }
    learned = learned.slice(-30);
    kvSetJson('learned_mfaces', learned);
    addEvent('qq_mface', `记住了你发的 QQ 表情包（共 ${learned.length} 个）`);
  }

  replyBucket(bucket, settings) {
    const global = Number(settings.qq?.maxRepliesPerHour || 40);
    const now = Date.now();
    const withinHour = (list) => (list || []).filter((t) => now - t < 3600000);
    this.replyBuckets[bucket] = withinHour(this.replyBuckets[bucket]);
    const all = Object.values(this.replyBuckets).reduce((sum, list) => sum + withinHour(list).length, 0);
    const limit = bucket === 'owner' ? global : Math.max(3, Math.ceil(global / 4));
    const used = this.replyBuckets[bucket].length;
    if (all >= global) return { ok: false, used, limit, all, global, reason: `一小时总共回了 ${all}/${global} 条，先停一停` };
    if (used >= limit) return { ok: false, used, limit, all, global, reason: `${bucket} 这一路一小时回满 ${used}/${limit} 条` };
    return { ok: true, used, limit, all, global };
  }

  markReply(bucket) {
    if (!this.replyBuckets[bucket]) this.replyBuckets[bucket] = [];
    this.replyBuckets[bucket].push(Date.now());
  }

  async flushBuffer(conversationKey) {
    if (this.flushing.has(conversationKey)) {
      this.deferredFlush.add(conversationKey);
      return;
    }
    this.flushing.add(conversationKey);
    try {
      const target = this.buffers.get(conversationKey)?.target || {};
      await this.outboundScope.run({ generation: target.generation ?? this.generation, ownerId: target.ownerId || '' }, () => this.drainBuffer(conversationKey));
    } finally {
      this.flushing.delete(conversationKey);
      if (this.deferredFlush.delete(conversationKey) && this.buffers.has(conversationKey)) {
        this.flushBuffer(conversationKey).catch((error) => {
          this.lastError = error.message;
          logger.warn('补一轮 QQ 回复失败', { error: error.message, conversationKey });
        });
      }
    }
  }

  async drainBuffer(conversationKey) {
    const buffer = this.buffers.get(conversationKey);
    if (!buffer) return;
    this.buffers.delete(conversationKey);

    const settings = loadSettings();
    const now = Date.now();
    const owner = kvGet('qq_owner_id') || '';
    const bucket =
      buffer.target.type === 'group' ? 'group' : String(buffer.target.userId || '') === String(owner) ? 'owner' : 'guest';
    const budget = this.replyBucket(bucket, settings);
    if (!budget.ok) {
      logger.warn('QQ 回复频率超限，已跳过', { conversationKey, bucket, reason: budget.reason });
      addEvent('qq_reply_throttled', `她忍住没回（${bucket}）`, { reason: budget.reason, conversationKey });
      return;
    }
    this.markReply(bucket);

    let text = buffer.texts.join('\n').trim();
    const listen = settings.tts?.listen !== false;
    const allVoices = buffer.voices || [];
    const voices = allVoices.slice(0, 3);
    if (allVoices.length > voices.length) {
      addEvent('qq_voice_overflow', '一次发来太多语音，只听了前 3 条', { got: allVoices.length });
    }
    for (const voice of voices) {
      const heard = listen
        ? await transcribeRecord(voice, { fetchWav: (item) => this.fetchRecordWav(item) })
        : { text: '', engine: 'off', error: '设置里没开听语音' };
      if (heard.text) {
        text = `${text}${text ? ' ' : ''}（他刚发来一条语音，听内容是：${heard.text}）`;
        logger.info('听懂了这条语音', { chars: heard.text.length, engine: heard.engine });
        this.bumpHeard();
        addEvent('qq_voice_heard', `听懂了一条语音（${heard.engine}）`, { chars: heard.text.length });
      } else {
        const why = heard.error || '没听出内容';
        text = `${text}${text ? ' ' : ''}（他发了一条语音，但我这边没听出内容：${why}）`;
        addEvent('qq_voice_unheard', '收到一条语音，没识别出内容', { engine: heard.engine, error: why });
      }
    }
    const hadImages = buffer.images.length > 0;
    const images = [];
    let imageFailed = 0;
    for (const url of buffer.images.slice(0, 4)) {
      try {
        const dataUrl = (await imageUrlToDataUrl(url)) || imageDataUrlFromPath(url);
        if (dataUrl) images.push(dataUrl);
        else imageFailed += 1;
      } catch (error) {
        imageFailed += 1;
        logger.debug('图片读取失败', { error: error.message });
      }
    }
    if (imageFailed) {
      addEvent('qq_image_failed', `他发来的图片有 ${imageFailed} 张没读到`, {
        failed: imageFailed,
        tried: buffer.images.length,
      });
    }

    const hadImageCount = buffer.images.length;
    const isOwnerPrivate =
      buffer.target.type === 'private' && String(buffer.target.userId) === String(kvGet('qq_owner_id') || '');
    if (
      isOwnerPrivate &&
      settings.qq.learnImages !== false &&
      images.length &&
      (!text || /表情|贴纸|学/.test(text))
    ) {
      for (const dataUrl of images.slice(0, 2)) {
        try {
          const record = learnImage(dataUrl);
          if (record) {
            logger.info('学会图片表情', { file: record.file, bytes: record.bytes });
            addEvent('qq_learn_image', '学会了你发的一张图片表情', { file: record.file });
          }
        } catch (error) {
          logger.debug('图片表情学习跳过', { error: error.message });
        }
      }
    }

    let messageText = text;
    if (!messageText && hadImages) {
      messageText = images.length
        ? '（他发来了一张图片/表情包）'
        : `（他发来了 ${hadImageCount} 张图片，但我一张都没读到。别说你看见了，直接说图片没加载出来）`;
    } else if (messageText && hadImages && !images.length) {
      messageText = `${messageText}（他还附了 ${hadImageCount} 张图片，我这边没读到，别说你看见了）`;
    }
    if (buffer.target.type === 'group') {
      const context = buffer.groupContext ? `之前的群聊：\n${buffer.groupContext}\n` : '';
      messageText = `（你在 QQ 群 ${buffer.target.groupId} 里。${context}现在 ${buffer.nickname} 对群里说：${messageText}）`;
    }
    if (!messageText && !images.length) {
      if (!hadImages) return;
    }

    let extraContext = '';
    if (!buffer.guest && isOwnerPrivate && isQzonePostIntent(text)) {
      if (now - this.lastQzonePostAt < 60000) {
        extraContext = '他刚刚已经让你发过一条说说了，不要重复发；如果他问，就让他去 QQ 空间刷新看看。';
      } else {
        this.lastQzonePostAt = now;
        try {
          const post = await generatePost({ llm: this.companion.llm, kind: 'qzone' });
          const current = loadSettings();
          if (!current.social?.qzoneAutoPost) {
            extraContext = `他让你发 QQ 说说。你写好了草稿：「${post.content}」。自动发布没有开启，不要说你已经发了；让他去控制台「动态」里批准/发布。`;
          } else {
            const result = await tryAutoPublish(post);
            if (result.ok) {
              extraContext = `他让你发 QQ 说说。你已经真的发布成功：「${post.content}」。用你的口吻告诉他，提醒他去 QQ 空间刷新；不要编造额外内容。`;
            } else {
              extraContext = `他让你发 QQ 说说。你写了草稿：「${post.content}」，但真实发布失败：${result.reason || '未知错误'}。如实告诉他没发出去，草稿在控制台；不要说你发了。`;
            }
          }
        } catch (error) {
          extraContext = `他让你发 QQ 说说，但生成/发布时出错：${error.message}。如实告诉他这次没发成功。`;
        }
      }
    }

    const sleepy = this.isSleepyHours(settings);
    if (sleepy) {
      extraContext = `${extraContext ? `${extraContext}\n` : ''}现在是深夜，你已经困了：回复短一点、慢一点，别发长段，别发表情包，也别发语音。`;
    }

    try {
      const result = await this.companion.reply({
        text: messageText,
        images,
        channel: buffer.guest ? (buffer.target.type === 'group' ? 'qq-group' : 'qq-guest') : 'qq',
        sessionId: buffer.sessionId || undefined,
        displayName: buffer.nickname,
        extraContext,
      });
      this.assertCurrentWork();
      const allowExtras = !sleepy && loadSettings().qq.sendStickers !== false && !/别|不要|不想|不许/.test(messageText);
      const stickerCooling = Date.now() - Number(this.stickerTimes.get(this.stickerKey(buffer.target)) || 0) < 5 * 60000;
      const allowVoice = !sleepy && !buffer.guest && buffer.target.type === 'private';
      // 想用说的就用说的：短句语音直接替代文字，失败再补文字，不同时发两遍。
      const voiceSent = allowVoice ? await this.maybeSendVoice(result) : false;
      if (!voiceSent) {
        await this.delayFor(result.text);
        const chunks = splitForQQ(result.text);
        for (let i = 0; i < chunks.length; i += 1) {
          await this.sendToTarget(buffer.target, chunks[i]);
          if (i < chunks.length - 1) {
            await this.betweenBubbles(settings);
            if ((i + 1) % 12 === 0) await sleep(3000);
          }
        }
      }
      if (buffer.target.type === 'group') {
        this.rememberGroupMessage(buffer.target.groupId, settings.companion?.name || '小知', result.text);
      }
      this.lastError = null;
      const hint = allowExtras ? result.stickerHint || null : null;
      const explicitFace = allowExtras && /小黄脸|QQ表情|自带表情/.test(messageText) && !/表情包/.test(messageText);
      const explicitMface = allowExtras && /表情包|贴纸/.test(messageText);
      const wantsFace = hint === 'face' || (!hint && explicitFace);
      const wantsMface = hint === 'mface' || (!hint && explicitMface);
      const implicitImage = !hint && /这张|那张|喏|翻了翻|给你看|发你|换张/.test(result.text);
      const learnedImages = !buffer.guest && settings.qq.learnImages !== false ? listLearnedImages() : [];
      let nativeSent = false;

      if (allowExtras && !stickerCooling && wantsFace) {
        await sleep(600);
        try {
          await this.sendFaceToTarget(buffer.target, this.pickFaceId());
          nativeSent = true;
        } catch (error) {
          if (error.code === 'DELIVERY_UNKNOWN') throw error;
          logger.warn('QQ 小黄脸发送失败', { error: error.message });
        }
      } else if (allowExtras && !stickerCooling && hint && ['happy', 'shy', 'surprised', 'blink', 'normal'].includes(hint)) {
        await sleep(600);
        try {
          await this.sendStickerToTarget(buffer.target, hint);
          nativeSent = true;
        } catch (error) {
          if (error.code === 'DELIVERY_UNKNOWN') throw error;
          logger.warn('模型指定的角色表情发送失败', { hint, error: error.message });
        }
      } else if (allowExtras && !stickerCooling && wantsMface) {
        const learned = buffer.guest ? [] : kvGetJson('learned_mfaces', []);
        if (learned.length) {
          await sleep(600);
          const pick = learned[Math.floor(Math.random() * learned.length)];
          try {
            await this.sendMfaceToTarget(buffer.target, pick);
            nativeSent = true;
          } catch (error) {
            if (error.code === 'DELIVERY_UNKNOWN') throw error;
            logger.warn('QQ 表情包发送失败，改发图片', { error: error.message });
            addEvent('qq_mface_error', 'QQ表情包没发出去，改发图片（文字已送达）', { error: error.message });
          }
        }
      }

      if (allowExtras && !stickerCooling && !nativeSent && (wantsMface || implicitImage) && learnedImages.length) {
        const learnedImage = randomLearnedImage() || learnedImages[learnedImages.length - 1];
        await sleep(600);
        try {
          await this.sendLearnedImageToTarget(buffer.target, learnedImage);
          nativeSent = true;
        } catch (error) {
          if (error.code === 'DELIVERY_UNKNOWN') throw error;
          logger.warn('学到的图片表情发送失败', { error: error.message });
        }
      }

      if (allowExtras && !stickerCooling && !nativeSent) {
        let sticker = null;
        if (implicitImage || wantsMface) {
          sticker = pickSticker({ text: '表情包', reply: result.text, settings });
        } else {
          sticker = pickSticker({ text: messageText, reply: result.text, settings });
        }
        if (sticker) {
          await sleep(700);
          try {
            await this.sendStickerToTarget(buffer.target, sticker);
            nativeSent = true;
          } catch (error) {
            if (error.code === 'DELIVERY_UNKNOWN') throw error;
            logger.warn('角色表情包发送失败', { sticker, error: error.message });
            addEvent('qq_sticker_error', '表情包没发出去（文字已送达）', { error: error.message });
          }
        }
      }

      if (nativeSent) this.stickerTimes.set(this.stickerKey(buffer.target), Date.now());
      if (!sleepy) {
        this.scheduleSelfFollowUp({
          conversationKey,
          target: buffer.target,
          guest: buffer.guest,
          hisText: text,
          replyText: result.text,
        });
      }
    } catch (error) {
      this.lastError = error.message;
      addEvent('qq_error', 'QQ 回复失败，已把错误记在控制台', { error: error.message });
      if (error.code !== 'DELIVERY_UNKNOWN') {
        try { await this.sendToTarget(buffer.target, '呜，我这边卡了一下……等下再跟我说一次好不好'); }
        catch { /* 通道已断开 */ }
      }
      throw error;
    }
  }

  followUpBudget() {
    const settings = loadSettings();
    const now = Date.now();
    this.followUpTimestamps = this.followUpTimestamps.filter((t) => now - t < FOLLOW_UP_HOUR_MS);
    const dayKey = `qq_follow_up_day:${shanghaiDayKey()}`;
    return {
      settings,
      dayKey,
      today: Number(kvGet(dayKey, '0') || 0),
      hour: this.followUpTimestamps.length,
      dayMax: Number(settings.qq?.selfFollowUpMaxPerDay ?? 6),
      hourMax: Number(settings.qq?.selfFollowUpMaxPerHour ?? 2),
    };
  }

  cancelFollowUp(conversationKey) {
    const timer = this.followUpTimers.get(conversationKey);
    if (!timer) return;
    clearTimeout(timer);
    this.followUpTimers.delete(conversationKey);
  }

  scheduleSelfFollowUp({ conversationKey, target, guest, hisText, replyText }) {
    const budget = this.followUpBudget();
    const qq = budget.settings.qq || {};
    if (!qq.selfFollowUp || guest || target?.type !== 'private') return;
    if (costBlocked('selfFollowUp')) {
      noteCostSkip('自己接话', '余额到线，先不接');
      return;
    }
    if (budget.hour >= budget.hourMax || budget.today >= budget.dayMax) return;
    const chance = Number(qq.selfFollowUpChance ?? 0.25);
    if (chance <= 0 || Math.random() >= chance) return;
    if (!this.clients.size) return;

    const scheduledAt = Date.now();
    this.cancelFollowUp(conversationKey);
    const timer = setTimeout(() => {
      this.followUpTimers.delete(conversationKey);
      this.outboundScope.run(target, () => this.runSelfFollowUp({ conversationKey, target, hisText, replyText, scheduledAt })).catch((error) => {
        this.lastError = error.message;
        logger.warn('自己接话失败', { error: error.message });
      });
    }, followUpDelayMs(budget.settings));
    if (timer.unref) timer.unref();
    this.followUpTimers.set(conversationKey, timer);
  }

  async runSelfFollowUp({ conversationKey, target, hisText, replyText, scheduledAt }) {
    if (!this.clients.size) return;
    if ((this.lastInboundAt.get(conversationKey) || 0) > scheduledAt) return;
    if (this.buffers.has(conversationKey)) return;

    const budget = this.followUpBudget();
    if (!budget.settings.qq?.selfFollowUp) return;
    if (budget.hour >= budget.hourMax || budget.today >= budget.dayMax) return;

    const messages = [
      { role: 'system', content: '你是「她」的接话判断器，只输出严格 JSON。' },
      {
        role: 'user',
        content: buildSelfFollowUpPrompt({
          settings: budget.settings,
          mood: getMood(),
          herText: replyText,
          hisText,
          waitedSeconds: (Date.now() - scheduledAt) / 1000,
        }),
      },
    ];
    const result = await this.companion.llm.chat(messages, {
      kind: 'follow_up',
      model: budget.settings.model.name,
      maxTokens: 250,
      temperature: 0.9,
      reasoningEffort: 'low',
      responseFormat: { type: 'json_object' },
      mockKind: 'follow_up',
    });
    const decision = parseFollowUpDecision(result.content);
    if (!decision.send) {
      logger.debug('她决定这次不补话', { reason: decision.reason });
      return;
    }
    if ((this.lastInboundAt.get(conversationKey) || 0) > scheduledAt) return;

    await sleep(Math.min(4200, 900 + decision.text.length * 40));
    if ((this.lastInboundAt.get(conversationKey) || 0) > scheduledAt || !loadSettings().qq.selfFollowUp || costBlocked('selfFollowUp')) return;
    for (const [index, chunk] of splitForQQ(decision.text).entries()) {
      if ((this.lastInboundAt.get(conversationKey) || 0) > scheduledAt) return;
      await this.sendToTarget(target, chunk);
      if (index < splitForQQ(decision.text).length - 1) await sleep(350);
    }
    const saved = this.companion.saveFollowUpMessage(decision.text, 'qq');
    if (!saved) return;
    this.followUpTimestamps.push(Date.now());
    kvSet(budget.dayKey, String(Number(kvGet(budget.dayKey, '0')) + 1));
    addEvent('qq_follow_up', '她自己接了一句', { text: saved.content, reason: decision.reason });
  }

  async runOwnerCommand(command, target) {
    const settings = loadSettings();
    const social = settings.social || {};
    let reply = '';
    if (command === 'auto_on' || command === 'auto_off') {
      if (!this.onCommand) return;
      const on = command === 'auto_on';
      const result = await this.onCommand('auto', { on });
      reply = on
        ? `行，自动运营开了：每天最多发 ${(result && result.publishPerDay) || social.xhsPublishPerDay || 1} 条、评论 ${(result && result.commentMax) || social.xhsDailyCommentMax || 4} 条，遇到验证我自己停。`
        : '好，我把小红书的自动运营停了，只留你叫我我才动。';
    } else if (command === 'browse' || command === 'publish' || command === 'status' || command === 'today') {
      if (!this.onCommand) return;
      reply = await this.onCommand(command, { target });
    } else if (command === 'voice') {
      const result = await this.companion.reply({
        text: '用语音跟我说句话',
        channel: 'qq',
        extraContext: '他按了「发条语音」。你要真的用声音回他一句，短一点、自然一点，别报数字。',
      });
      try {
        await this.sendVoiceAndCount(result.text, { source: 'owner_command' });
      } catch (error) {
        logger.warn('QQ 口令发语音失败，改成文字', { error: error.message });
        reply = result.text;
      }
    }
    if (reply) {
      for (const chunk of splitForQQ(reply)) {
        await this.sendToTarget(target, chunk);
        await sleep(300);
      }
    }
  }

  async maybeSendVoice(result) {
    const settings = loadSettings();
    const tts = settings.tts || {};
    if (!tts.enabled) return false;
    const text = String(result.text || '').trim();
    if (text.length < 4 || text.includes('http') || text.includes('://')) return false;
    const maxChars = Number(tts.maxChars ?? 120);
    const explicit = result.voice === true;
    const mood = getMood();
    const chance = Math.min(
      0.55,
      Number(tts.chance ?? 0.18) * (0.6 + Math.min(1, mood.affection / 100)) * (0.55 + mood.energy * 0.9),
    );
    // 真人不会把一大段话忽然改成语音；只有短句、情绪到位时才用说的。
    const wants = explicit ? text.length <= maxChars * 1.25 : text.length <= 60 && Math.random() < chance;
    if (!wants) return false;
    if (costBlocked('voice')) {
      noteCostSkip('发语音', '余额到线，先用打字说');
      return false;
    }
    if (!this.voiceBudgetLeft().ok) return false;
    const spoken = explicit && text.length > maxChars ? text.slice(0, maxChars).replace(/[，,。.!！?？；;：:][^，,。.!！?？；;：:]*$/, '') : text;
    const baseRate = Number(String(tts.rate || '+8%').replace('%', '')) || 8;
    const basePitch = Number(String(tts.pitch || '+2Hz').replace(/[^\d+-]/g, '')) || 2;
    const rate = `${Math.round(baseRate + (mood.energy - 0.5) * 8)}%`;
    const pitch = `${Math.round(basePitch + mood.valence * 2)}Hz`;
    try {
      await this.sendVoiceAndCount(spoken, {
        source: explicit ? 'model' : 'chance',
        rate: rate.startsWith('-') || rate.startsWith('+') ? rate : `+${rate}`,
        pitch: pitch.startsWith('-') || pitch.startsWith('+') ? pitch : `+${pitch}`,
      });
      return true;
    } catch (error) {
      if (error.code === 'DELIVERY_UNKNOWN') throw error;
      logger.warn('语音没发出去（文字照发）', { error: error.message });
      return false;
    }
  }

  voiceCountToday() {
    return Number(kvGet(`voice_day:${shanghaiDayKey()}`, '0') || 0);
  }

  bumpVoiceCount(delta = 1) {
    const key = `voice_day:${shanghaiDayKey()}`;
    kvSet(key, String(Math.max(0, Number(kvGet(key, '0') || 0) + delta)));
  }

  heardToday() {
    return Number(kvGet(`heard_day:${shanghaiDayKey()}`, '0') || 0);
  }

  bumpHeard() {
    kvSet(`heard_day:${shanghaiDayKey()}`, String(this.heardToday() + 1));
  }

  voiceBudgetLeft() {
    const tts = loadSettings().tts || {};
    if (!tts.enabled) return { ok: false, reason: '设置里没开发语音' };
    const max = Number(tts.maxPerDay ?? 8);
    const today = this.voiceCountToday();
    if (today >= max) return { ok: false, reason: `今天的语音额度用完了（${today}/${max}）` };
    return { ok: true, today, max };
  }

  async sendVoiceAndCount(text, { source = 'self', voice = '', rate = '', pitch = '' } = {}) {
    const owner = kvGet('qq_owner_id');
    if (!owner) throw new Error('还没绑定主人 QQ，语音不知道发给谁');
    const budget = this.voiceBudgetLeft();
    if (!budget.ok) throw new Error(budget.reason);
    const clean = String(text || '').trim();
    if (clean.length < 4) throw new Error('太短了，不值得用说的');
    if (clean.includes('http') || clean.includes('://')) throw new Error('带链接的话还是打字发');
    const tts = loadSettings().tts || {};
    const generation = this.generation;
    this.bumpVoiceCount(1);
    let audio = null;
    try {
      audio = await this.synthesizeSpeech(clean, {
        voice: voice || tts.voice,
        rate: rate || tts.rate,
        pitch: pitch || tts.pitch,
        maxChars: Number(tts.maxChars ?? 120),
      });
      if (generation !== this.generation || owner !== kvGet('qq_owner_id')) throw Object.assign(new Error('账号已改变，取消旧语音'), { name: 'AbortError', code: 'ABORT_ERR' });
      const sent = await this.sendRecordToTarget({ type: 'private', userId: owner }, audio.file);
      addEvent('qq_voice', `她用语音说了一句（${audio.voice || audio.engine}）`, {
        chars: audio.text.length,
        bytes: audio.bytes,
        engine: audio.engine,
        voice: audio.voice,
        source,
      });
      return { ...audio, sent };
    } catch (error) {
      if (error.code !== 'DELIVERY_UNKNOWN') this.bumpVoiceCount(-1);
      if (error.message !== budget.reason) {
        addEvent('qq_voice_error', '语音没发出去', { error: error.message, source });
      }
      throw error;
    } finally {
      if (audio?.file) {
        try {
          fs.unlinkSync(audio.file);
        } catch {
          // 已经没了
        }
      }
    }
  }

  async fetchRecordWav(voice = {}) {
    const direct = String(voice.file || '').trim();
    if (direct && fs.existsSync(direct) && /\.wav$/i.test(direct)) return direct;
    const candidates = [];
    if (direct && fs.existsSync(direct)) candidates.push(direct);
    if (voice.file_id) candidates.push(String(voice.file_id).trim());
    if (direct) candidates.push(direct);
    if (voice.url) candidates.push(String(voice.url).trim());
    const keys = [...new Set(candidates.filter(Boolean))];
    const deadline = Date.now() + 15000;
    if (!keys.length) {
      addEvent('qq_record_no_file', '语音消息没带文件标识，转不了', { keys: Object.keys(voice).join(',') });
      return '';
    }
    const tried = [];
    for (const key of keys) {
      try {
        if (Date.now() >= deadline) break;
        const res = await this.sendAction('get_record', { file: key, out_format: 'wav' }, Math.max(1, deadline - Date.now()));
        const file = String(res?.data?.file || '').trim();
        if (res?.status === 'ok' && file && fs.existsSync(file)) return file;
        tried.push(`${path.basename(key).slice(0, 24)}:${res?.retcode ?? '?'}`);
      } catch (error) {
        tried.push(`${path.basename(key).slice(0, 24)}:${error.message.slice(0, 24)}`);
      }
    }
    logger.warn('QQ 语音转 wav 没成功', { tried: tried.join('|') });
    addEvent('qq_record_convert_error', 'QQ 语音没能转成 wav', { tried: tried.join('|') });
    return '';
  }

  async sendRecordToTarget(target, file) {
    if (!target?.userId) throw new Error('没有主人 QQ，语音不知道发给谁');
    const params = {
      user_id: Number(target.userId),
      message: [{ type: 'record', data: { file: String(file) } }],
    };
    const res = await this.sendAction('send_private_msg', params, 60000);
    logger.info('已发送 QQ 语音', { file: path.basename(String(file)) });
    return res;
  }
  async echoCheck(text) {
    const owner = kvGet('qq_owner_id');
    if (!owner) return { ok: false, step: 'owner', reason: '还没绑定主人 QQ' };
    const audio = await this.sendVoiceAndCount(String(text || '').slice(0, 60) || '这一条是自检，我把发出去的语音再听一遍。', {
      source: 'echo',
    });
    const messageId = audio.sent?.data?.message_id;
    if (!messageId) return { ok: false, step: 'send', reason: '发送没回 message_id', engine: audio.engine, voice: audio.voice };
    const msg = await this.sendAction('get_msg', { message_id: messageId }, 20000).catch((error) => ({ errorMessage: error.message }));
    const seg = (msg?.data?.message || []).find((item) => item.type === 'record');
    if (!seg) {
      addEvent('voice_echo_fail', '发出去的语音回读不到语音段', { messageId, error: msg?.errorMessage || '' });
      return { ok: false, step: 'get_msg', reason: msg?.errorMessage || '回读不到 record 段', messageId };
    }
    const wav = await this.fetchRecordWav(seg.data || {});
    if (!wav) {
      addEvent('voice_echo_fail', 'QQ 里的语音转不成 wav，链路停在转码', { messageId });
      return { ok: false, step: 'get_record', reason: '转不成 wav', messageId };
    }
    const heard = await transcribeWav(wav);
    if (!heard.text) {
      addEvent('voice_echo_fail', '转出了 wav，但没听出内容', { messageId, error: heard.error || '' });
      return { ok: false, step: 'asr', reason: heard.error || '没听出内容', messageId };
    }
    addEvent('voice_echo_ok', `她把自己发出去的语音又听回来了（${heard.engine}）`, { messageId, chars: heard.text.length });
    return {
      ok: true,
      messageId,
      engine: audio.engine,
      voice: audio.voice,
      said: audio.text,
      heard: heard.text,
      seconds: seg.data?.voice_wts ?? seg.data?.seconds ?? null,
    };
  }

  async delayFor(text) {
    const settings = loadSettings();
    const len = String(text || '').length;
    if (this.isSleepyHours(settings)) {
      await sleep(8000 + Math.random() * 12000);
      return;
    }
    const base = Math.min(4200, 500 + len * 30);
    await sleep(base * (0.7 + Math.random() * 0.6));
  }

  isSleepyHours(settings = null) {
    const s = settings || loadSettings();
    if (s.qq?.sleepyMode === false) return false;
    const hour = localHour();
    return hour >= 0.5 && hour < 8.5;
  }

  async betweenBubbles(settings = null) {
    const s = settings || loadSettings();
    await sleep(this.isSleepyHours(s) ? 1200 + Math.random() * 1600 : 250 + Math.random() * 650);
  }

  async sendToTarget(target, text) {
    if (target.type === 'private') {
      return this.sendAction('send_private_msg', {
        user_id: Number(target.userId),
        message: [{ type: 'text', data: { text } }],
      });
    }
    return this.sendAction('send_group_msg', {
      group_id: Number(target.groupId),
      message: [{ type: 'text', data: { text } }],
    });
  }

  async sendToOwner(text) {
    const owner = kvGet('qq_owner_id');
    if (!owner || !this.clients.size) return false;
    const chunks = splitForQQ(text);
    for (const chunk of chunks) {
      await this.sendToTarget({ type: 'private', userId: owner }, chunk);
      await sleep(350);
    }
    return true;
  }

  stickerKey(target) { return target.type === 'private' ? 'private:' + target.userId : 'group:' + target.groupId; }
  assertStickerEnabled() {
    this.assertCurrentWork();
    if (loadSettings().qq.sendStickers === false) throw new Error('表情发送开关已关闭');
  }

  async sendStickerToTarget(target, name) {
    this.assertStickerEnabled();
    const base64 = getStickerBase64(name);
    if (!base64) throw new Error(`表情包不存在：${name}`);
    const params =
      target.type === 'private'
        ? { user_id: Number(target.userId), message: [{ type: 'image', data: { file: `base64://${base64}` } }] }
        : { group_id: Number(target.groupId), message: [{ type: 'image', data: { file: `base64://${base64}` } }] };
    const res = await this.sendAction(target.type === 'private' ? 'send_private_msg' : 'send_group_msg', params);
    logger.info('已发送角色表情包', { name, target: target.type });
    return res;
  }

  async sendStickerToOwner(name = 'happy') {
    const owner = kvGet('qq_owner_id');
    if (!owner || !this.clients.size) return false;
    await this.sendStickerToTarget({ type: 'private', userId: owner }, name);
    return true;
  }

  pickFaceId() {
    const mood = getMood();
    if (mood.valence < -0.2) return 15;
    if (mood.affection > 40) return 6;
    if (mood.energy > 0.75) return 21;
    return 14;
  }

  async sendFaceToTarget(target, id = 14) {
    this.assertStickerEnabled();
    const params =
      target.type === 'private'
        ? { user_id: Number(target.userId), message: [{ type: 'face', data: { id: String(id) } }] }
        : { group_id: Number(target.groupId), message: [{ type: 'face', data: { id: String(id) } }] };
    const res = await this.sendAction(target.type === 'private' ? 'send_private_msg' : 'send_group_msg', params);
    logger.info('已发送 QQ 小黄脸', { id, target: target.type });
    return res;
  }

  async sendFaceToOwner(id = 14) {
    const owner = kvGet('qq_owner_id');
    if (!owner || !this.clients.size) return false;
    await this.sendFaceToTarget({ type: 'private', userId: owner }, id);
    return true;
  }

  async sendMfaceToTarget(target, mface) {
    this.assertStickerEnabled();
    if (!mface?.emoji_id) throw new Error('不是有效的 QQ 表情包');
    const data = {
      emoji_id: String(mface.emoji_id),
      emoji_package_id: String(mface.emoji_package_id || ''),
      key: String(mface.key || ''),
      summary: String(mface.summary || '[表情包]'),
    };
    if (mface.url) data.url = String(mface.url);
    const params =
      target.type === 'private'
        ? { user_id: Number(target.userId), message: [{ type: 'mface', data }] }
        : { group_id: Number(target.groupId), message: [{ type: 'mface', data }] };
    const res = await this.sendAction(target.type === 'private' ? 'send_private_msg' : 'send_group_msg', params);
    logger.info('已发送 QQ 表情包', { emojiId: data.emoji_id, target: target.type });
    return res;
  }

  async sendMfaceToOwner() {
    const owner = kvGet('qq_owner_id');
    if (!owner || !this.clients.size) return false;
    const learned = kvGetJson('learned_mfaces', []);
    if (!learned.length) return false;
    await this.sendMfaceToTarget({ type: 'private', userId: owner }, learned[learned.length - 1]);
    return true;
  }

  learnedMfaceCount() {
    return kvGetJson('learned_mfaces', []).length;
  }

  async sendLearnedImageToTarget(target, record) {
    this.assertStickerEnabled();
    if (!record?.file) throw new Error('没有可用的图片表情');
    const base64 = getLearnedImageBase64(record);
    if (!base64) throw new Error('图片表情文件为空');
    const params =
      target.type === 'private'
        ? { user_id: Number(target.userId), message: [{ type: 'image', data: { file: `base64://${base64}` } }] }
        : { group_id: Number(target.groupId), message: [{ type: 'image', data: { file: `base64://${base64}` } }] };
    const res = await this.sendAction(target.type === 'private' ? 'send_private_msg' : 'send_group_msg', params);
    logger.info('已发送学到的图片表情', { file: record.file, target: target.type });
    return res;
  }

  async sendLearnedImageToOwner() {
    const owner = kvGet('qq_owner_id');
    if (!owner || !this.clients.size) return false;
    const record = lastLearnedImage();
    if (!record) return false;
    await this.sendLearnedImageToTarget({ type: 'private', userId: owner }, record);
    return true;
  }

  learnedImageCount() {
    return listLearnedImages().length;
  }

  identityCheck(selfId = null) {
    const settings = loadSettings();
    return checkBotIdentity({
      selfId: selfId ?? this.selfId,
      ownerId: kvGet('qq_owner_id'),
      botAccount: settings.qq?.botAccount,
    });
  }

  noteIdentityMismatch(reason) {
    this.identityError = reason;
    this.lastError = reason;
    const last = Number(kvGet('qq_identity_alert_at', '0') || 0);
    if (Date.now() - last < 10 * 60000) return;
    kvSet('qq_identity_alert_at', String(Date.now()));
    logger.warn('QQ 身份不匹配，已拒绝发送', { reason });
    addEvent('qq_identity_mismatch', `她拒绝发消息：${reason}`, { reason });
  }

  assertCurrentWork() {
    const scope = this.outboundScope.getStore();
    if (this.destroyed || scope && (scope.generation !== this.generation || scope.ownerId && scope.ownerId !== String(kvGet('qq_owner_id') || ''))) {
      throw Object.assign(new Error('账号或通道已改变，取消旧任务'), { name: 'AbortError', code: 'ABORT_ERR' });
    }
  }

  sendAction(action, params, timeoutMs = 30000) {
    try { this.assertCurrentWork(); } catch (error) { return Promise.reject(error); }
    const settings = loadSettings();
    if (!settings.qq.enabled || this.destroyed) return Promise.reject(new Error('QQ 通道已停用'));
    const guarded = !['get_login_info', 'get_status'].includes(action);
    const ready = [...this.clients].filter((client) => client.readyState === 1 && (client.isAlive !== false || Date.now() - (client.lastPongAt || 0) < 30000));
    const ownerId = kvGet('qq_owner_id');
    const matching = ready.find((client) => checkBotIdentity({ selfId: client.selfId, ownerId, botAccount: settings.qq.botAccount }).ok);
    const ws = guarded ? matching : matching || ready[0];
    if (!ws) {
      if (guarded && ready.length) {
        const identity = this.identityCheck();
        const reason = identity.ok ? '当前连接还没有确认机器人身份' : identity.reason;
        this.noteIdentityMismatch(reason);
        return Promise.reject(new Error(reason));
      }
      return Promise.reject(new Error('NapCat 还没连上'));
    }
    if (this.pending.size >= 40) return Promise.reject(new Error('QQ 请求排队太满，先等一下再试'));
    const echo = `bz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        const error = String(action).startsWith('send_') ? new DeliveryUnknownError('QQ 发送结果未知，请先核实，未自动重发') : new Error('OneBot 调用超时');
        this.lastError = error.message;
        reject(error);
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer, ws, action });
      ws.send(JSON.stringify({ action, params, echo }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(echo);
          reject(error);
        }
      });
    });
  }

  status() {
    const owner = kvGet('qq_owner_id') || '';
    const candidate = kvGetJson('qq_owner_candidate', null);
    const budget = this.followUpBudget();
    const identity = this.identityCheck();
    return {
      connected: this.clients.size > 0,
      clients: this.clients.size,
      selfId: this.selfId || kvGet('qq_self_id') || '',
      identityOk: identity.ok,
      identityError: identity.ok ? '' : identity.reason,
      ownerIdMasked: maskQq(owner),
      followUp: {
        enabled: Boolean(budget.settings.qq?.selfFollowUp),
        chance: Number(budget.settings.qq?.selfFollowUpChance ?? 0.25),
        pending: this.followUpTimers.size,
        today: budget.today,
        dayMax: budget.dayMax,
        thisHour: budget.hour,
        hourMax: budget.hourMax,
      },
      candidate: candidate
        ? { userId: maskQq(candidate.userId), nickname: candidate.nickname || '', at: candidate.at || null }
        : null,
      lastEventAt: this.lastEventAt,
      downMinutes: this.downSince ? Math.round((Date.now() - this.downSince) / 60000) : 0,
      autoRecover: Boolean(budget.settings.qq?.autoRecover),
      voice: {
        enabled: Boolean(budget.settings.tts?.enabled),
        today: this.voiceCountToday(),
        maxPerDay: Number(budget.settings.tts?.maxPerDay ?? 8),
        voice: budget.settings.tts?.voice || '',
        listen: budget.settings.tts?.listen !== false,
        heardToday: this.heardToday(),
      },
      recoverAttemptsLastHour: this.recoverTimestamps.filter((t) => Date.now() - t < 3600000).length,
      recoverError: this.recoverError ? logger.redact(this.recoverError) : null,
      lastError: this.lastError ? logger.redact(this.lastError) : null,
      wsUrl: `ws://127.0.0.1:${env.port}/onebot`,
    };
  }

  cancelPending() {
    this.generation = (this.generation || 0) + 1;
    for (const key of [...this.followUpTimers.keys()]) this.cancelFollowUp(key);
    for (const buffer of this.buffers.values()) if (buffer.timer) clearTimeout(buffer.timer);
    this.buffers.clear();
  }

  disconnectAll(reason = 'qq disabled') {
    this.cancelPending();
    this.selfId = null;
    for (const ws of this.clients) {
      try {
        ws.close(1008, reason);
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    for (const key of [...this.followUpTimers.keys()]) this.cancelFollowUp(key);
    for (const buffer of this.buffers.values()) if (buffer.timer) clearTimeout(buffer.timer);
    this.buffers.clear();
    for (const [echo, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(echo);
      entry.reject(new Error('QQ 通道已关闭'));
    }
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.heartbeat);
    for (const key of [...this.followUpTimers.keys()]) this.cancelFollowUp(key);
    for (const buffer of this.buffers.values()) if (buffer.timer) clearTimeout(buffer.timer);
    this.buffers.clear();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('服务关闭'));
    }
    this.pending.clear();
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    setTimeout(() => this.wss.close(), 100);
  }
}
