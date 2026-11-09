// X（推特）自主运营的业务层：限速/冷却在这里，浏览器原语在 src/channels/x.js。
//
// 与小红书同一套口径，两处更严：
// 1) 主动关注、私信永远只出草稿（xDailyFollowMax 默认 0），因为 X 对这两类行为直接进封禁队列；
// 2) 发推只填草稿，真要发出去必须在界面上点一下"发布"并逐字核对；
// 3) 他的账号（xOwnerHandle）的推文和评论必须回，不占陌生人的额度——但风控冷却照守，那是账号安全。

import { loadSettings } from '../config.js';
import { addEvent, kvGet, kvGetJson, kvSet, kvSetJson } from '../db.js';
import { logger } from '../logger.js';
import { buildXReplyPrompt } from '../prompt.js';
import { parseJsonLoose } from '../util.js';
import { getMood } from '../mood.js';
import { isRiskyXError, triggerXCooldown, xCooldownUntil } from './x-safety.js';
import { fillXPost, reactXTweet, readSelfTweets, readTweetThread, readXTimeline, replyXTweet, recordXActivity } from './x.js';

const HOUR_KEY = 'x_action_hour';

// 「逛的关键词」就是用来搜的：这个号没关注任何人，首页时间线本来就是空的。
// 每轮轮一个词，别每次都搜同一个；一个都没填才回首页。
export function nextXKeyword(keywords, turn = 0) {
  const list = (Array.isArray(keywords) ? keywords : []).filter(Boolean);
  if (!list.length) return { keyword: '', tab: 'home', turn: 0 };
  const index = Math.abs(Math.trunc(Number(turn) || 0)) % list.length;
  return { keyword: list[index], tab: 'search', turn: index + 1 };
}

function localDayKey() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function localHour() {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date()));
}

function budgetKeys(kind) {
  const day = localDayKey();
  const prefix =
    kind === 'reply' ? 'x_reply_day'
      : kind === 'like' ? 'x_like_day'
        : kind === 'retweet' ? 'x_retweet_day'
          : kind === 'follow' ? 'x_follow_day'
            : 'x_post_day';
  return { day: `${prefix}:${day}`, hour: `${HOUR_KEY}:${day}-${localHour()}` };
}

function readCount(key) {
  return Number(kvGet(key, '0') || 0);
}

function bump(key) {
  kvSet(key, String(readCount(key) + 1));
}

export function xBudgetStatus() {
  const social = loadSettings().social || {};
  return {
    repliesToday: readCount(budgetKeys('reply').day),
    likesToday: readCount(budgetKeys('like').day),
    retweetsToday: readCount(budgetKeys('retweet').day),
    draftsToday: readCount(budgetKeys('post').day),
    actionsThisHour: readCount(budgetKeys('reply').hour),
    dailyReplyMax: Number(social.xDailyReplyMax || 0),
    dailyLikeMax: Number(social.xDailyLikeMax || 0),
    dailyRetweetMax: Number(social.xDailyRetweetMax || 0),
    dailyPostMax: Number(social.xDailyPostMax || 0),
    hourlyActionMax: Number(social.xHourlyActionMax || 2),
    dailyActionMax: Number(social.xDailyActionMax || 10),
    cooldownUntil: xCooldownUntil(),
  };
}

