import { loadSettings } from '../config.js';
import { addEvent, kvGet, kvGetJson, kvSet, kvSetJson, recentUserMessages } from '../db.js';
import { logger } from '../logger.js';
import { getMood } from '../mood.js';
import { buildXhsCommentPrompt, buildXhsNotificationReplyPrompt } from '../prompt.js';
import { localHour, nowIso, parseJsonLoose, sleep } from '../util.js';
import { assertPublicContent } from '../privacy.js';
import { fetchXhsFeed, fetchXhsNote, postXhsComment, reactXhsNote, xhsBrowser } from './xhs.js';

const BASE = 'https://www.xiaohongshu.com';
const ACTIVITY_KEY = 'xhs_activity';

function sevenDaysAgoIso() {
  return new Date(Date.now() - 7 * 86400000).toISOString();
}

export function recordXhsActivity(entry = {}) {
  const item = {
    at: entry.at || nowIso(),
    type: String(entry.type || '').slice(0, 24),
    text: String(entry.text || '').slice(0, 200),
    target: String(entry.target || '').slice(0, 60),
    note: String(entry.note || '').slice(0, 80),
    ok: entry.ok !== false,
  };
  if (!item.type) return item;
  const floor = sevenDaysAgoIso();
  const list = kvGetJson(ACTIVITY_KEY, []).filter((x) => x && x.at >= floor);
  list.push(item);
  kvSetJson(ACTIVITY_KEY, list.slice(-200));
  return item;
}

export function getRecentXhsActivity({ hours = 48, limit = 8 } = {}) {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const list = kvGetJson(ACTIVITY_KEY, [])
    .filter((x) => x && x.at >= cutoff)
    .slice(-limit)
    .reverse();
  const badge = Number(kvGet('xhs_notification_badge', '0') || 0);
  const badgeAt = kvGet('xhs_notification_checked_at') || '';
  if (badge > 0 && (!badgeAt || badgeAt >= cutoff)) {
    list.unshift({
      type: 'notify',
      text: `有 ${badge} 条小红书通知还没看`,
      note: '',
      target: '',
      at: kvGet('xhs_notification_checked_at') || nowIso(),
    });
  }
  return list;
}

function localDayKey() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function budgetKeys(kind) {
  const day = localDayKey();
  const prefix =
    kind === 'reply'
      ? 'xhs_reply_day'
      : kind === 'like'
        ? 'xhs_like_day'
        : kind === 'collect'
          ? 'xhs_collect_day'
          : kind === 'dm'
            ? 'xhs_dm_day'
            : 'xhs_comment_day';
  return { day: `${prefix}:${day}`, hour: `xhs_action_hour:${day}-${Math.floor(localHour())}` };
}

function readCount(key) {
  return Number(kvGet(key, '0') || 0);
}

function bump(key) {
  kvSet(key, String(readCount(key) + 1));
}

export function xhsBudgetStatus() {
  const settings = loadSettings();
  const c = budgetKeys('comment');
  const r = budgetKeys('reply');
  return {
    commentsToday: readCount(c.day),
    repliesToday: readCount(r.day),
    actionsThisHour: readCount(c.hour),
    dailyCommentMax: Number(settings.social?.xhsDailyCommentMax || 0),
    dailyReplyMax: Number(settings.social?.xhsDailyReplyMax || 0),
    hourlyActionMax: Number(settings.social?.xhsHourlyActionMax || 3),
  };
}

export function triggerXhsCooldown(hours = 6, reason = '') {
  const until = new Date(Date.now() + hours * 3600000).toISOString();
  kvSet('xhs_cooldown_until', until);
  addEvent('xhs_cooldown', '小红书要求验证/提示频繁，所有动作暂停 6 小时', { reason: String(reason).slice(0, 120) });
  return until;
}

export function xhsCooldownUntil() {
  return kvGet('xhs_cooldown_until') || '';
}

