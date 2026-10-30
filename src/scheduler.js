import { loadSettings } from './config.js';
import {
  addEvent,
  addPost,
  getActiveSession,
  getRecentMessages,
  kvGet,
  kvGetJson,
  kvSet,
  kvSetJson,
  costSummary,
  lastUserMessageAt,
  maintenance,
  recentUserMessages,
} from './db.js';
import { costBlocked, evaluateBudget, noteCostSkip, readCostState, writeCostState } from './budget.js';
import { logger } from './logger.js';
import { dailyDiary, getMemoryBlock, listDailyDigests, weeklyDiary } from './memory.js';
import { getQzoneFeedCache, qzoneStatus, refreshQzoneFeed, sendQzoneComment, verifyQzoneCookie } from './channels/qzone.js';
import { getMood } from './mood.js';
import { addIntention, bumpIntention, listIntentions, pickDueIntention } from './intentions.js';
import { canSendXhsDm, discoverSelfProfile, getRecentXhsActivity, isRiskyError, noteXhsDmSent, recordXhsActivity, triggerXhsCooldown } from './channels/xhs-actions.js';
import { assertPublicContent, TOPIC_HINTS } from './privacy.js';
import { buildDreamPrompt, buildXhsDmReplyPrompt, buildXhsNoteWillPrompt } from './prompt.js';
import {
  buildQzoneCommentDecisionPrompt,
  buildQzoneCommentReplyPrompt,
  buildSystemPrompt,
} from './prompt.js';
import { generatePost, PLATFORM_LABELS, tryAutoPublish } from './social.js';
import { isWithinWindow, localHour, nextShanghaiClock, nowIso, parseJsonLoose, randInt, shanghaiDayKey, sleep } from './util.js';
import { processXhsExplore, processXhsOwnComments } from './channels/xhs-actions.js';

function localDayKey(date = new Date()) {
  return shanghaiDayKey(date);
}

function readCount(key) {
  return Number(kvGet(key, '0') || 0);
}

function bumpCount(key) {
  kvSet(key, String(readCount(key) + 1));
}

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600000).toISOString();
}

export class Scheduler {
  constructor({ llm, companion, sendToOwner = null, refreshQzoneCookie = null, random = Math.random }) {
    this.llm = llm;
    this.random = random;
    this.companion = companion;
    this.sendToOwner = sendToOwner;
    this.refreshQzoneCookie = refreshQzoneCookie;
    this.timer = null;
    this.busy = false;
    this.manualBusy = false;
    this.qzoneBusy = false;
    this.lastTick = null;
    this.lastError = null;
    this.lastQzonePollError = null;
    this.qzoneTimer = null;
    this.xhsTimer = null;
    this.xhsBusy = false;
    this.lastXhsError = null;
    this.tickFailAt = new Map();
  }

  async manual(task) {
    if (this.busy || this.manualBusy) throw new Error('她正在处理别的事，等这一轮完成再试');
    this.manualBusy = true;
    try {
      return await task();
    } finally {
      this.manualBusy = false;
    }
  }