// ignoreCounts：主人那条不设条数上限；但冷却必须照守（那是账号安全，不是矜持）。
export function canActX(kind, { ignoreCounts = false } = {}) {
  const social = loadSettings().social || {};
  if (!social.xEnabled) return { ok: false, reason: 'X（推特）互动未开启' };
  const cooldown = xCooldownUntil();
  if (cooldown && new Date(cooldown).getTime() > Date.now()) {
    return { ok: false, reason: `X 风控冷却中，到 ${cooldown.slice(11, 16)} 再试` };
  }
  if (ignoreCounts) return { ok: true, keys: null, unlimited: true, reason: '' };
  const keys = budgetKeys(kind);
  const dailyMax =
    kind === 'reply' ? Number(social.xDailyReplyMax || 0)
      : kind === 'like' ? Number(social.xDailyLikeMax || 0)
        : kind === 'retweet' ? Number(social.xDailyRetweetMax || 0)
          : kind === 'follow' ? Number(social.xDailyFollowMax || 0)
            : Number(social.xDailyPostMax || 0);
  if (kind === 'follow' && dailyMax <= 0) {
    return { ok: false, reason: '主动关注默认关闭（X 上这类行为最容易直接进封禁队列），只出草稿' };
  }
  if (readCount(keys.hour) >= Number(social.xHourlyActionMax || 2)) return { ok: false, reason: '本小时 X 动作已达上限' };
  if (readCount(keys.day) >= dailyMax) {
    const label = kind === 'reply' ? '回复' : kind === 'like' ? '点赞' : kind === 'retweet' ? '转推' : kind === 'follow' ? '关注' : '发推';
    return { ok: false, reason: `今天${label}已达上限（${dailyMax} 次）` };
  }
  const totalKeys = ['reply', 'like', 'retweet', 'post'].map((k) => budgetKeys(k).day);
  const totalToday = totalKeys.reduce((sum, key) => sum + readCount(key), 0);
  const totalMax = Number(social.xDailyActionMax || 0);
  if (totalMax > 0 && totalToday >= totalMax) {
    return { ok: false, reason: `今天 X 上所有动作加起来已到 ${totalMax} 次上限` };
  }
  return { ok: true, keys };
}

function seenKey() {
  return 'x_seen_tweets';
}

function seenSet() {
  return new Set(kvGetJson(seenKey(), []));
}

function rememberSeen(id) {
  if (!id) return;
  const set = seenSet();
  set.add(id);
  kvSetJson(seenKey(), [...set].slice(-500));
}

// 敏感话题一律不开口：和小红书那份名单同源，X 上更容易被举报。
const SENSITIVE = /(新闻|事故|灾难|死亡|去世|伤亡|政治|政府|战争|军事|选举|疫苗|自杀|家暴|未成年|偷拍|隐私|八卦|爆料|求助|捐款|众筹|色情|约炮)/;
// 下面三类是照着她真实时间线里量到的原话补的（判据里就是那些原句）：
// 光靠上面那份名单漏得太狠——"最不民主""我操尼玛""有主人要进来吗"都会当成可回的话题，
// 这种话回出去，被人截图挂的就是他这个号。
const VULGAR = /(傻逼|沙壁|尼玛|妈的|他妈|特么|卧槽|我操|草泥马|狗东西|畜生|不是人|废物|\bfw\b|\bshit\b|\bfuck\b|\bbitch\b)/i;
const SEXUAL = /(牛子|鸡巴|鸡鸡|屌|撸射|自己撸|手冲|射精|做爱|啪啪|口爆|口交|插入|高潮|自慰|裸照|裸聊|下面湿|骚货|淫|被狠狠干|狠狠干|刚约的|要进来|楼凤|外围|文爱|炮友|福利姬|上床|开房|一夜情|磕炮|porn|nude|anal)/i;
const POLITICAL = /(民主|独裁|政权|共产党|中共|领导人|台湾|香港|西藏|新疆|统一|独立|抗议|游行|制裁|旁氏|崩盘|经济危机|election|president)/;

export function shouldSkipTweet(tweet) {
  const text = String(tweet?.text || '');
  if (!text) return '没有正文';
  if (SENSITIVE.test(text)) return '话题敏感';
  if (SEXUAL.test(text)) return '带色情内容';
  if (VULGAR.test(text)) return '说话难听';
  if (POLITICAL.test(text)) return '政治话题';
  if (/^\s*(RT|转发)/i.test(text)) return '是转发';
  return '';
}