export function isRiskyError(error) {
  return /频繁|安全验证|滑块|滑动验证|申诉|账号.{0,6}限制|300013/.test(String((error && error.message) || error));
}

export function canAct(kind) {
  const settings = loadSettings();
  const social = settings.social || {};
  if (!social.xhsEnabled) return { ok: false, reason: '小红书互动未开启' };
  const cooldown = xhsCooldownUntil();
  if (cooldown && new Date(cooldown).getTime() > Date.now()) {
    return { ok: false, reason: `风控冷却中，到 ${cooldown.slice(11, 16)} 再试` };
  }
  const keys = budgetKeys(kind);
  const dailyMax =
    kind === 'reply'
      ? Number(social.xhsDailyReplyMax || 0)
      : kind === 'like'
        ? Number(social.xhsDailyLikeMax || 0)
        : kind === 'collect'
          ? Number(social.xhsDailyCollectMax || 0)
          : kind === 'dm'
            ? Number(social.xhsDmMaxPerDay || 0)
            : Number(social.xhsDailyCommentMax || 0);
  const hourlyMax = Number(social.xhsHourlyActionMax || 3);
  if (readCount(keys.hour) >= hourlyMax) return { ok: false, reason: '本小时动作已达上限' };
  if (readCount(keys.day) >= dailyMax) {
    return {
      ok: false,
      reason: kind === 'reply' ? '今天回复已达上限' : kind === 'dm' ? `今天回私信已达上限（${dailyMax} 条）` : '今天评论已达上限',
    };
  }
  const totalKeys = ['comment', 'reply', 'like', 'collect', 'dm'].map((k) => budgetKeys(k).day);
  const totalToday = totalKeys.reduce((sum, key) => sum + readCount(key), 0);
  const totalMax = Number(social.xhsDailyActionMax || 0);
  if (totalMax > 0 && totalToday >= totalMax) {
    return { ok: false, reason: `今天所有动作加起来已经到 ${totalMax} 次上限` };
  }
  return { ok: true, keys };
}

function dmTargetKey(target) {
  return `xhs_dm_target:${String(target || '').trim()}:${localDayKey()}`;
}

/** 私信是小红书对新号最危险的动作：开关 + 全账号每天封顶 + 同一个人每天只回一条。 */
export function canSendXhsDm(target) {
  const social = loadSettings().social || {};
  if (!social.xhsDmReply) return { ok: false, reason: '「允许回私信」是关的（设置 → 小红书）' };
  const gate = canAct('dm');
  if (!gate.ok) return gate;
  const perTarget = Math.max(1, Number(social.xhsDmMaxPerTarget || 1));
  const used = readCount(dmTargetKey(target));
  if (used >= perTarget) {
    return { ok: false, reason: `今天已经回过「${target}」${used} 条了，同一个人每天最多 ${perTarget} 条` };
  }
  return { ok: true, keys: gate.keys, perTarget, used };
}

export function noteXhsDmSent(target, keys) {
  bump(dmTargetKey(target));
  if (keys?.day) bump(keys.day);
  if (keys?.hour) bump(keys.hour);
}

export function xhsDmStatus(targets = []) {
  const social = loadSettings().social || {};
  return {
    enabled: Boolean(social.xhsDmReply),
    todayTotal: readCount(budgetKeys('dm').day),
    dailyMax: Number(social.xhsDmMaxPerDay || 0),
    perTargetMax: Math.max(1, Number(social.xhsDmMaxPerTarget || 1)),
    perTargetUsed: Object.fromEntries(
      [...new Set((targets || []).map((t) => String(t || '').trim()).filter(Boolean))].map((name) => [
        name,
        readCount(dmTargetKey(name)),
      ]),
    ),
  };
}

function noteIsSensitive(note) {
  return /新闻|事故|灾难|死亡|去世|遗体|伤亡|政治|政府|战争|军事|医疗求助|捐款|众筹|癌|病危|自杀|家暴|未成年|偷拍|隐私|八卦|爆料|求助/.test(
    `${note?.title || ''} ${note?.desc || ''}`,
  );
}

