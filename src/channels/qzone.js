import fs from 'node:fs';
import path from 'node:path';
import { loadSettings, paths } from '../config.js';
import { addEvent, kvDeletePrefix, kvGet, kvSet, kvGetJson, kvSetJson, recentUserMessages } from '../db.js';
import { checkBotIdentity } from '../identity.js';
import { logger } from '../logger.js';
import { assertPublicContent } from '../privacy.js';
import { hashText, nowIso, shanghaiParts, writeJsonAtomic } from '../util.js';
import { beginEffect, finishEffect, failEffect, DeliveryUnknownError } from '../effects.js';

const COOKIE_FILE = path.join(paths.data, 'qzone-cookie.json');
const BASE = (process.env.QZONE_BASE_URL || 'https://user.qzone.qq.com').replace(/\/+$/, '');
let msglistDisabledUntil = 0;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const REFRESHABLE_KEYS = [
  'p_skey', 'skey', 'ptcz', 'uin', 'p_uin', 'loginuin', 'fe_edm_rftok', 'qm_sid', 'authdk', 'z_idin', 'fp_in', 'evGsver',
];

function assertCookieIdentity(parsed) {
  const result = checkBotIdentity({ selfId: parsed?.uin, ownerId: kvGet('qq_owner_id'), botAccount: loadSettings().qq.botAccount });
  if (!result.ok) throw new Error(`QQ 空间拒绝这份 Cookie：${result.reason}`);
}

function clearAccountCache() {
  kvDeletePrefix('qzone_');
  msglistDisabledUntil = 0;
}

function writeCookieFile(parsed, rotatedVia) {
  assertCookieIdentity(parsed);
  writeJsonAtomic(COOKIE_FILE, { cookie: parsed.cookie, uin: parsed.uin, updatedAt: nowIso(), rotatedVia: rotatedVia || '' });
}

/**
 * 腾讯会在响应头里滚动下发新的 p_skey / skey（这也是手抄 Cookie 几天就废的原因）。
 * 每次请求都把新值吸收回本地存储，能把自己撑很久，不用人工再复制。
 */
export function absorbSetCookie(res, label = '') {
  let list = [];
  try {
    list = typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  } catch {
    return 0;
  }
  if (!list.length) return 0;
  const stored = getQzoneCookie();
  if (!stored?.map) return 0;
  const map = { ...stored.map };
  const changed = [];
  for (const line of list) {
    const pair = String(line).split(';')[0];
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!REFRESHABLE_KEYS.includes(key)) continue;
    if (!value || value === 'EXP' || value === 'deleted') continue;
    if (map[key] !== value) {
      map[key] = value;
      changed.push(key);
    }
  }
  if (!changed.length) return 0;
  const rebuilt = Object.entries(map)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
  try {
    writeCookieFile(parseCookieString(rebuilt), label);
    logger.info('空间 Cookie 自动续上了', { keys: changed.join(','), via: label.slice(0, 40) });
    addEvent('qzone_cookie_renewed', `空间 Cookie 自动换了新值（${changed.join(', ')}）`, { via: label.slice(0, 60) });
  } catch (error) {
    logger.warn('吸收新 Cookie 失败，继续用旧的', { error: error.message });
    return 0;
  }
  return changed.length;
}

const rawFetch = globalThis.fetch;

async function qfetch(url, options = {}, label = '') {
  const stored = getQzoneCookie();
  if (!stored) throw new Error('还没有配置 QQ 空间 Cookie');
  assertCookieIdentity(stored);
  let res;
  try { res = await rawFetch(url, { ...options, redirect: 'manual' }); }
  catch (error) {
    if (options.method === 'POST') throw new DeliveryUnknownError('QQ 空间发送结果未知，请先在平台核实', error);
    throw error;
  }
  if (getQzoneCookie()?.cookie === stored.cookie) absorbSetCookie(res, label || String(url).slice(0, 50));
  return res;
}

export function qzoneCookieHealth() {
  const stored = getQzoneCookie();
  if (!stored) return { configured: false, reason: '还没有 Cookie' };
  const okAt = kvGet('qzone_cookie_ok_at') || stored.updatedAt || '';
  const ageHours = okAt ? Math.round((Date.now() - new Date(okAt).getTime()) / 360000) / 10 : null;
  return {
    configured: true,
    uin: stored.uin,
    updatedAt: stored.updatedAt || null,
    lastOkAt: okAt || null,
    ageHours,
    stale: ageHours == null || ageHours > 24,
  };
}