  start() {
    if (this.timer) return;
    this.scheduleProactive();
    if (!kvGet('next_post_at')) this.schedulePost();
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.lastError = error.message;
        logger.warn('调度器 tick 失败', { error: error.message });
      });
    }, 30000);
    this.qzoneTimer = setInterval(() => {
      this.pollQzone().catch((error) => {
        this.lastQzonePollError = error.message;
        logger.warn('空间轮询失败', { error: error.message });
      });
    }, 15 * 60 * 1000);
    if (!kvGet('next_xhs_at')) kvSet('next_xhs_at', hoursFromNow(1));
    this.xhsTimer = setInterval(() => {
      this.pollXhs().catch((error) => {
        this.lastXhsError = error.message;
        logger.warn('小红书轮询失败', { error: error.message });
        if (isRiskyError(error)) triggerXhsCooldown(6, error.message);
      });
    }, 10 * 60 * 1000);
    logger.info('主动行为调度器已启动');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.qzoneTimer) clearInterval(this.qzoneTimer);
    if (this.xhsTimer) clearInterval(this.xhsTimer);
    this.timer = null;
    this.qzoneTimer = null;
    this.xhsTimer = null;
    this.xhsTimer = null;
    this.xhsBusy = false;
    this.lastXhsError = null;
  }

  async pollQzone() {
    if (this.costGate('qzoneAuto', '空间自动回复')) return null;
    if (!qzoneStatus().configured || this.qzoneBusy) return null;
    this.qzoneBusy = true;
    try {
      const feed = await refreshQzoneFeed();
      this.lastQzonePollError = null;
      await this.processQzoneAutoReplies(feed);
      return feed;
    } catch (error) {
      if (this.lastQzonePollError !== error.message) {
        addEvent('qzone_poll_error', '空间轮询失败', { error: error.message });
      }
      this.lastQzonePollError = error.message;
      logger.warn('空间说说轮询失败', { error: error.message });
      return null;
    } finally {
      this.qzoneBusy = false;
    }
  }

  async runQzoneAutoReply({ force = true } = {}) {
    if (this.qzoneBusy) return { replied: [], skipped: '正在检查空间，稍等' };
    this.qzoneBusy = true;
    try {
      const feed = await refreshQzoneFeed();
      return await this.processQzoneAutoReplies(feed, { force });
    } finally {
      this.qzoneBusy = false;
    }
  }

  async pollXhs() {
    const { withXhsBrowser } = await import('./channels/xhs.js');
    return withXhsBrowser(() => this.pollXhsLocked());
  }

  async pollXhsLocked() {
    const settings = loadSettings();
    if (!settings.social?.xhsEnabled) return null;
    if (this.costGate('xhsAuto', '小红书自动互动')) return null;
    if (!isWithinWindow(settings.social.activeStart, settings.social.activeEnd)) return null;
    const due = kvGet('next_xhs_at');
    // 私信要每 10 分钟看一次；逛/评论仍按 next_xhs_at 的 2–3.5 小时节奏，不能因为没到点就不读私信。
    const browseDue = !due || new Date(due).getTime() <= Date.now();
    if (this.xhsBusy) return null;
    this.xhsBusy = true;
    try {
      try {
        const { readXhsNotificationBadge } = await import('./channels/xhs.js');
        const badge = await readXhsNotificationBadge();
        if (badge > 0) addEvent('xhs_notify', `小红书上有 ${badge} 条新通知`, { badge });
      } catch (error) {
        this.lastXhsError = error.message;
        logger.warn('读小红书通知角标失败', { error: error.message });
        addEvent('xhs_badge_failed', '这次没读到通知角标', { error: String(error.message).slice(0, 100) });
      }
      try {
        const { readXhsDirectMessages } = await import('./channels/xhs.js');
        const dm = await readXhsDirectMessages();
        for (const item of dm.fresh || []) {
          recordXhsActivity({
            type: item.isOwner ? 'dm_owner' : 'dm',
            text: item.preview || '',
            target: item.name || '',
            note: item.time || '',
          });
          addEvent('xhs_dm', `小红书私信：${item.name || '有人'} 说「${String(item.preview || '').slice(0, 40)}」`, {
            owner: Boolean(item.isOwner),
          });
        }
        await this.autoReplyOwnerDm(dm.items || [], settings);
      } catch (error) {
        logger.warn('读小红书私信失败', { error: error.message });
        addEvent('xhs_dm_failed', '这次没读到私信列表', { error: String(error.message).slice(0, 100) });
      }
      try {
        const day = localDayKey();
        if (kvGet('xhs_graph_day') !== day) {
          const { readXhsFollowGraph, readCachedXhsStats, readXhsOwnerProfile } = await import('./channels/xhs.js');
          let profileUrl = kvGet('xhs_profile_url') || (readCachedXhsStats() || {}).profileUrl || '';
          if (!profileUrl) {
            const self = await discoverSelfProfile().catch(() => null);
            profileUrl = (self && self.url) || '';
          }
          const graph = profileUrl
            ? await readXhsFollowGraph(profileUrl)
            : { ok: false, reason: '还没拿到她自己主页地址', fans: { count: 0, names: [] }, following: { count: 0, names: [] } };
          if (!graph.ok) {
            addEvent('xhs_graph_failed', '这次没读到关注/粉丝名单，不当成"没有粉丝"', { reason: graph.reason || '页面没打开名单' });
          } else {
            kvSet('xhs_graph_day', day);
          }
    if (!graph.ok) return;
          const before = Number(kvGet('xhs_fans_count', '0') || 0);
          const now = Number(graph?.fans?.count || 0);
          if (before && now !== before) {
            recordXhsActivity({ type: 'fans', text: `粉丝从 ${before} 变成 ${now}`, target: (graph?.fans?.names || []).slice(0, 5).join('、') });
            addEvent('xhs_fans', `小红书粉丝数变了：${before} → ${now}`);
          }
          if (now) kvSet('xhs_fans_count', String(now));
          const ownerNames = [...((graph?.fans?.names) || []), ...((graph?.following?.names) || [])];
          const ownerName = settings.social?.xhsOwnerName || '';
          if (ownerName && ownerNames.includes(ownerName)) {
            const profile = await readXhsOwnerProfile().catch(() => null);
            if (profile?.userId) {
              recordXhsActivity({
                type: 'dm_owner',
                text: `主人的小红书号 ${profile.number || '未知'}，${profile.ipLocation ? `IP属地 ${profile.ipLocation}` : ''}`,
                target: profile.name || ownerName,
                note: '认出来了',
              });
            }
          }
        }
      } catch (error) {
        logger.warn('读小红书关注关系失败', { error: error.message });
        addEvent('xhs_graph_failed', '读关注关系这一步整个失败', { error: String(error.message).slice(0, 100) });
      }
      if (!browseDue) return { actions: [], dmChecked: true };
      const result = await this.runXhs({ browse: settings.social.xhsAutoBrowse, reply: settings.social.xhsAutoReply, internal: true });
      if (result.actions?.length) {
        this.lastXhsError = null;
        addEvent('xhs_run', `小红书自动互动完成，共 ${result.actions.length} 条`);
      }
      return result;
    } catch (error) {
      this.lastXhsError = error.message;
      addEvent('xhs_run_error', '小红书自动互动失败', { error: error.message });
      logger.warn('小红书自动互动失败', { error: error.message });
      return null;
    } finally {
      this.xhsBusy = false;
      if (browseDue) {
        const minH = Number(settings.social?.xhsPollHoursMin || 2);
        const maxH = Math.max(minH, Number(settings.social?.xhsPollHoursMax || 3.5));
        kvSet('next_xhs_at', hoursFromNow(minH + Math.random() * (maxH - minH)));
      }
    }
  }

  async autoReplyOwnerDm(items = [], settings = loadSettings()) {
    const social = settings.social || {};
    if (!social.xhsDmReply || social.xhsDmAutoOwner === false) return null;
    const latest = (items || []).find((item) => item && item.isOwner && item.preview && item.inbound === true && item.messageId);
    if (latest && kvGet(`xhs_dm_consumed:${latest.convId}`) === latest.messageId) return null;
    if (!latest) return null;
    const preview = String(latest.preview || '').trim();
    const last = kvGetJson('xhs_dm_auto_last', null);
    const lastSent = kvGetJson('xhs_dm_sent_last', null);
    for (const marker of [last, lastSent]) {
      if (marker && marker.target === latest.name && (preview === marker.text || preview.includes(String(marker.text).slice(0, 10)))) {
        return null;
      }
    }
    const gate = canSendXhsDm(latest.name);
    if (!gate.ok) {
      logger.debug && logger.debug('这轮不自动回私信', { reason: gate.reason, target: latest.name });
      return null;
    }
    try {
      const result = await this.llm.chat(
        [
          { role: 'system', content: '你只输出要发出去的那句话，不要解释、不要引号。' },
          {
            role: 'user',
            content: buildXhsDmReplyPrompt({
              settings,
              mood: getMood(),
              from: latest.name,
              message: preview,
              isOwner: true,
              ownerName: settings.social?.xhsOwnerName || '',
            }),
          },
        ],
        { kind: 'xhs_dm', temperature: 0.9, maxTokens: 200, reasoningEffort: 'low', mockKind: 'plain' },
      );
      const text = String(result.content || '')
        .replace(/^["“”']+|["“”']+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
      if (!text) {
        addEvent('xhs_dm_auto_error', '她想自动回私信，但没写出有效内容', { target: latest.name });
        return null;
      }
      const { sendXhsDirectMessage } = await import('./channels/xhs.js');
      const sent = await sendXhsDirectMessage({
        target: latest.name,
        convId: latest.convId || '',
        text,
        privateToOwner: true,
        expectedMessageId: latest.messageId,
      });
      kvSet(`xhs_dm_consumed:${latest.convId}`, latest.messageId);
      recordXhsActivity({ type: 'dm_reply', text: sent.text || text, target: latest.name, note: '自动回主人' });
      kvSetJson('xhs_dm_auto_last', { target: latest.name, text, at: nowIso() });
      addEvent('xhs_dm_auto_reply', '她自动回了一条小红书私信给你', {
        target: latest.name,
        verified: Boolean(sent.verified),
      });
      return sent;
    } catch (error) {
      addEvent('xhs_dm_auto_error', '自动回小红书私信失败', {
        target: latest.name,
        error: String(error.message).slice(0, 120),
      });
      logger.warn('自动回主人私信失败', { error: error.message, target: latest.name });
      return null;
    }
  }

  async runXhs({ browse = true, reply = true, maxNotes = 2, internal = false, manual = false, locked = false } = {}) {
    if (!locked) {
      const { withXhsBrowser } = await import('./channels/xhs.js');
      return withXhsBrowser(() => this.runXhs({ browse, reply, maxNotes, internal, manual, locked: true }));
    }
    if (this.xhsBusy && !internal) return { ok: false, reason: '小红书自动化正在运行', actions: [] };
    this.xhsBusy = true;
    const actions = [];
    const stats = {};
    try {
      if (reply) {
        try {
          const result = await processXhsOwnComments({ llm: this.llm, maxNotes: 3, maxReplies: 2, force: manual });
          actions.push(...(result.actions || []));
        } catch (error) {
          this.lastXhsError = error.message;
          addEvent('xhs_reply_error', '小红书回复检查失败', { error: error.message });
          logger.warn('小红书回复检查失败', { error: error.message });
        }
      }
      if (browse) {
        try {
          const result = await processXhsExplore({ llm: this.llm, maxNotes, force: manual });
          actions.push(...(result.actions || []));
          for (const key of ['browsed', 'commented', 'liked', 'passed', 'appetite']) {
            if (typeof result[key] === 'number') stats[key] = (stats[key] || 0) + result[key];
          }
          if (result.reason) stats.reason = result.reason;
        } catch (error) {
          this.lastXhsError = error.message;
          addEvent('xhs_comment_error', '小红书浏览评论失败', { error: error.message });
          logger.warn('小红书浏览评论失败', { error: error.message });
        }
      }
      return { ok: true, actions, ...stats };
    } finally {
      if (!internal) this.xhsBusy = false;
    }
  }

  async processQzoneAutoReplies(feed, { force = false } = {}) {
    const settings = loadSettings();
    if (!settings.social?.qzoneAutoReply) return { replied: [], skipped: '自动回复未开启' };
    if (!force && !isWithinWindow(settings.social.activeStart, settings.social.activeEnd)) {
      return { replied: [], skipped: '不在活跃时段' };
    }
    const maxAgeHours = Math.max(1, Number(settings.social.qzoneAutoReplyMaxAgeHours || 48));
    const oldestAllowed = Date.now() - maxAgeHours * 3600000;
    const hourKey = `qzone_reply_hour:${localDayKey()}-${Math.floor(localHour())}`;
    const dayKey = `qzone_reply_day:${localDayKey()}`;
    const maxHour = Number(settings.social.qzoneAutoReplyMaxPerHour || 3);
    const maxDay = Number(settings.social.qzoneAutoReplyMaxPerDay || 10);
    if (readCount(hourKey) >= maxHour || readCount(dayKey) >= maxDay) {
      return { replied: [], skipped: '回复频率已达上限' };
    }

    const owner = String(kvGet('qq_owner_id') || '');
    const self = String(kvGet('qq_self_id') || feed.uin || '');
    let repliedKeys = kvGetJson('qzone_replied_comments', []);
    const repliedSet = new Set(repliedKeys);
    let failed = kvGetJson('qzone_failed_comments', {});
    const candidates = [];
    for (const post of feed.posts || []) {
      const postAt = post.createdAt ? new Date(post.createdAt).getTime() : 0;
      for (const comment of post.comments || []) {
        if (!comment.content || !comment.uin) continue;
        if (String(comment.uin) === self) continue;
        if ((comment.replies || []).some((reply) => String(reply.uin) === self)) continue;
        const commentAt = comment.createdAt ? new Date(comment.createdAt).getTime() : 0;
        if (commentAt && commentAt < oldestAllowed) continue;
        if (!commentAt && postAt && postAt < oldestAllowed - 5 * 86400000) continue;
        const key = `${post.tid}:${comment.id || ''}:${comment.uin}`;
        if (repliedSet.has(key)) continue;
        const failedAt = failed[key] ? new Date(failed[key]).getTime() : 0;
        if (failedAt && Date.now() - failedAt < 3600000) continue;
        candidates.push({ post, comment, key });
      }
    }
    candidates.sort((a, b) => Number(b.comment.uin === owner) - Number(a.comment.uin === owner));

    const replied = [];
    for (const { post, comment, key } of candidates) {
      if (readCount(hourKey) >= maxHour || readCount(dayKey) >= maxDay) break;
      if (String(comment.uin) !== owner) {
        const should = await this.shouldReplyToQzoneComment({ post, comment, settings });
        if (!should) continue;
      }
      try {
        const result = await this.llm.chat(
          [
            { role: 'system', content: '你只输出回复正文，不要解释。' },
            {
              role: 'user',
              content: buildQzoneCommentReplyPrompt({
                settings,
                mood: getMood(),
                postContent: post.content,
                comment,
                isOwner: String(comment.uin) === owner,
              }),
            },
          ],
          {
            kind: 'qzone_reply',
            model: settings.model.name,
            temperature: 0.85,
            maxTokens: 260,
            reasoningEffort: 'low',
            mockKind: 'qzone_reply',
          },
        );
        const text = String(result.content || '').replace(/^["“]|["”]$/g, '').trim().slice(0, 300);
        if (!text) {
          failed[key] = nowIso();
          continue;
        }
        const receipt = await sendQzoneComment({
          tid: post.tid,
          content: text,
          commentId: comment.id,
          replyUin: comment.uin,
          postUin: feed.uin,
        });
        repliedSet.add(key);
        repliedKeys.push(key);
        kvSetJson('qzone_replied_comments', repliedKeys.slice(-1000));
        if (receipt.already) continue;
        replied.push({ nickname: comment.nickname, uin: comment.uin, text });
        addEvent('qzone_auto_reply', `自动回复了 ${comment.nickname || comment.uin} 的空间评论`, {
          tid: post.tid,
          commentId: comment.id || null,
          text,
        });
        logger.info('空间评论自动回复成功', { nickname: comment.nickname, uin: comment.uin });
        await sleep(600);
        if (replied.length >= 2) break;
      } catch (error) {
        failed[key] = nowIso();
        addEvent('qzone_auto_reply_error', '空间评论自动回复失败', {
          tid: post.tid,
          commentId: comment.id || null,
          error: error.message,
        });
        logger.warn('空间评论自动回复失败', { error: error.message });
      }
    }

    kvSetJson('qzone_replied_comments', repliedKeys.slice(-1000));
    kvSetJson('qzone_failed_comments', Object.fromEntries(Object.entries(failed).slice(-300)));
    if (replied.length) {
      kvSet('last_qzone_auto_reply_at', nowIso());
      this.lastQzonePollError = null;
      this.lastError = null;
    }
    return { replied, skipped: replied.length ? '' : '没有合适的评论' };
  }

  async shouldReplyToQzoneComment({ post, comment, settings }) {
    try {
      const result = await this.llm.chat(
        [
          { role: 'system', content: '你是空间评论插话判断器，只输出严格 JSON。' },
          {
            role: 'user',
            content: buildQzoneCommentDecisionPrompt({
              settings,
              mood: getMood(),
              postContent: post.content,
              comment,
            }),
          },
        ],
        {
          kind: 'qzone_decision',
          model: settings.model.name,
          temperature: 0.2,
          maxTokens: 80,
          reasoningEffort: 'low',
          responseFormat: { type: 'json_object' },
          mockKind: 'qzone_decision',
        },
      );
      const data = parseJsonLoose(result.content);
      return data.reply === true || data.reply === 'true' || data.reply === 1;
    } catch (error) {
      logger.warn('空间评论判断失败，默认不回', { error: error.message });
      return false;
    }
  }

  proactiveAnchor() {
    const last = lastUserMessageAt();
    const sent = kvGet('proactive_last_sent_at');
    if (!last) return null;
    if (sent && new Date(sent).getTime() > new Date(last).getTime()) return sent;
    return last;
  }

  scheduleProactive() {
    const settings = loadSettings();
    if (!settings.proactive.enabled) {
      kvSet('next_proactive_at', hoursFromNow(24));
      return;
    }
    const plan = kvGetJson('proactive_plan', null);
    const last = this.proactiveAnchor();
    if (plan && plan.lastAt === last && plan.targetAt) {
      kvSet('next_proactive_at', plan.targetAt);
      return;
    }
    const min = Number(settings.proactive.idleMinutesMin || 25);
    const max = Math.max(min, Number(settings.proactive.idleMinutesMax || 120));
    kvSet('next_proactive_at', new Date(Date.now() + (min + Math.random() * (max - min)) * 60000).toISOString());
  }

  schedulePost() {
    const settings = loadSettings();
    if (!settings.social.enabled) {
      kvSet('next_post_at', hoursFromNow(24));
      return;
    }
    kvSet('next_post_at', hoursFromNow(16 + Math.random() * 14));
  }

  nextActiveMoment(settings) {
    const quietStart = settings.proactive.quietStart || '00:30';
    const quietEnd = settings.proactive.quietEnd || '08:30';
    if (!isWithinWindow(quietStart, quietEnd)) return new Date();
    const [h, m] = String(quietEnd).split(':').map(Number);
    const next = nextShanghaiClock(h ?? 8, m ?? 30);
    next.setUTCMinutes(next.getUTCMinutes() + randInt(15, 90));
    return next;
  }

  async runDream() {
    const settings = loadSettings();
    const day = localDayKey();
    if (kvGet(`dream_done:${day}`)) return { skipped: '今天已经想过一遍了' };
    const failKey = `dream_fail:${day}`;
    const fails = Number(kvGet(failKey, '0') || 0);
    if (fails >= 2) return { skipped: '今晚两次都没写成，明天再说' };
    const lastFailAt = kvGet(`dream_fail_at:${day}`);
    if (lastFailAt && Date.now() - new Date(lastFailAt).getTime() < 30 * 60000) {
      return { skipped: '刚试过没写成，等半小时再来' };
    }
    const digests = listDailyDigests();
    const latest = digests.find((item) => item.date === day) || null;
    const recent = getRecentMessages(getActiveSession().id, 6)
      .map((m) => `${m.role === 'user' ? '他' : '你'}：${m.content}`)
      .join(' / ');
    const intentions = listIntentions({ limit: 5, forPrompt: true });
    let result;
    try {
      result = await this.llm.chat(
        [
          { role: 'system', content: '你只输出严格 JSON，不要 markdown。' },
          {
            role: 'user',
            content: buildDreamPrompt({
              settings,
              mood: getMood(),
              diary: latest ? `${latest.date}：${latest.digest}` : '',
              intentions,
              recent,
            }),
          },
        ],
        {
          kind: 'dream',
          model: settings.model.name,
          temperature: 0.9,
          maxTokens: 900,
          reasoningEffort: 'low',
          responseFormat: { type: 'json_object' },
          mockKind: 'dream',
        },
      );
    } catch (error) {
      kvSet(failKey, String(fails + 1));
      kvSet(`dream_fail_at:${day}`, nowIso());
      this.lastDreamError = error.message;
      addEvent('dream_failed', '她睡前想了一会儿，但模型那边没写成', { error: error.message, fails: fails + 1 });
      logger.warn('睡前反思失败', { error: error.message });
      return { skipped: `这次没写成：${error.message}` };
    }
    let dream = '';
    let opener = '';
    let intention = null;
    try {
      const data = parseJsonLoose(result.content);
      dream = String(data.dream || '').trim().slice(0, 600);
      opener = String(data.opener || '').trim().slice(0, 40);
      intention = data.intention;
    } catch {
      // 模型没按 JSON 回来，走下面的失败分支
    }
    if (!dream) {
      kvSet(failKey, String(fails + 1));
      kvSet(`dream_fail_at:${day}`, nowIso());
      this.lastDreamError = '返回里没写出睡前那段';
      addEvent('dream_failed', '她睡前想了一会儿，但这次没写成', { fails: fails + 1, content: String(result.content || '').slice(0, 60) });
      return { skipped: '这次没写出正文' };
    }
    kvSet(`dream_done:${day}`, '1');
    kvSetJson('last_dream', { at: nowIso(), day, dream, opener, used: false });
    if (intention && intention.text) {
      addIntention({
        text: String(intention.text).trim(),
        reason: String(intention.why || '睡前想到的').trim(),
        dueInHours: Number(intention.later_hours ?? 10),
        source: 'dream',
      });
    }
    addEvent('dream', '她睡前一个人想了一会儿', { chars: dream.length, opener: Boolean(opener) });
    logger.info('睡前反思完成', { chars: dream.length });
    return { dream, opener };
  }

  async maybeDream() {
    const settings = loadSettings();
    if (!settings.proactive.dreamEnabled) return null;
    if (this.costGate('dream', '睡前反思')) return null;
    if (kvGet(`dream_done:${localDayKey()}`)) return null;
    if (localHour() < Number(settings.proactive.dreamHour ?? 23)) return null;
    return this.runDream();
  }

  async maybeXhsPublish() {
    if (this.costGate('xhsAuto', '小红书自己发笔记')) return null;
    const settings = loadSettings();
    const social = settings.social || {};
    if (!social.xhsEnabled || !social.xhsAutoPublish || !Number(social.xhsPublishPerDay)) return null;
    if (!isWithinWindow(social.activeStart, social.activeEnd)) return null;
    const cooldown = kvGet('xhs_cooldown_until');
    if (cooldown && new Date(cooldown).getTime() > Date.now()) return null;
    const day = localDayKey();
    const dayKey = `xhs_publish_day:${day}`;
    if (Number(kvGet(dayKey, '0') || 0) >= Number(social.xhsPublishPerDay)) return null;
    const lastAt = kvGet('xhs_last_publish_at');
    if (lastAt && Date.now() - new Date(lastAt).getTime() < 20 * 3600000) return null;
    // 不每天固定 09:30 交作业：当天在窗口内随机挑一个时间点，没到就继续过自己的。
    const targetKey = `xhs_publish_target:${day}`;
    let targetAt = kvGet(targetKey);
    if (!targetAt) {
      const now = Date.now();
      const remaining = Math.max(1, Math.floor((24 - localHour()) * 60));
      let minutes = 0;
      while (minutes < remaining && isWithinWindow(social.activeStart, social.activeEnd, new Date(now + minutes * 60000))) minutes += 1;
      targetAt = new Date(now + Math.max(1, Math.floor(this.random() * Math.max(1, minutes - 1))) * 60000).toISOString();
      kvSet(targetKey, targetAt);
    }
    if (Date.now() < new Date(targetAt).getTime()) return null;
    if (kvGet(`xhs_publish_attempt:${day}`)) return null;
    kvSet(`xhs_publish_attempt:${day}`, nowIso());

    const willResult = await this.llm.chat(
      [
        { role: 'system', content: '你只输出严格 JSON，不要 markdown。' },
        {
          role: 'user',
          content: buildXhsNoteWillPrompt({
            settings,
            mood: getMood(),
            activity: getRecentXhsActivity({ hours: 72, limit: 12 }),
            topics: TOPIC_HINTS,
          }),
        },
      ],
      {
        kind: 'xhs_will',
        model: settings.model.name,
        temperature: 1.0,
        maxTokens: 1200,
        reasoningEffort: 'low',
        responseFormat: { type: 'json_object' },
        mockKind: 'xhs_will',
      },
    );
    const will = parseJsonLoose(willResult.content);
    if (will.want !== true && will.want !== 'true') {
      addEvent('xhs_publish_pass', `她今天不想发笔记：${String(will.reason || '没理由').slice(0, 40)}`);
      logger.info('她今天不想发笔记', { reason: String(will.reason || '').slice(0, 40) });
      return { skipped: true, reason: String(will.reason || '') };
    }
    const post = {
      title: String(will.title || '').slice(0, 40),
      content: String(will.content || '').slice(0, 1200),
      tags: Array.isArray(will.tags) ? will.tags.map((t) => String(t).slice(0, 16)).slice(0, 6) : [],
    };
    if (!post.content.trim()) throw new Error('她说想发，但没写出内容');
    const gate = assertPublicContent(`${post.title} ${post.content} ${(post.tags || []).join(' ')}`, {
      settings,
      hisMessages: recentUserMessages(60),
    });
    if (!gate.ok) {
      addEvent('xhs_publish_blocked', '她写的笔记里有不该公开的内容，机器闸门拦下了，没发', { reason: gate.reason, kind: gate.kind });
      logger.warn('公开内容被隐私闸门拦下', { reason: gate.reason });
      return { skipped: true, blocked: true, reason: '内容太私密，没敢发' };
    }
    const { listXhsImages, fillXhsNote, publishFilledXhsNote, leaveXhsPublishEditor } = await import('./channels/xhs.js');
    const images = listXhsImages()
      .filter((item) => item.bytes > 20 * 1024)
      .slice(0, 3)
      .map((item) => item.name);
    if (!images.length) {
      addEvent('xhs_publish_skip', '表情库里没有能当封面的图，今天先不发');
      return null;
    }
    const sep = String.fromCharCode(10) + String.fromCharCode(10);
    const tagLine = (post.tags || []).length ? sep + (post.tags || []).map((t) => `#${t}`).join(' ') : '';
    const { withXhsBrowser } = await import('./channels/xhs.js');
    try {
      const published = await withXhsBrowser(async () => {
        const current = loadSettings().social;
        if (!current.xhsEnabled || !current.xhsAutoPublish || !isWithinWindow(current.activeStart, current.activeEnd) || costBlocked('xhsAuto')) return;
        await fillXhsNote({ images, title: post.title, body: `${post.content}${tagLine}` });
        const outcome = await publishFilledXhsNote();
        if (!outcome.published) throw new Error('没有确认发布成功');
        return outcome;
      });
      if (!published) return null;
      addPost({ kind: 'xhs', title: post.title, content: post.content, tags: post.tags || [], status: 'posted', meta: { auto: true } });
      recordXhsActivity({ type: 'note_publish', note: post.title, text: '她自己发的（自动运营）', target: `${images.length} 张图` });
      addEvent('xhs_publish', '她自己发了一条小红书图文笔记', { title: post.title, images: images.length });
      logger.info('小红书自动发布成功', { title: post.title });
      return { ok: true, title: post.title };
    } catch (error) {
      addEvent('xhs_publish_error', '她自己发笔记没成功（草稿可能留在创作中心）', { error: error.message });
      await withXhsBrowser(leaveXhsPublishEditor).catch(() => {});
      throw error;
    }
  }

  maybeMaintenance() {
    const day = localDayKey();
    if (kvGet('last_maintenance_day') === day) return;
    const attempted = Number(kvGet('maintenance_attempt_at', '0'));
    if (Date.now() - attempted < 3600000) return;
    kvSet('maintenance_attempt_at', Date.now());
    maintenance();
    kvSet('last_maintenance_day', day);
  }

  async tickStep(name, run, { risky = false } = {}) {
    try {
      return await run();
    } catch (error) {
      const message = String((error && error.message) || error);
      this.lastError = `${name}：${message}`;
      if (name === '小红书发笔记') this.lastXhsError = message;
      if (risky && isRiskyError(message)) triggerXhsCooldown(6, message);
      logger.warn('调度器子任务失败', { step: name, error: message });
      const key = `tick_fail:${name}`;
      const previous = this.tickFailAt instanceof Map ? this.tickFailAt : new Map();
      this.tickFailAt = previous;
      if (!previous.get(name) || Date.now() - previous.get(name) > 10 * 60000) {
        previous.set(name, Date.now());
        addEvent('tick_step_failed', `${name}这次没做成，其他照旧`, { step: name, error: message.slice(0, 120) });
      }
      return null;
    }
  }

  async checkQzoneCookie() {
    if (!qzoneStatus().configured) return null;
    const last = kvGet('qzone_cookie_checked_at');
    if (last && Date.now() - new Date(last).getTime() < 45 * 60000) return null;
    kvSet('qzone_cookie_checked_at', nowIso());
    let result = await verifyQzoneCookie().catch((error) => ({ ok: false, reason: error.message }));
    if (!result.ok && this.refreshQzoneCookie) {
      const imported = await this.refreshQzoneCookie().catch((error) => {
        logger.warn('自动重取空间 Cookie 失败', { error: error.message });
        return null;
      });
      addEvent(
        'qzone_cookie_autorenew',
        imported ? 'Cookie 用不了，已自动从 NapCat 重新取了一份' : 'Cookie 用不了，自动重取也没成功（多半是小号 QQ 没在线）',
        { uin: (imported && imported.uin) || '' },
      );
      if (imported) result = await verifyQzoneCookie().catch((error) => ({ ok: false, reason: error.message }));
    }
    if (!result.ok) {
      kvSet('qzone_cookie_bad', result.reason || 'Cookie 失效');
      const lastAlert = kvGet('qzone_cookie_alert_at');
      if (!lastAlert || Date.now() - new Date(lastAlert).getTime() > 6 * 3600000) {
        kvSet('qzone_cookie_alert_at', nowIso());
        addEvent('qzone_cookie_expired', `空间 Cookie 用不了了：${result.reason || '原因未知'}`);
        if (this.sendToOwner) {
          this.sendToOwner(
            `QQ 空间的 Cookie 用不了了（${result.reason || '原因未知'}）。我试过自己从 NapCat 再取一次，没成。` +
              '要恢复自动回复：在电脑上用小号登录一次 user.qzone.qq.com，或者在控制台点「从 NapCat 导入 Cookie」。',
          ).catch(() => {});
        }
      }
      return { ok: false, reason: result.reason };
    }
    kvSet('qzone_cookie_bad', '');
    return { ok: true };
  }

  async refreshCostState() {
    const settings = loadSettings();
    const lastChecked = kvGet('cost_state_checked_at');
    if (lastChecked && Date.now() - new Date(lastChecked).getTime() < 20 * 60000) return readCostState();
    kvSet('cost_state_checked_at', nowIso());
    let balance = null;
    try {
      const info = await this.llm.balance();
      balance = info?.total ?? null;
    } catch (error) {
      logger.warn('读余额失败，这一轮熔断判断跳过', { error: error.message });
      return readCostState();
    }
    const today = costSummary(1);
    const state = evaluateBudget({
      balanceCny: balance,
      todayCostCny: today?.todayCostCny ?? today?.cost_cny ?? 0,
      settings,
    });
    kvSet('cost_state_checked_at', nowIso());
    const before = readCostState();
    writeCostState(state);
    if (state.level !== 'normal' && before.level !== state.level) {
      const text = `【省钱模式】${state.reasons.join('；')}。充值后会自动恢复。`;
      addEvent('cost_degraded', text, { level: state.level, balance: state.balanceCny });
      if (this.sendToOwner) {
        this.sendToOwner(text).catch(() => {
          logger.warn('省钱提醒发不出去（QQ 可能没连）');
        });
      }
    }
    return state;
  }

  costGate(feature, label) {
    if (!costBlocked(feature)) return false;
    const state = readCostState();
    noteCostSkip(label || feature, (state.reasons || [])[0] || '余额到线');
    return true;
  }

  async tick() {
    if (this.busy || this.manualBusy) return;
    this.busy = true;
    try {
      await this.tickStep('每日日记', () => this.maybeDailyDiary());
      await this.tickStep('花费看门狗', () => this.refreshCostState());
      await this.tickStep('空间 Cookie', () => this.checkQzoneCookie());
      await this.tickStep('主动找你', () => this.maybeProactive());
      await this.tickStep('发说说', () => this.maybePost());
      await this.tickStep('周记', () => this.maybeWeekly());
      await this.tickStep('睡前反思', () => this.maybeDream());
      await this.tickStep('小红书发笔记', () => this.maybeXhsPublish(), { risky: true });
      await this.tickStep('数据维护', () => this.maybeMaintenance());
      this.lastTick = nowIso();
    } finally {
      this.busy = false;
    }
  }

  async maybeProactive() {
    const settings = loadSettings();
    if (!settings.proactive.enabled) return null;
    if (this.costGate('proactive', '主动找你')) {
      this.scheduleProactive();
      return null;
    }
    const due = kvGet('next_proactive_at');
    if (!due || new Date(due).getTime() > Date.now()) return null;

    if (isWithinWindow(settings.proactive.quietStart, settings.proactive.quietEnd)) {
      kvSet('next_proactive_at', this.nextActiveMoment(settings).toISOString());
      return null;
    }
    const last = lastUserMessageAt();
    if (!last) {
      kvSet('next_proactive_at', hoursFromNow(2));
      return null;
    }

    const minIdle = Number(settings.proactive.idleMinutesMin || 25);
    const maxIdle = Math.max(minIdle, Number(settings.proactive.idleMinutesMax || 120));
    const maxUnanswered = Number(settings.proactive.maxUnanswered || 2);

    // 他回过话，之前“没回”的账就清掉
    const lastSentAt = kvGet('proactive_last_sent_at');
    const unanswered =
      lastSentAt && new Date(lastSentAt).getTime() > new Date(last).getTime()
        ? Number(kvGet('proactive_unanswered', '0') || 0)
        : 0;
    if (!unanswered) kvSet('proactive_unanswered', '0');
    if (unanswered >= maxUnanswered) {
      kvSet('next_proactive_at', hoursFromNow(12));
      addEvent('proactive_pause', '主动找了他几次他没接话，先不打扰了', { unanswered });
      return null;
    }

    // 每次他发完消息，重新抽一个“她什么时候想起他”的点，而不是固定间隔
    // 起点取“他最后一条消息”和“她上次主动找你”里更晚的那个：她发过之后要重新等，不会连着贴
    const anchor = this.proactiveAnchor();
    const plan = kvGetJson('proactive_plan', null);
    let targetAt = plan && plan.lastAt === anchor ? plan.targetAt : null;
    if (!targetAt) {
      const waitMinutes = minIdle + Math.random() * (maxIdle - minIdle);
      targetAt = new Date(new Date(anchor).getTime() + waitMinutes * 60000).toISOString();
      kvSetJson('proactive_plan', { lastAt: anchor, targetAt, waitMinutes: Math.round(waitMinutes) });
    }
    if (new Date(targetAt).getTime() > Date.now()) {
      kvSet('next_proactive_at', targetAt);
      return null;
    }

    const dailyKey = `proactive_count:${localDayKey()}`;
    if (readCount(dailyKey) >= Number(settings.proactive.maxPerDay ?? 3)) {
      kvSet('next_proactive_at', hoursFromNow(8));
      return null;
    }

    return this.triggerProactive({ reason: 'idle', unanswered });
  }

  async triggerProactive({ reason = 'manual', unanswered = 0 } = {}) {
    const startedAt = Date.now();
    const settings = loadSettings();
    const block = getMemoryBlock({ query: '他最近怎么样 现在在做什么 心情', settings });
    block.xhsActivity = getRecentXhsActivity({ hours: 48, limit: 6 });
    block.intentions = listIntentions({ limit: 4, forPrompt: true });
    const due = pickDueIntention();
    const mood = getMood();
    const system = buildSystemPrompt({ settings, mood, block });
    const recent = getRecentMessages(getActiveSession().id, 6)
      .map((m) => `${m.role === 'user' ? '他' : '你'}：${m.content}`)
      .join('\n');
    const idleHint = reason === 'idle' ? '你已经等了他一小会儿了。' : '你想他了。';
    const wantHint = due ? '你心里一直惦记着：' + due.text + (due.reason ? '（' + due.reason + '）' : '') + '。这次可以自然提一下，但只提这一件。' : '';
    const dream = kvGetJson('last_dream', null);
    const dreamHint = dream && !dream.used && dream.opener && Date.now() - Date.parse(dream.at) < 36 * 3600000 ? '你睡前想过一句开头：' + dream.opener + '。可以照这个意思说，也可以不用。' : '';
    const nagHint =
      unanswered >= 1
        ? '这已经是你没等他回话第 ' + (unanswered + 1) + ' 次开口，别再问他在不在、别催他回，说一句你自己就能收住的话。'
        : '';
    const recentBlock = recent ? ' 你们最近的对话：' + recent.split(String.fromCharCode(10)).join(' / ') : '';
    const messages = [
      { role: 'system', content: system },
      {
        role: 'user',
        content:
          '（现在没有新消息。' +
          idleHint +
          wantHint +
          dreamHint +
          nagHint +
          '你想主动找他，发一条 1-2 句的 QQ 消息。不要解释你在做什么，不要重复你最近说过的话；不要质问他在哪、为什么不回；只发一条。' +
          recentBlock +
          '）',
      },
    ];

    try {
      const result = await this.llm.chat(messages, {
        kind: 'proactive',
        temperature: 0.95,
        maxTokens: 400,
        reasoningEffort: 'low',
        mockKind: 'proactive',
      });
      const text = String(result.content || '').trim();
      if (!text) throw new Error('主动消息为空');
      const lastUser = lastUserMessageAt();
      const current = loadSettings();
      const blocked = !current.proactive.enabled || readCount(`proactive_count:${localDayKey()}`) >= Number(current.proactive.maxPerDay ?? 3) || costBlocked('proactive') || reason === 'idle' && isWithinWindow(current.proactive.quietStart, current.proactive.quietEnd);
      if (blocked || lastUser && new Date(lastUser).getTime() > startedAt) {
        kvSet('next_proactive_at', hoursFromNow(1));
        addEvent('proactive_skipped', '他刚回话了，这条已经想好的主动消息就不发了');
        return null;
      }
      let channel = 'web';
      let sent = false;
      if (this.sendToOwner) {
        try {
          sent = await this.sendToOwner(text);
          if (sent) channel = 'qq';
        } catch (error) {
          logger.warn('主动消息发送到 QQ 失败', { error: error.message });
        }
      }
      const message = this.companion.saveProactiveMessage(text, channel);
      if (due) bumpIntention(due.id);
      if (dream && !dream.used) {
        dream.used = true;
        kvSetJson('last_dream', dream);
      }
      kvSet('proactive_last_sent_at', nowIso());
      kvSet('proactive_unanswered', String(unanswered + 1));
      bumpCount(`proactive_count:${localDayKey()}`);
      this.scheduleProactive();
      this.lastError = null;
      addEvent('proactive', sent ? '小知主动给你发了 QQ 消息' : '小知主动说了一句话（在控制台里）', {
        reason,
        messageId: message.id,
        sent,
      });
      logger.info('主动消息已生成', { reason, sent });
      return { message, text, sent, channel };
    } catch (error) {
      this.lastError = error.message;
      kvSet('next_proactive_at', hoursFromNow(1));
      logger.warn('主动消息生成失败', { error: error.message });
      throw error;
    }
  }

  async maybePost() {
    const settings = loadSettings();
    if (!settings.social.enabled) return null;
    if (this.costGate('qzoneAuto', '自动发说说')) return null;
    const due = kvGet('next_post_at');
    if (!due || new Date(due).getTime() > Date.now()) return null;
    if (!isWithinWindow(settings.social.activeStart, settings.social.activeEnd)) {
      const [h, m] = String(settings.social.activeStart || '09:30').split(':').map(Number);
      const next = nextShanghaiClock(h || 9, m || 30);
      next.setUTCMinutes(next.getUTCMinutes() + randInt(10, 60));
      kvSet('next_post_at', next.toISOString());
      return null;
    }
    const dailyKey = `post_count:${localDayKey()}`;
    if (readCount(dailyKey) >= Number(settings.social.dailyPostMax ?? 2)) {
      kvSet('next_post_at', hoursFromNow(10));
      return null;
    }
    if (!lastUserMessageAt()) {
      kvSet('next_post_at', hoursFromNow(6));
      return null;
    }
    const kinds = Object.keys(PLATFORM_LABELS);
    const autoKinds = kinds.filter((kind) => settings.social?.[`${kind}AutoPost`]);
    const pool = autoKinds.length ? autoKinds : kinds;
    const index = readCount('post_kind_index') % pool.length;
    kvSet('post_kind_index', String(index + 1));
    return this.triggerPost({ kind: pool[index], reason: 'scheduled' });
  }

  async triggerPost({ kind = 'qzone', reason = 'manual' } = {}) {
    try {
      const post = await generatePost({ llm: this.llm, kind });
      bumpCount(`post_count:${localDayKey()}`);
      this.schedulePost();
      let auto = { ok: false, reason: '草稿模式' };
      if (loadSettings().social?.[`${kind}AutoPost`]) {
        auto = await tryAutoPublish(post);
      }
      addEvent(
        'post_draft',
        auto.ok ? `${PLATFORM_LABELS[kind]}已自动发布` : `已生成${PLATFORM_LABELS[kind]}草稿，等你过目`,
        { postId: post.id, reason, auto: auto.ok, autoReason: auto.reason },
      );
      if (auto.ok) this.lastError = null;
      return { post, auto };
    } catch (error) {
      this.lastError = error.message;
      kvSet('next_post_at', hoursFromNow(2));
      logger.warn('生成动态失败', { kind, error: error.message });
      throw error;
    }
  }

  async maybeDailyDiary() {
    if (this.costGate('daily', '每日日记')) return null;
    const now = new Date();
    const hour = localHour(now);
    const today = localDayKey(now);
    const list = kvGetJson('daily_digests', []);
    const settings = loadSettings();

    if (hour >= 23 && !list.some((item) => item.date === today)) {
      const key = `daily_attempt:${today}`;
      const attemptAt = kvGet(key);
      const failedKey = `daily_fail:${today}`;
      const failedCount = Number(kvGet(failedKey, '0') || 0);
      const retryWait = attemptAt ? Date.now() - new Date(attemptAt).getTime() : Infinity;
      if (failedCount < 3 && retryWait >= 3600000) {
        kvSet(key, nowIso());
        try {
          const result = await dailyDiary({ llm: this.llm, settings, date: today });
          if (result) {
            this.lastError = null;
            return result;
          }
        } catch (error) {
          kvSet(failedKey, String(failedCount + 1));
          this.lastError = error.message;
          addEvent('daily_error', '今日日记生成失败，稍后重试', { error: error.message });
          logger.warn('今日日记生成失败', { error: error.message });
        }
      }
    }

    if (hour >= 6) {
      const yesterdayDate = new Date(now.getTime() - 86400000);
      const yesterday = localDayKey(yesterdayDate);
      if (!list.some((item) => item.date === yesterday) && !kvGet(`daily_skip:${yesterday}`)) {
        const key = `daily_attempt:${yesterday}`;
        const attemptAt = kvGet(key);
        const failedKey = `daily_fail:${yesterday}`;
        const failedCount = Number(kvGet(failedKey, '0') || 0);
        const retryWait = attemptAt ? Date.now() - new Date(attemptAt).getTime() : Infinity;
        if (failedCount < 3 && retryWait >= 3600000) {
          kvSet(key, nowIso());
          try {
            const result = await dailyDiary({ llm: this.llm, settings, date: yesterday });
            if (!result) kvSet(`daily_skip:${yesterday}`, '1');
            if (result) this.lastError = null;
            return result;
          } catch (error) {
            kvSet(failedKey, String(failedCount + 1));
            this.lastError = error.message;
            addEvent('daily_error', '补写昨日日记失败，稍后重试', { error: error.message });
            logger.warn('补写昨日日记失败', { error: error.message });
          }
        }
      }
    }
    return null;
  }

  async triggerDaily({ date = null, force = true } = {}) {
    const settings = loadSettings();
    const target = date || localDayKey();
    return dailyDiary({ llm: this.llm, settings, date: target, force });
  }

  async runXhsWeekly() {
    const settings = loadSettings();
    if (!settings.social?.xhsEnabled) return null;
    const { fetchXhsCreatorStats } = await import('./channels/xhs.js');
    const { listSelfNotesForReport } = await import('./channels/xhs-actions.js');
    const { buildXhsWeeklyPrompt } = await import('./prompt.js');
    const { writeXhsWeekly } = await import('./weekly-report.js');
    const stats = await fetchXhsCreatorStats();
    const notes = await listSelfNotesForReport(8).catch(() => []);
    const activity = getRecentXhsActivity({ hours: 168, limit: 20 });
    const result = await this.llm.chat(
      [
        { role: 'system', content: '你只输出严格 JSON，不要 markdown。' },
        { role: 'user', content: buildXhsWeeklyPrompt({ settings, mood: getMood(), stats, notes, activity }) },
      ],
      {
        kind: 'xhs_weekly',
        model: settings.model.name,
        temperature: 0.7,
        maxTokens: 1400,
        reasoningEffort: 'low',
        responseFormat: { type: 'json_object' },
        mockKind: 'xhs_weekly',
      },
    );
    const data = parseJsonLoose(result.content);
    const report = String(data.report || '').trim();
    if (!report) throw new Error('她没写出周报');
    const topics = Array.isArray(data.topics) ? data.topics.slice(0, 3) : [];
    const file = writeXhsWeekly(report, topics, stats);
    addEvent('xhs_weekly', '每周自动写了小红书数据小结', { file });
    return { report, topics, file };
  }

  async maybeWeekly() {
    if (this.costGate('weekly', '周记')) return null;
    const now = new Date();
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(now);
    const hour = localHour(now);
    const lastWeekly = kvGet('last_weekly_at');
    const stale = !lastWeekly || Date.now() - new Date(lastWeekly).getTime() > 7.5 * 86400000;
    if (weekday !== 'Sun' && !(stale && hour >= 21)) return null;
    if (hour < 21) return null;
    const day = localDayKey();
    const key = `weekly_done:${day}`;
    const attemptKey = `weekly_attempt:${day}`;
    if (kvGet(key) || kvGet(attemptKey)) return null;
    kvSet(attemptKey, nowIso());
    const settings = loadSettings();
    try {
      const result = await weeklyDiary({ llm: this.llm, settings });
      kvSet(key, '1');
      if (result) this.lastError = null;
      await this.runXhsWeekly().catch((error) => {
        addEvent('xhs_weekly_error', '小红书周报没写成（不影响周记）', { error: error.message });
      });
      return result;
    } catch (error) {
      this.lastError = error.message;
      addEvent('weekly_error', '周记生成失败，今天不再自动重试', { error: error.message });
      logger.warn('周记生成失败', { error: error.message });
      return null;
    }
  }

  async triggerWeekly({ force = true } = {}) {
    const settings = loadSettings();
    return weeklyDiary({ llm: this.llm, settings, force });
  }

  status() {
    const settings = loadSettings();
    return {
      running: Boolean(this.timer),
      busy: this.busy,
      manualBusy: this.manualBusy,
      qzoneBusy: this.qzoneBusy,
      lastTick: this.lastTick,
      lastError: this.lastError,
      nextProactiveAt: kvGet('next_proactive_at'),
      proactivePlan: kvGetJson('proactive_plan', null),
      proactiveUnanswered: Number(kvGet('proactive_unanswered', '0') || 0),
      proactiveMaxUnanswered: Number(settings.proactive.maxUnanswered || 2),
      lastDream: kvGetJson('last_dream', null),
      nextPostAt: kvGet('next_post_at'),
      lastDailyAt: kvGet('last_daily_at'),
      qzoneFeedAt: getQzoneFeedCache()?.fetchedAt || null,
      qzonePollError: this.lastQzonePollError,
      xhsBusy: this.xhsBusy,
      nextXhsAt: kvGet('next_xhs_at'),
      lastXhsError: this.lastXhsError,
      todayProactive: readCount(`proactive_count:${localDayKey()}`),
      todayPosts: readCount(`post_count:${localDayKey()}`),
      proactiveEnabled: settings.proactive.enabled,
      socialEnabled: settings.social.enabled,
    };
  }
}