function cleanComment(text) {
  return String(text || '')
    .replace(/^["“”']+|["“”']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function splitKeywords(value) {
  return String(value || '')
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function profileNameFromPage() {
  return xhsBrowser().evaluate(
    `(() => ({
      name: (document.querySelector('.user-name, .user-nickname, .info .name, .user-info .name')?.innerText || '').trim(),
      userId: location.pathname.match(/\\/user\\/profile\\/([^/]+)/)?.[1] || '',
      url: location.href
    }))()`,
    { timeoutMs: 45000 },
  );
}

export async function discoverSelfProfile() {
  const browser = xhsBrowser();
  await browser.ensure({ visible: false });
  await browser.navigate(`${BASE}/explore`);
  const data = await browser.evaluate(
    `(() => ({
      links: [...document.querySelectorAll('.side-bar a[href*="/user/profile/"]')].map((a) => ({
        href: a.getAttribute('href'),
        text: (a.innerText || '').trim(),
        title: a.getAttribute('title') || ''
      }))
    }))()`,
    { timeoutMs: 45000 },
  );
  const link = data.links.find((item) => /我|个人|主页/.test(`${item.text} ${item.title}`)) || data.links[0];
  if (!link?.href) throw new Error('没有找到你的小红书个人主页入口，请确认已经登录');
  await browser.navigate(new URL(link.href, BASE).href);
  await browser.waitFor('section.note-item', 15000);
  const profile = await profileNameFromPage();
  profile.desc = await browser
    .evaluate(
      `(() => {
        const d = document.querySelector('.user-desc');
        return d ? (d.innerText || '').trim().slice(0, 200) : '';
      })()`,
      { timeoutMs: 45000 },
    )
    .catch(() => '');
  if (!profile.name) {
    const body = await browser.evaluate('(document.body.innerText||"").slice(0,500)', { timeoutMs: 45000 });
    profile.name = body.split('\n').map((item) => item.trim()).find(Boolean) || '';
  }
  kvSet('xhs_self_name', profile.name);
  kvSet('xhs_self_user_id', profile.userId);
  kvSet('xhs_profile_url', profile.url);
  return profile;
}

export async function listSelfNotesForReport(limit = 8) {
  const { notes } = await fetchSelfNotes(limit);
  return notes.map((n) => ({ title: n.title || '', href: n.href || '', noteId: n.noteId || '' }));
}

async function fetchSelfNotes(limit = 6) {
  const profile = await discoverSelfProfile();
  const notes = await xhsBrowser().evaluate(
    `(() => [...document.querySelectorAll('section.note-item')].slice(0, 8).map((card) => ({
      noteId: card.getAttribute('data-note-id') || '',
      href: card.querySelector('a.cover')?.getAttribute('href') || '',
      title: (card.querySelector('a.title')?.innerText || '').trim()
    })).filter((item) => item.noteId && item.href))()`,
    { timeoutMs: 45000 },
  );
  return { profile, notes: notes.slice(0, limit) };
}

async function selfReplyExists(note, comment, selfName) {
  if (!selfName) return false;
    return false; // 已回复判定使用稳定评论 ID，不用列表位置推断。
}

export async function replyXhsComment(comment, text) {
  const content = cleanComment(text);
  if (!content) throw new Error('回复内容为空');
  const clicked = await xhsBrowser().evaluateFunction((i) => {
    const items = [...document.querySelectorAll('#noteContainer .comment-item')];
    const item = items.find(el => el.id === i || el.getAttribute('data-comment-id') === i);
    if (!item) return false;
    const button = item.querySelector('.reply');
    if (!button) return false;
    button.click();
    return true;
  }, [comment.id]);
  if (!clicked) throw new Error('找不到要回复的评论');
  await sleep(800);
  const typed = await xhsBrowser().type('#content-textarea', content);
  if (!typed) throw new Error('找不到回复输入框');
  let ready = false;
  for (let i = 0; i < 20; i += 1) {
    ready = await xhsBrowser().evaluate(
      `(() => { const b=document.querySelector('#noteContainer .btn.submit'); return Boolean(b && !b.disabled); })()`,
    );
    if (ready) break;
    await sleep(250);
  }
  if (!ready) throw new Error('回复按钮没有变为可点');
  const before = await xhsBrowser().evaluateFunction((text) => [...document.querySelectorAll('#noteContainer .comment-item .note-text')].filter(el => el.innerText.trim() === text).length, [content]);
  await xhsBrowser().click('#noteContainer .btn.submit');
  await sleep(2200);
  const result = await xhsBrowser().evaluate(`(() => {
    const root = document.getElementById('noteContainer');
    return {
      bodyHasText: (root?.innerText || '').includes(${JSON.stringify(content)}),
      editorEmpty: !(document.getElementById('content-textarea')?.innerText || '').trim(),
      captcha: /验证|滑动|安全验证|访问频繁|操作频繁/.test(document.body.innerText || '')
    };
  })()`);
  if (result.captcha) throw new Error('小红书要求安全验证，已停止自动回复');
  const after = await xhsBrowser().evaluateFunction((text) => [...document.querySelectorAll('#noteContainer .comment-item .note-text')].filter(el => el.innerText.trim() === text).length, [content]);
  if (!result.bodyHasText || after <= before) throw Object.assign(new Error('回复发送结果未核实，未自动重发'), { code: 'DELIVERY_UNKNOWN' });
  return { ok: true, verified: result.bodyHasText };
}

export async function processXhsExplore({ llm, maxNotes = 0, force = false } = {}) {
  const settings = loadSettings();
  if (!settings.social.xhsEnabled) return { ok: false, reason: '小红书互动未开启', actions: [] };
  if (!settings.social.xhsAutoBrowse && !force) return { ok: false, reason: '自动浏览评论未开启', actions: [] };
  const cooldown = xhsCooldownUntil();
  if (cooldown && new Date(cooldown).getTime() > Date.now()) {
    return { ok: false, reason: `风控冷却中，到 ${cooldown.slice(11, 16)} 再试`, actions: [] };
  }
  const mood = getMood();
  // 她想逛多少条由她自己的精神头决定，不再固定两条
  const appetite = Math.max(2, Math.min(8, 2 + Math.round(Number(mood.energy || 0.5) * 6)));
  const limit = Number(maxNotes) > 0 ? Math.min(Number(maxNotes), appetite) : appetite;
  const feed = await fetchXhsFeed({ limit: Math.max(12, limit * 3), keyword: splitKeywords(settings.social.xhsSearchKeywords)[0] || '' });
  const seen = new Set(kvGetJson('xhs_seen_notes', []));
  const actions = [];
  let browsed = 0;
  let commented = 0;
  let liked = 0;
  let passed = 0;
  const react = async (kind, note) => {
    const budget = canAct(kind);
    if (!budget.ok) return false;
    try {
      const done = await reactXhsNote(kind);
      if (!done.already) {
        bump(budget.keys.day);
        bump(budget.keys.hour);
      }
      recordXhsActivity({ type: kind, note: note?.title || '', text: done.already ? '本来就点过了' : (kind === 'collect' ? '收藏了' : '点了赞') });
      return !done.already;
    } catch (error) {
      if (isRiskyError(error)) triggerXhsCooldown(6, error.message);
      logger.debug('小红书点赞/收藏没做成', { error: error.message });
      return false;
    }
  };
  for (const item of feed) {
    if (Date.parse(xhsCooldownUntil()) > Date.now()) break;
    if (browsed >= limit) break;
    if (seen.has(item.noteId)) continue;
    const budget = canAct('comment');
    const note = await fetchXhsNote(item.href);
    seen.add(item.noteId);
    browsed += 1;
    if (!note.title && !note.desc) continue;
    if (noteIsSensitive(note)) {
      logger.info('小红书笔记跳过（敏感内容）', { noteId: item.noteId, title: note.title.slice(0, 40) });
      continue;
    }
    if (!budget.ok) break;
    try {
      const result = await llm.chat(
        [
          { role: 'system', content: '你只输出严格 JSON，不要 markdown。' },
          {
            role: 'user',
            content: buildXhsCommentPrompt({
              settings,
              mood,
              note,
              comments: note.comments,
              ownerName: settings.social.xhsOwnerName,
              mode: 'comment',
            }),
          },
        ],
        {
          kind: 'xhs_comment',
          model: settings.model.name,
          temperature: 0.85,
          maxTokens: 320,
          reasoningEffort: 'low',
          responseFormat: { type: 'json_object' },
          mockKind: 'xhs_comment',
        },
      );
      const parsed = parseJsonLoose(result.content);
      const text = cleanComment(parsed.comment);
      const wantsLike = parsed.like === true || parsed.like === 'true';
      const wantsCollect = parsed.collect === true || parsed.collect === 'true';
      if (parsed.reply !== true || !text) {
        // 不想说话就不说：觉得好可以只点个赞，什么都不做也算看完
        passed += 1;
        if (wantsLike && settings.social.xhsAutoLike && (await react('like', note))) liked += 1;
        if (wantsCollect && settings.social.xhsAutoCollect && (await react('collect', note))) {
          actions.push({ type: 'collect', noteId: item.noteId, title: note.title });
        }
        logger.info('小红书这条她没说话', { noteId: item.noteId, reason: String(parsed.reason || '').slice(0, 60), liked: wantsLike });
        continue;
      }
      const gate = assertPublicContent(text, { settings, hisMessages: recentUserMessages(40) });
      if (!gate.ok) {
        addEvent('xhs_comment_blocked', '她想说的评论里有不该公开的内容，闸门拦下了', { reason: gate.reason });
        continue;
      }
      const posted = await postXhsComment(text);
      const keys = budget.keys || budgetKeys('comment');
      bump(keys.day);
      bump(keys.hour);
      commented += 1;
      actions.push({
        type: 'comment',
        noteId: item.noteId,
        title: note.title,
        author: note.author,
        text,
        verified: posted.verified,
        at: nowIso(),
      });
      recordXhsActivity({ type: 'comment', note: note.title || item.title, text, target: note.author || '' });
      if (settings.social.xhsAutoLike && (wantsLike || parsed.reply === true) && (await react('like', note))) liked += 1;
      if (wantsCollect && settings.social.xhsAutoCollect && (await react('collect', note))) {
        actions.push({ type: 'collect', noteId: item.noteId, title: note.title });
      }
      addEvent('xhs_comment', `小红书评论了「${note.title || item.title}」`, {
        noteId: item.noteId,
        text,
        verified: posted.verified,
      });
      await sleep(20000 + Math.random() * 40000);
    } catch (error) {
      if (isRiskyError(error)) triggerXhsCooldown(6, error.message);
      logger.warn('小红书评论失败', { noteId: item.noteId, error: error.message });
      addEvent('xhs_comment_error', '小红书评论失败', { noteId: item.noteId, error: error.message });
    }
  }
  kvSetJson('xhs_seen_notes', [...seen].slice(-400));
  addEvent(
    'xhs_browse_done',
    `她逛了 ${browsed} 条：说了 ${commented} 句，点了 ${liked} 个赞，${passed} 条看完没说话`,
    { appetite: limit },
  );
  return { ok: true, actions, browsed, commented, liked, passed, appetite: limit };
}

export async function processXhsOwnComments({ llm, maxNotes = 3, maxReplies = 2, force = false } = {}) {
  const settings = loadSettings();
  if (!settings.social.xhsEnabled) return { ok: false, reason: '小红书互动未开启', actions: [] };
  if (!settings.social.xhsAutoReply && !force) return { ok: false, reason: '自动回复未开启', actions: [] };
  const { profile, notes } = await fetchSelfNotes(maxNotes);
  const selfName = profile.name || kvGet('xhs_self_name') || '';
  const actions = [];
  for (const item of notes) {
    const note = await fetchXhsNote(new URL(item.href, BASE).href);
    const ownerName = settings.social.xhsOwnerName || '';
    const ownerId = settings.social.xhsOwnerUserId || '';
    const list = [];
    for (const comment of note.comments || []) {
      if (comment.isReply || !comment.content || comment.author === selfName) continue;
      const isOwner = Boolean((ownerId && comment.authorId === ownerId) || (ownerName && comment.author === ownerName));
      if (isOwner) list.unshift({ comment, isOwner: true });
      else list.push({ comment, isOwner: false });
    }
    for (const { comment, isOwner } of list) {
      if (actions.length >= maxReplies) break;
      const budget = canAct('reply');
      if (!budget.ok) return { ok: true, reason: budget.reason, actions };
      const receiptKey = `xhs_comment_replied:${item.noteId}:${comment.id}`;
      if (!comment.id || kvGet(receiptKey)) continue;
      if (await selfReplyExists(note, comment, selfName)) continue;
      const result = await llm.chat(
        [
          { role: 'system', content: '你只输出严格 JSON，不要 markdown。' },
          {
            role: 'user',
            content: buildXhsNotificationReplyPrompt({
              settings,
              mood: getMood(),
              note,
              comment,
              isOwner,
              ownerName,
            }),
          },
        ],
        {
          kind: 'xhs_reply',
          model: settings.model.name,
          temperature: 0.85,
          maxTokens: 300,
          reasoningEffort: 'low',
          responseFormat: { type: 'json_object' },
          mockKind: 'xhs_reply',
        },
      );
      const parsed = parseJsonLoose(result.content);
      if (!isOwner && parsed.reply !== true) continue;
      const text = cleanComment(parsed.text);
      if (!text) continue;
      const gate = assertPublicContent(text, { settings, hisMessages: recentUserMessages(40) });
      if (!gate.ok) {
        addEvent('xhs_reply_blocked', '她想回的评论里有不该公开的内容，闸门拦下了', { noteId: item.noteId, reason: gate.reason });
        continue;
      }
      let sent;
      try {
        kvSet(receiptKey, 'pending');
        sent = await replyXhsComment(comment, text);
        kvSet(receiptKey, 'sent');
      } catch (error) {
        if (isRiskyError(error)) {
          triggerXhsCooldown(6, error.message);
          addEvent('xhs_reply_error', '回复撞到安全验证，所有动作先停 6 小时', { noteId: item.noteId, error: error.message });
          return { ok: true, reason: '撞到安全验证，先停了', actions };
        }
        addEvent('xhs_reply_error', '评论回复没发出去', { noteId: item.noteId, error: error.message });
        continue;
      }
      const keys = budget.keys || budgetKeys('reply');
      bump(keys.day);
      bump(keys.hour);
      actions.push({
        type: 'reply',
        noteId: item.noteId,
        title: note.title,
        author: comment.author,
        isOwner,
        text,
        verified: sent.verified,
        at: nowIso(),
      });
      recordXhsActivity({
        type: isOwner ? 'reply_owner' : 'reply',
        note: note.title,
        text,
        target: comment.author || '',
      });
      addEvent('xhs_reply', `小红书回复了 ${isOwner ? '主人' : comment.author} 的评论`, {
        noteId: item.noteId,
        text,
        isOwner,
        verified: sent.verified,
      });
      await sleep(20000 + Math.random() * 40000);
    }
  }
  return { ok: true, actions };
}