export function parseCookieString(input) {
  const cookie = String(input || '')
    .trim()
    .replace(/^Cookie:\s*/i, '')
    .replace(/\r?\n/g, ' ')
    .trim();
  if (!cookie) throw new Error('Cookie 是空的');
  const map = {};
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) map[key] = value;
  }
  const rawUin = map.uin || map.p_uin || '';
  if (!/^[ou]?\d{5,12}$/i.test(rawUin)) throw new Error('Cookie 里的 uin 格式不合法');
  const uin = rawUin.replace(/^[ou]/i, '');
  if (map.p_uin && String(map.p_uin).replace(/^[ou]/i, '').replace(/^0+/, '') !== uin.replace(/^0+/, '')) throw new Error('Cookie 中的 uin 与 p_uin 账号不一致');
  if (!map.p_skey && !map.skey) throw new Error('Cookie 里找不到 p_skey / skey，请重新从 QQ 空间复制完整 Cookie');
  return { cookie, map, uin, pSkey: map.p_skey || '', skey: map.skey || '', pUin: map.p_uin || '' };
}

/** 与 Qzone Web 的 g_tk 算法一致（32 位有符号溢出后取低 31 位） */
export function calcGtk(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash += (hash << 5) + value.charCodeAt(i);
  }
  return hash & 0x7fffffff;
}

export function buildPublishForm({ content, uin }) {
  return new URLSearchParams({
    syn_tweet_version: '1',
    paramstr: '1',
    pic_template: '',
    richtype: '',
    richval: '',
    special_url: '',
    subrichtype: '',
    con: String(content || ''),
    feedversion: '1',
    ver: '1',
    ugc_right: '1',
    to_sign: '0',
    hostuin: String(uin || ''),
    code_version: '1',
    format: 'fs',
    qzreferrer: `https://user.qzone.qq.com/${uin}/main`,
  });
}

export function parseJsonp(text) {
  const s = String(text || '').trim();
  if (!s) return { _empty: true };
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {
      // continue
    }
  }
  const frame = s.indexOf('frameElement.callback(');
  let body = null;
  if (frame >= 0) {
    const start = frame + 'frameElement.callback('.length - 1;
    body = extractBalanced(s, start);
  }
  if (!body) {
    const open = s.indexOf('(');
    if (open >= 0) body = extractBalanced(s, open);
  }
  if (body) {
    try {
      return JSON.parse(body);
    } catch {
      // continue
    }
  }
  try {
    return JSON.parse(s);
  } catch {
    return { _empty: true, raw: s.slice(0, 300) };
  }
}

function extractBalanced(s, openIdx) {
  let depth = 0;
  let inString = false;
  let quote = '';
  for (let i = openIdx; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return s.slice(openIdx + 1, i);
    }
  }
  return null;
}

export function getQzoneCookie() {
  try {
    const data = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    if (!data?.cookie) return null;
    return { ...parseCookieString(data.cookie), updatedAt: data.updatedAt || null };
  } catch {
    return null;
  }
}

export function saveQzoneCookie(input) {
  const parsed = parseCookieString(input);
  assertCookieIdentity(parsed);
  const previous = getQzoneCookie();
  writeCookieFile(parsed, 'manual');
  if (!previous || previous.uin !== parsed.uin) clearAccountCache();
  msglistDisabledUntil = 0;
  kvSet('qzone_cookie_bad', '');
  kvSet('qzone_cookie_ok_at', '');
  kvSet('qzone_cookie_checked_at', '');
  logger.info('已保存 QQ 空间 Cookie', { uin: parsed.uin });
  return qzoneStatus();
}