// 实测模型偶尔在 maxTokens 处把 JSON 截断（日志原话：Unterminated string in JSON at position 44）。
// 这种时候不该把异常抛出去把整轮逛打断：能捞出 reply/text 就用，捞不出就当"这条她没想好"，
// 下一条照看——丢一条对话比记一次系统故障好。
export function parseHerAnswer(content) {
  try {
    return parseJsonLoose(content) || {};
  } catch {
    const raw = String(content || '');
    const reply = /"reply"\s*:\s*(true|false)/.exec(raw);
    if (!reply) return {};
    const open = /"text"\s*:\s*"/.exec(raw);
    let text = '';
    if (open) {
      const rest = raw.slice(open.index + open[0].length);
      const closed = rest.match(/^((?:[^"\\]|\\.)*)"/);
      const fragment = closed ? closed[1] : rest;
      try {
        text = JSON.parse(`"${fragment}"`);
      } catch {
        text = fragment;
      }
    }
    return { reply: reply[1] === 'true', text: String(text || ''), salvaged: true };
  }
}

async function askHer(llm, { tweet, isOwner, ownerHandle, mode }) {
  const settings = loadSettings();
  const result = await llm.chat(
    [
      { role: 'system', content: '你只输出严格 JSON，不要 markdown。' },
      { role: 'user', content: buildXReplyPrompt({ settings, mood: getMood(), tweet, isOwner, ownerHandle }) },
    ],
    {
      kind: mode === 'reply' ? 'x_reply' : 'x_comment',
      model: settings.model.name,
      temperature: 0.85,
      maxTokens: 260,
      reasoningEffort: 'low',
      responseFormat: { type: 'json_object' },
      mockKind: 'x_reply',
    },
  );
  return parseHerAnswer(result.content);
}

// 逛时间线 → 该说话就回一句，想赞就赞。发推不在这里（那是草稿链路）。
export async function processXExplore({ llm, maxTweets = 0, force = false } = {}) {
  const social = loadSettings().social || {};
  if (!social.xEnabled) return { ok: false, reason: 'X（推特）互动未开启', actions: [] };
  if (!social.xAutoBrowse && !force) return { ok: false, reason: '自动逛 X 未开启', actions: [] };
  const cooldown = xCooldownUntil();
  if (cooldown && new Date(cooldown).getTime() > Date.now()) {
    return { ok: false, reason: `X 风控冷却中，到 ${cooldown.slice(11, 16)} 再试`, actions: [] };
  }
  const mood = getMood();
  const appetite = Math.max(2, Math.min(6, 2 + Math.round(Number(mood.energy || 0.5) * 4)));
  const limit = Number(maxTweets) > 0 ? Math.min(Number(maxTweets), appetite) : appetite;
  const keywords = String(social.xSearchKeywords || '').split(/[,，\s]+/).filter(Boolean);
  const plan = nextXKeyword(keywords, kvGet('x_keyword_turn'));
  if (plan.tab === 'search') kvSet('x_keyword_turn', String(plan.turn));
  const feed = await readXTimeline({ tab: plan.tab, keyword: plan.keyword, limit: Math.max(12, limit * 3) });
  const seen = seenSet();
  const ownerHandle = String(social.xOwnerHandle || '').toLowerCase();
  const actions = [];
  let browsed = 0;
  let replied = 0;
  let liked = 0;
  let passed = 0;

  for (const tweet of feed) {
    if (Date.parse(xCooldownUntil()) > Date.now()) break;
    if (browsed >= limit) break;
    if (!tweet.id || seen.has(tweet.id)) continue;
    if (ownerHandle && String(tweet.handle || '').toLowerCase() === ownerHandle) continue;
    seen.add(tweet.id);
    browsed += 1;
    rememberSeen(tweet.id);
    const skip = shouldSkipTweet(tweet);
    if (skip) {
      passed += 1;
      continue;
    }
    const budget = canActX('reply');
    if (!budget.ok) break;
    let parsed;
    try {
      parsed = await askHer(llm, { tweet, isOwner: false, ownerHandle, mode: 'comment' });
    } catch (error) {
      logger.warn('X 上她没想好怎么回', { error: String(error.message).slice(0, 60) });
      continue;
    }
    const text = String(parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 260);
    if (parsed.reply !== true || !text) {
      passed += 1;
      if (parsed.like && social.xAutoLike) {
        const gate = canActX('like');
        if (gate.ok) {
          try {
            const done = await reactXTweet(tweet.href, 'like');
            if (done.ok && !done.already) {
              bump(gate.keys.day);
              bump(gate.keys.hour);
              liked += 1;
              recordXActivity({ type: 'like', target: `@${tweet.handle}`, note: text0(tweet.text) });
            }
          } catch (error) {
            if (isRiskyXError(error)) triggerXCooldown(24, error.message);
          }
        }
      }
      continue;
    }
    try {
      const posted = await replyXTweet(tweet.href, text);
      bump(budget.keys.day);
      bump(budget.keys.hour);
      replied += 1;
      actions.push({ type: 'reply', id: tweet.id, handle: tweet.handle, text, verified: posted.verified, at: new Date().toISOString() });
      recordXActivity({ type: 'reply', target: `@${tweet.handle}`, text, note: text0(tweet.text) });
      addEvent('x_reply', `她在 X 上回了一句（@${tweet.handle}）`, { id: tweet.id, text, verified: posted.verified });
      if (parsed.like && social.xAutoLike) {
        const gate = canActX('like');
        if (gate.ok) {
          const done = await reactXTweet(tweet.href, 'like').catch(() => ({ ok: false }));
          if (done.ok && !done.already) {
            bump(gate.keys.day);
            bump(gate.keys.hour);
            liked += 1;
          }
        }
      }
    } catch (error) {
      if (isRiskyXError(error)) triggerXCooldown(24, error.message);
      logger.warn('X 回复没做成', { id: tweet.id, error: String(error.message).slice(0, 80) });
      addEvent('x_reply_error', 'X 上回复没做成', { id: tweet.id, error: String(error.message).slice(0, 100) });
    }
    await new Promise((resolve) => setTimeout(resolve, 20000 + Math.random() * 40000));
  }
  addEvent('x_browse_done', `她逛了 X ${browsed} 条：回了 ${replied} 句，点了 ${liked} 个赞，${passed} 条看完没说话`, { appetite: limit, keyword: plan.keyword || '', keywords: keywords.length });
  return { ok: true, actions, browsed, replied, liked, passed, appetite: limit };
}

// 回别人在她推文下面的评论：他的评论必须回，陌生人的按额度回。
export async function processXOwnReplies({ llm, maxTweets = 3, maxReplies = 2, force = false } = {}) {
  const social = loadSettings().social || {};
  if (!social.xEnabled) return { ok: false, reason: 'X（推特）互动未开启', actions: [] };
  if (!social.xAutoReply && !force) return { ok: false, reason: 'X 自动回复未开启', actions: [] };
  const { handle, tweets } = await readSelfTweets(maxTweets);
  const selfName = kvGet('x_self_handle') || handle;
  const ownerHandle = String(social.xOwnerHandle || '').toLowerCase();
  const actions = [];
  for (const tweet of tweets) {
    if (!tweet.href) continue;
    let thread;
    try {
      thread = await readTweetThread(tweet.href, 14);
    } catch (error) {
      logger.warn('X 推文详情读不到', { href: tweet.href, error: String(error.message).slice(0, 60) });
      continue;
    }
    const replies = thread.filter((item) => item.id && item.id !== tweet.id && String(item.handle || '').toLowerCase() !== String(selfName || '').toLowerCase());
    for (const item of replies) {
      const isOwner = Boolean(ownerHandle && String(item.handle || '').toLowerCase() === ownerHandle);
      if (!isOwner && actions.length >= maxReplies) break;
      const receiptKey = `x_replied:${item.id}`;
      if (kvGet(receiptKey)) continue;
      const budget = canActX('reply', { ignoreCounts: isOwner });
      if (!budget.ok) return { ok: true, reason: budget.reason, actions };
      const skip = shouldSkipTweet(item);
      if (skip && !isOwner) continue;
      let parsed;
      try {
        parsed = await askHer(llm, { tweet: item, isOwner, ownerHandle, mode: 'reply' });
      } catch (error) {
        logger.warn('X 评论她没想好怎么回', { error: String(error.message).slice(0, 60) });
        continue;
      }
      const text = String(parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 260);
      if (!isOwner && (parsed.reply !== true || !text)) continue;
      if (!text) continue;
      try {
        const posted = await replyXTweet(item.href || tweet.href, text);
        kvSet(receiptKey, nowStamp());
        if (budget.keys) {
          bump(budget.keys.day);
          bump(budget.keys.hour);
        }
        actions.push({ type: 'reply', to: item.handle, text, verified: posted.verified, at: nowStamp() });
        recordXActivity({ type: 'reply', target: `@${item.handle}`, text, note: text0(item.text) });
        addEvent('x_reply', `她回了 @${item.handle} 在她推文下的评论`, { text, isOwner, verified: posted.verified });
      } catch (error) {
        if (isRiskyXError(error)) triggerXCooldown(24, error.message);
        logger.warn('X 评论回复没做成', { handle: item.handle, error: String(error.message).slice(0, 80) });
      }
      await new Promise((resolve) => setTimeout(resolve, 20000 + Math.random() * 40000));
    }
  }
  return { ok: true, actions, replied: actions.length };
}

// 起草一条推文（只填不发）。
export async function draftXPost({ topic = '', llm } = {}) {
  const social = loadSettings().social || {};
  if (!social.xEnabled) return { ok: false, reason: 'X（推特）互动未开启' };
  const budget = canActX('post');
  if (!budget.ok) return { ok: false, reason: budget.reason };
  const cooldown = xCooldownUntil();
  if (cooldown && new Date(cooldown).getTime() > Date.now()) return { ok: false, reason: `X 风控冷却中，到 ${cooldown.slice(11, 16)} 再试` };
  const { buildXPostPrompt } = await import('../prompt.js');
  const settings = loadSettings();
  let text = '';
  try {
    const result = await llm.chat(
      [
        { role: 'system', content: '你只输出严格 JSON，不要 markdown。' },
        { role: 'user', content: buildXPostPrompt({ settings, mood: getMood(), topic }) },
      ],
      { kind: 'x_post', model: settings.model.name, temperature: 0.9, maxTokens: 220, reasoningEffort: 'low', responseFormat: { type: 'json_object' }, mockKind: 'x_post' },
    );
    text = String((parseHerAnswer(result.content) || {}).text || '').replace(/\s+/g, ' ').trim().slice(0, 260);
  } catch (error) {
    return { ok: false, reason: `她没写出这条：${String(error.message).slice(0, 60)}` };
  }
  if (!text) {
    recordXActivity({ type: 'draft', text: '', note: '她今天没什么想说', ok: true });
    return { ok: false, reason: '她今天没什么想说的', skipped: true };
  }
  const filled = await fillXPost({ text });
  if (!filled.ok) return filled;
  recordXActivity({ type: 'draft', text, note: '已填进输入框，等他点发布' });
  return { ok: true, drafted: true, published: false, fillId: filled.fillId, text, chars: text.length };
}

// 手动点一下也要走同一个闸门、同一个计数：不然界面上的"回复/点赞"能绕开每日上限。
export async function manualXAct(kind, { href, text, llm } = {}) {
  const gate = canActX(kind);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  let out;
  try {
    if (kind === 'like' || kind === 'retweet') out = await reactXTweet(href, kind);
    else if (kind === 'reply') out = await replyXTweet(href, text);
    else if (kind === 'post') out = await fillXPost({ text });
    else return { ok: false, reason: `不支持的动作：${kind}` };
  } catch (error) {
    if (isRiskyXError(error)) triggerXCooldown(24, error.message);
    logger.warn('X 手动动作没做成', { kind, error: String(error.message).slice(0, 100) });
    return { ok: false, reason: String(error.message || error).slice(0, 140), code: error.code || '' };
  }
  if (out.ok && !out.already && gate.keys) {
    bump(gate.keys.day);
    bump(gate.keys.hour);
    recordXActivity({ type: kind, target: String(href || '').slice(0, 60), text: String(text || '').slice(0, 120), note: '手动' });
  }
  if (out.ok && kind === 'reply') addEvent('x_reply', '她在 X 上手动回了一句', { href, chars: String(text || '').length });
  if (llm && !out.ok) logger.debug('X 手动动作没做成', { kind, reason: out.reason || '' });
  return out;
}

function text0(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function nowStamp() {
  return new Date().toISOString();
}

export function xActivitySummary({ days = 7 } = {}) {
  const floor = new Date(Date.now() - days * 86400000).toISOString();
  const list = kvGetJson('x_activity', []).filter((x) => x && x.at >= floor);
  const byType = {};
  for (const item of list) byType[item.type] = (byType[item.type] || 0) + 1;
  return { days, total: list.length, byType, recent: list.slice(-10).reverse() };
}