export function clearQzoneCookie() {
  try { fs.unlinkSync(COOKIE_FILE); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  clearAccountCache();
  return qzoneStatus();
}

export function qzoneStatus() {
  const stored = getQzoneCookie();
  if (!stored) {
    return {
      configured: false,
      uin: '',
      updatedAt: null,
      corrupt: fs.existsSync(COOKIE_FILE),
      health: qzoneCookieHealth(),
      expiredNotice: kvGet('qzone_cookie_bad') || '',
    };
  }
  return {
    configured: true,
    uin: stored.uin,
    updatedAt: stored.updatedAt,
    hasPskey: Boolean(stored.pSkey),
    hasSkey: Boolean(stored.skey),
    health: qzoneCookieHealth(),
    identityOk: checkBotIdentity({ selfId: stored.uin, ownerId: kvGet('qq_owner_id'), botAccount: loadSettings().qq.botAccount }).ok,
    expiredNotice: kvGet('qzone_cookie_bad') || '',
    autoRenew: true,
  };
}

export async function verifyQzoneCookie() {
  const stored = getQzoneCookie();
  if (!stored) return { ok: false, reason: '还没有配置 QQ 空间 Cookie' };
  try {
    assertCookieIdentity(stored);
    await fetchQzonePosts({ num: 1 });
    kvSet('qzone_cookie_ok_at', nowIso());
    kvSet('qzone_cookie_bad', '');
    return { ok: true, status: 200, reason: '空间数据读取成功，Cookie 账号已核实' };
  } catch (error) {
    kvSet('qzone_cookie_bad', error.message);
    return { ok: false, reason: error.message };
  }
}

function qzoneError(data, prefix = 'QQ空间请求失败') {
  const code = data?.code ?? data?.ret ?? 'unknown';
  const message = data?.message || data?.msg || (data?._empty ? '响应为空' : '没有返回数据');
  const authCodes = [-3000, -10000, -10001, -10006, 1401];
  if (authCodes.includes(Number(code))) {
    return new Error('QQ 空间 Cookie 可能失效或触发风控，请重新登录空间复制完整 Cookie');
  }
  return new Error(`${prefix}：${message}（code=${code}）`);
}

function timestampToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function qzoneTimeTextToIso(text, now = new Date()) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/刚刚/.test(s)) return now.toISOString();
  const relative = s.match(/^(\d+)\s*(秒|分钟|小时)前$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] === '秒' ? 1000 : relative[2] === '分钟' ? 60000 : 3600000;
    return new Date(now.getTime() - amount * unit).toISOString();
  }

  const p = shanghaiParts(now);
  const dayBase = Date.UTC(p.year, p.month - 1, p.day, -8, 0);
  const yesterday = s.match(/^昨天(?:\s*(\d{1,2}):(\d{2}))?/);
  if (yesterday) {
    const hour = Number(yesterday[1] ?? 12);
    const minute = Number(yesterday[2] ?? 0);
    return new Date(dayBase - 86400000 + hour * 3600000 + minute * 60000).toISOString();
  }

  const absolute = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (absolute) {
    const ts = Date.UTC(
      Number(absolute[1]),
      Number(absolute[2]) - 1,
      Number(absolute[3]),
      Number(absolute[4] ?? 12) - 8,
      Number(absolute[5] ?? 0),
    );
    return new Date(ts).toISOString();
  }

  const monthDay = s.match(/^(\d{1,2})[月\-/](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (monthDay) {
    let ts = Date.UTC(
      p.year,
      Number(monthDay[1]) - 1,
      Number(monthDay[2]),
      Number(monthDay[3] ?? 12) - 8,
      Number(monthDay[4] ?? 0),
    );
    if (ts > now.getTime() + 2 * 86400000) ts = Date.UTC(p.year - 1, Number(monthDay[1]) - 1, Number(monthDay[2]), Number(monthDay[3] ?? 12) - 8, Number(monthDay[4] ?? 0));
    return new Date(ts).toISOString();
  }

  const clock = s.match(/^(?:今天\s*)?(\d{1,2}):(\d{2})$/);
  if (clock) {
    let ts = dayBase + Number(clock[1]) * 3600000 + Number(clock[2]) * 60000;
    if (ts > now.getTime() + 2 * 60000) ts -= 86400000;
    return new Date(ts).toISOString();
  }
  return null;
}

function mapComment(raw) {
  return {
    id: String(raw?.commentid ?? raw?.commentId ?? raw?.tid ?? ''),
    uin: String(raw?.uin ?? raw?.commentUin ?? ''),
    nickname: String(raw?.nickname ?? raw?.name ?? ''),
    content: String(raw?.content ?? ''),
    createdAt: timestampToIso(raw?.createTime ?? raw?.created_time ?? raw?.abstime),
  };
}

function mapLike(raw) {
  return {
    uin: String(raw?.uin ?? raw?.user_uin ?? ''),
    nickname: String(raw?.nickname ?? raw?.name ?? ''),
    createdAt: timestampToIso(raw?.abstime ?? raw?.createTime),
  };
}

export async function fetchQzonePosts({ num = 20 } = {}) {
  if (Date.now() >= msglistDisabledUntil) {
    try {
      return await fetchQzonePostsViaMsglist({ num });
    } catch (error) {
      msglistDisabledUntil = Date.now() + 6 * 3600000;
      logger.warn('msglist 读取失败，6 小时内直接走 feeds3', { error: error.message });
    }
  }
  return fetchQzonePostsViaFeeds3({ num });
}

async function fetchQzonePostsViaMsglist({ num = 20 } = {}) {
  const stored = getQzoneCookie();
  if (!stored) throw new Error('还没有配置 QQ 空间 Cookie');
  const gtk = calcGtk(stored.pSkey || stored.skey);
  const params = new URLSearchParams({
    uin: stored.uin,
    ftype: '0',
    sort: '0',
    pos: '0',
    num: String(Math.min(50, Math.max(1, Number(num) || 20))),
    replynum: '20',
    g_tk: String(gtk),
    code_version: '1',
    format: 'json',
    qzreferrer: `https://user.qzone.qq.com/${stored.uin}/main`,
  });
  const url = `${BASE}/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6?${params}`;
  const res = await qfetch(url, {
    headers: {
      Cookie: stored.cookie,
      Referer: `https://user.qzone.qq.com/${stored.uin}/main`,
      'User-Agent': UA,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`读取说说失败：HTTP ${res.status}`);
  const data = parseJsonp(await res.text());
  if (![0, '0'].includes(data?.code ?? data?.ret)) throw qzoneError(data, '读取说说失败');
  const list = data.msglist ?? data.data?.msglist;
  if (!Array.isArray(list)) throw new Error('空间响应未提供有效说说列表');
  const posts = list.map((raw) => ({
    tid: String(raw?.tid ?? raw?.t1_tid ?? ''),
    content: String(raw?.content ?? ''),
    createdAt: timestampToIso(raw?.created_time ?? raw?.createTime ?? raw?.abstime),
    likeCount: Number(raw?.likenum ?? raw?.like_count ?? 0),
    commentCount: Number(raw?.cmtnum ?? raw?.commentnum ?? 0),
    likes: (raw?.likes || raw?.like || []).slice(0, 20).map(mapLike),
    comments: (raw?.conlist || []).slice(0, 20).map((item) => ({
      ...mapComment(item),
      replies: (item?.replies || item?.replyList || item?.list_3 || []).slice(0, 20).map(mapComment),
    })),
  }));
  kvSet('qzone_cookie_ok_at', nowIso());
  kvSet('qzone_cookie_bad', '');
  logger.info('读取 QQ 空间说说成功', { count: posts.length });
  return { uin: stored.uin, posts, fetchedAt: nowIso() };
}

function unescapeFeeds3(text) {
  return String(text || '')
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\[tnr]/g, ' ');
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ');
}

function attrOf(html, name) {
  const match = String(html || '').match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return match ? match[1] : '';
}

function parseFeeds3Comment(liTag, body) {
  const anchor = body.match(/<a[^>]*class="[^"]*nickname[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  let rest = anchor ? body.slice(anchor.index + anchor[0].length) : body;
  rest = rest.split(/<div class="comments-op"/i)[0];
  const content = decodeEntities(stripHtml(rest)).replace(/^[\s:：]+/, '').replace(/\s+/g, ' ').trim();
  const nickFromAnchor = decodeEntities(stripHtml(anchor?.[1] || '')).replace(/\s+/g, ' ').trim();
  const nickname = (nickFromAnchor || attrOf(liTag, 'data-nick') || '').replace(/\[em\][\s\S]*?\[\/em\]/gi, '').trim();
  const op = body.match(/<div[^>]*class="[^"]*comments-op[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const timeSpan = op?.[1].match(/<span[^>]*class="[^"]*state[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  const timeText = decodeEntities(stripHtml(timeSpan?.[1] || '')).replace(/\s+/g, ' ').trim();
  return {
    id: attrOf(liTag, 'data-tid'),
    uin: attrOf(liTag, 'data-uin'),
    nickname,
    content,
    createdAt: timestampToIso(attrOf(liTag, 'data-abstime')) || qzoneTimeTextToIso(timeText),
  };
}

export function parseFeeds3Posts(text) {
  const html = unescapeFeeds3(text);
  const starts = [...html.matchAll(/name="feed_data"/g)].map((match) => match.index);
  const posts = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] : html.length;
    const block = html.slice(Math.max(0, start - 10), end);
    const tid = attrOf(block, 'data-tid');
    if (!tid) continue;
    const uin = attrOf(block, 'data-uin');
    const abstime = attrOf(block, 'data-abstime');
    const title = block.match(/<p[^>]*class="[^"]*txt-box-title[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    let contentHtml = title?.[1] || '';
    contentHtml = contentHtml.replace(/<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[\s\S]*?<\/a>/i, '');
    contentHtml = contentHtml.replace(/<span[^>]*class="[^"]*state[^"]*"[^>]*>[\s\S]*?<\/span>/i, '');
    const content = decodeEntities(stripHtml(contentHtml)).replace(/\s+/g, ' ').trim();

    const comments = [];
    let replyTotal = 0;
    const commentStarts = [...block.matchAll(/<li[^>]*data-type="commentroot"[^>]*>/gi)].map((match) => ({
      index: match.index,
      tag: match[0],
    }));
    for (let ci = 0; ci < commentStarts.length; ci += 1) {
      const commentBody = block.slice(
        commentStarts[ci].index,
        ci + 1 < commentStarts.length ? commentStarts[ci + 1].index : block.length,
      );
      const comment = parseFeeds3Comment(commentStarts[ci].tag, commentBody);
      comment.id =
        comment.id ||
        `${tid}-c${hashText(`${comment.uin}|${comment.content}|${comment.createdAt || ''}`).slice(0, 10)}`;
      comment.replies = [];
      const replyRe = /<li[^>]*data-type="replyroot"[^>]*>([\s\S]*?)<\/li>/gi;
      let replyMatch;
      while ((replyMatch = replyRe.exec(commentBody))) {
        const replyTag = replyMatch[0].slice(0, replyMatch[0].indexOf('>') + 1);
        const reply = parseFeeds3Comment(replyTag, replyMatch[1]);
        reply.id = `${comment.id}-${hashText(`${reply.uin}|${reply.content}|${reply.createdAt || ''}`).slice(0, 10)}`;
        comment.replies.push(reply);
      }
      replyTotal += comment.replies.length;
      comments.push(comment);
    }

    const likeMatch = block.match(/data-likenum="(\d+)"/i);
    posts.push({
      tid,
      content,
      createdAt: timestampToIso(abstime),
      likeCount: likeMatch ? Number(likeMatch[1]) : null,
      commentCount: comments.length + replyTotal,
      likes: [],
      comments,
    });
  }
  const byTid = new Map();
  for (const post of posts) {
    const existing = byTid.get(post.tid);
    if (!existing) {
      byTid.set(post.tid, post);
      continue;
    }
    if (post.content.length > existing.content.length) existing.content = post.content;
    if (post.comments.length > existing.comments.length) existing.comments = post.comments;
    existing.commentCount = existing.comments.reduce((sum, item) => sum + 1 + (item.replies?.length || 0), 0);
    if (post.likeCount != null && existing.likeCount == null) existing.likeCount = post.likeCount;
    if (post.createdAt && (!existing.createdAt || post.createdAt < existing.createdAt)) existing.createdAt = post.createdAt;
  }
  return [...byTid.values()];
}

async function fetchQzonePostsViaFeeds3({ num = 20 } = {}) {
  const stored = getQzoneCookie();
  if (!stored) throw new Error('还没有配置 QQ 空间 Cookie');
  const gtk = calcGtk(stored.pSkey || stored.skey);
  const params = new URLSearchParams({
    uin: stored.uin,
    scope: '1',
    view: '1',
    daylist: '',
    uinlist: stored.uin,
    gid: '',
    flag: '1',
    filter: 'all',
    applist: 'all',
    refresh: '1',
    aisortEndTime: '0',
    aisortOffset: '0',
    getAisort: '0',
    aisortBeginTime: '0',
    pagenum: '1',
    firstGetGroup: '0',
    icServerTime: '0',
    mixnocache: '0',
    scene: '0',
    begintime: '',
    dayspac: '30',
    sidomain: 'qzonestyle.gtimg.cn',
    useutf8: '1',
    outputhtmlfeed: '1',
    rd: String(Math.random()),
    usertime: String(Date.now()),
    windowId: String(Math.random()),
    g_tk: String(gtk),
    format: 'json',
    count: String(Math.min(50, Math.max(1, Number(num) || 20))),
  });
  const url = `${BASE}/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?${params}`;
  const res = await qfetch(url, {
    headers: {
      Cookie: stored.cookie,
      Referer: `${BASE}/${stored.uin}/main`,
      'User-Agent': UA,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`读取说说失败：HTTP ${res.status}`);
  const raw = await res.text();
  const posts = parseFeeds3Posts(raw);
  if (!posts.length) {
    if (/i\.qq\.com|请先登录|<title>[^<]*登录/i.test(raw)) {
      kvSet('qzone_cookie_bad', 'Cookie 失效：feeds3 跳到了登录页');
      throw new Error('QQ 空间 Cookie 可能失效或触发风控，请重新登录空间复制完整 Cookie');
    }
    const envelope = parseJsonp(raw);
    const data = envelope?.data;
    const explicitEmpty = [0, '0'].includes(envelope?.code ?? envelope?.ret) && (
      Array.isArray(envelope.msglist) && envelope.msglist.length === 0 ||
      Array.isArray(data) && data.length === 0 || data === '' ||
      data && typeof data === 'object' && Object.hasOwn(data, 'html') && data.html === ''
    );
    if (!explicitEmpty) {
      kvSet('qzone_cookie_bad', '空间返回未识别响应，保留上一次成功数据');
      throw new Error('QQ 空间响应无法识别，不能当作没有动态');
    }
    logger.info('feeds3 返回明确的空列表');
    kvSet('qzone_cookie_ok_at', nowIso());
    kvSet('qzone_cookie_bad', '');
  } else {
    logger.info('feeds3 读取说说成功', { count: posts.length });
    kvSet('qzone_cookie_ok_at', nowIso());
    kvSet('qzone_cookie_bad', '');
  }
  return { uin: stored.uin, posts, fetchedAt: nowIso() };
}

export async function refreshQzoneFeed({ num = 20 } = {}) {
  const data = await fetchQzonePosts({ num });
  kvSetJson('qzone_feed', data);
  return data;
}

export function getQzoneFeedCache() {
  return kvGetJson('qzone_feed', null);
}

async function mutationReceipt(res, { requireTid = false } = {}) {
  if (res.status >= 500) throw new DeliveryUnknownError(`QQ 空间返回 HTTP ${res.status}，发送结果未知`);
  if (!res.ok) throw new Error(`QQ 空间拒绝请求：HTTP ${res.status}`);
  let raw;
  try { raw = await res.text(); } catch (error) { throw new DeliveryUnknownError('QQ 空间回执中断，发送结果未知', error); }
  const data = parseJsonp(raw);
  const code = data?.code ?? data?.ret;
  if (code !== undefined && ![0, '0'].includes(code)) throw qzoneError(data);
  const tid = data?.t1_tid || data?.tid || data?.data?.tid;
  if (requireTid ? !tid : ![0, '0'].includes(code)) throw new DeliveryUnknownError('QQ 空间没有提供明确的发送回执，请先在平台核实');
  return { ok: true, ...(tid ? { tid: String(tid) } : {}) };
}

function reserveQzoneCount(kind) {
  const social = loadSettings().social;
  const now = new Date();
  const parts = shanghaiParts(now);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now);
  const limits = kind === 'comment'
    ? [[`qzone_reply_day:${day}`, social.qzoneAutoReplyMaxPerDay], [`qzone_reply_hour:${day}-${parts.hour}`, social.qzoneAutoReplyMaxPerHour]]
    : [[`qzone_publish_day:${day}`, social.dailyPostMax]];
  for (const [key, max] of limits) if (Number(kvGet(key, '0')) >= Number(max)) throw new Error('QQ 空间本时段发送次数已达上限');
  for (const [key] of limits) kvSet(key, String(Number(kvGet(key, '0')) + 1));
  return () => { for (const [key] of limits) kvSet(key, String(Math.max(0, Number(kvGet(key, '0')) - 1))); };
}

export async function sendQzoneComment({ tid, content, commentId = '', replyUin = '', postUin = '' } = {}) {
  const stored = getQzoneCookie();
  if (!stored) throw new Error('还没有配置 QQ 空间 Cookie');
  assertCookieIdentity(stored);
  const text = String(content || '').trim();
  if (!tid) throw new Error('缺少说说 tid');
  if (!text) throw new Error('回复内容不能为空');
  if (text.length > 500) throw new Error('回复太长了，压到 500 字以内');
  const gate = assertPublicContent(text, { settings: loadSettings(), hisMessages: recentUserMessages(60) });
  if (!gate.ok) {
    addEvent('qzone_reply_blocked', '这条空间回复不能公开写', { reason: gate.reason, tid });
    throw new Error(`这条不能公开写：${gate.reason}`);
  }
  const author = String(postUin || stored.uin);
  const key = `effect:qzone:comment:${stored.uin}:${hashText(`${author}|${tid}|${commentId || text}|${replyUin}`)}`;
  const operation = beginEffect(key);
  if (!operation.started) return { ...operation.receipt, already: true };
  let release;
  let delivered = false;
  try {
    release = reserveQzoneCount('comment');
    const body = new URLSearchParams({ hostUin: author, topicId: `${author}_${tid}`, content: text, format: 'json', qzreferrer: `https://user.qzone.qq.com/${stored.uin}/main` });
    if (commentId && replyUin) { body.set('commentId', String(commentId)); body.set('replyUin', String(replyUin)); body.set('commentUin', String(replyUin)); }
    const res = await qfetch(`${BASE}/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${calcGtk(stored.pSkey || stored.skey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: stored.cookie, Referer: `https://user.qzone.qq.com/${stored.uin}/main`, Origin: 'https://user.qzone.qq.com', 'User-Agent': UA },
      body: body.toString(), signal: AbortSignal.timeout(30000),
    });
    const receipt = await mutationReceipt(res);
    delivered = true;
    finishEffect(key, receipt);
    logger.info('QQ 空间评论回复成功', { tid, commentId: commentId || null });
    return receipt;
  } catch (original) {
    const error = delivered ? new DeliveryUnknownError('平台已接收评论，但本地状态没保存，请核实', original) : original;
    if (error.code !== 'DELIVERY_UNKNOWN') release?.();
    failEffect(key, error);
    throw error;
  }
}

export async function publishQzone({ content }) {
  const stored = getQzoneCookie();
  if (!stored) throw new Error('还没有配置 QQ 空间 Cookie');
  assertCookieIdentity(stored);
  const text = String(content || '').trim();
  if (!text) throw new Error('说说内容不能为空');
  if (text.length > 1500) throw new Error('说说太长了，截到 1500 字以内吧');
  const gate = assertPublicContent(text, { settings: loadSettings(), hisMessages: recentUserMessages(60) });
  if (!gate.ok) throw new Error(`这条不能公开写：${gate.reason}`);
  const release = reserveQzoneCount('publish');
  try {
    const res = await qfetch(`${BASE}/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${calcGtk(stored.pSkey || stored.skey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: stored.cookie, Referer: `https://user.qzone.qq.com/${stored.uin}/main`, Origin: 'https://user.qzone.qq.com', 'User-Agent': UA },
      body: buildPublishForm({ content: text, uin: stored.uin }).toString(), signal: AbortSignal.timeout(30000),
    });
    const receipt = await mutationReceipt(res, { requireTid: true });
    logger.info('QQ 空间说说发布成功', { tid: receipt.tid });
    return receipt;
  } catch (error) {
    if (error.code !== 'DELIVERY_UNKNOWN') release();
    throw error;
  }
}
