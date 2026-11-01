import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertCsrf, readJsonBody as readRequestBody } from './http-security.js';
import { startNapCat, stopOwned } from './processes.js';
import {
  appInfo,
  env,
  getPersona,
  loadSettings,
  maskKey,
  paths,
  savePersona,
  saveSettings,
} from './config.js';
import {
  addEvent,
  addMemory,
  closeDb,
  countMemories,
  countMessages,
  countPendingPosts,
  costSummary,
  deleteMemory,
  reviseMemory,
  deletePost,
  getActiveSession,
  getMessage,
  getMessagePage,
  getSession,
  listSessions,
  getMessagesForPrompt,
  getPost,
  kvGet,
  kvGetJson,
  kvSet,
  kvSetJson,
  lastAssistantContextTokens,
  lastUserMessageAt,
  listEvents,
  listMemories,
  listMoods,
  listPosts,
  maintenance,
} from './db.js';
import { logger } from './logger.js';
import { DeepSeek } from './llm.js';
import { Companion } from './chat.js';
import { Scheduler } from './scheduler.js';
import { OneBotChannel } from './channels/onebot.js';
import {
  clearQzoneCookie,
  qzoneCookieHealth,
  getQzoneFeedCache,
  qzoneStatus,
  refreshQzoneFeed,
  saveQzoneCookie,
  sendQzoneComment,
  verifyQzoneCookie,
} from './channels/qzone.js';
import { clearLearnedImages } from './learned-images.js';
import {
  adoptStickerImage,
  findAndAdoptStickers,
  listMemeTemplates,
  stickerLibraryStatus,
} from './sticker-search.js';
import { completeIntention, listIntentions } from './intentions.js';
import { costBlocked, readCostState } from './budget.js';
import { privacyProblems } from './privacy.js';
import { synthesizeSpeech, ttsStatus, ttsVoices } from './tts.js';
import { asrStatus } from './asr.js';
import { checkSpeakSlot, consumeCameraSlot, hearWav, noteSpeakUsed, presenceBudget, speakLine } from './presence.js';
import { brainStats, curveForMemory, noteBrainLink } from './brain.js';
import { applyNeuroEvent, neuroStatus } from './neuro.js';
import { addSense, clearSenses, sensesStatus } from './senses.js';
import {
  closeXhsBrowser,
  fetchXhsCreatorStats,
  xhsLogout,
  fetchXhsFeed,
  fillXhsNote,
  getXhsLoginQr,
  leaveXhsPublishEditor,
  listXhsImages,
  loginXhsWithSms,
  openXhsLogin,
  publishFilledXhsNote,
  readCachedXhsDms,
  readXhsDirectMessages,
  requestXhsSmsCode,
  sendXhsDirectMessage,
  stashXhsDraft,
  verifyXhsLogin,
  withXhsBrowser,
  xhsBrowserBusy,
  xhsBrowserStatus,
} from './channels/xhs.js';
import {
  canSendXhsDm,
  discoverSelfProfile,
  getRecentXhsActivity,
  isRiskyError,
  noteXhsDmSent,
  triggerXhsCooldown,
  xhsCooldownUntil,
  listSelfNotesForReport,
  recordXhsActivity,
  xhsBudgetStatus,
  xhsDmStatus,
} from './channels/xhs-actions.js';
import { buildXhsDmReplyPrompt, buildXhsProfilePrompt, buildXhsWeeklyPrompt } from './prompt.js';
import { parseJsonLoose, safeEqual, shanghaiDayKey } from './util.js';
export async function importQzoneCookieFromNapCat() {
  let result = await onebot.sendAction('get_cookies', { domain: 'qzone.qq.com' });
  let cookies = result?.data?.cookies || result?.data?.cookie || result?.data?.data?.cookies || '';
  if (!cookies) {
    result = await onebot.sendAction('get_credentials', { domain: 'qzone.qq.com' });
    cookies = result?.data?.cookies || result?.data?.cookie || result?.data?.data?.cookies || '';
  }
  if (Array.isArray(cookies)) cookies = cookies.join('; ');
  if (!cookies || typeof cookies !== 'string') throw new Error('NapCat 没返回 Cookie（小号 QQ 可能不在线）');
  const status = saveQzoneCookie(cookies);
  addEvent('qzone_cookie', '从 NapCat 导入了空间 Cookie（不用手抄了）', { uin: status.uin });
  kvSet('qzone_cookie_bad', '');
  return status;
}

function healthAlerts() {
  const out = [];
  const cost = readCostState();
  if (cost && cost.level === 'stop') out.push({ key: 'cost', level: 'danger', text: (cost.reasons || []).join('；') || '余额到线，已停掉主动动作' });
  else if (cost && cost.level === 'low') out.push({ key: 'cost', level: 'warn', text: (cost.reasons || []).join('；') });
  const qz = qzoneCookieHealth();
  if (!qz.configured) out.push({ key: 'qzone', level: 'info', text: '还没配 QQ 空间 Cookie：设置页点「从 NapCat 导入」就行，不用手抄' });
  else if (kvGet('qzone_cookie_bad')) out.push({ key: 'qzone', level: 'warn', text: `空间 Cookie 用不了（${kvGet('qzone_cookie_bad')}）：自动重取也没成，需要用小号在电脑上登录一次空间` });
  else if (qz.stale) out.push({ key: 'qzone', level: 'info', text: `空间 Cookie 已 ${qz.ageHours ?? '?'} 小时没成功请求过（每次请求都会自动续，正常不会过期）` });
  const qq = onebot?.status?.() || null;
  if (qq && qq.connected && qq.identityOk === false) {
    out.push({ key: 'qq-identity', level: 'danger', text: `QQ 连着，但登录号不对：${qq.identityError}。所有发送已被拦下，先换回机器人小号。` });
  }
  // 刚起来的几十秒里 NapCat 正在回连，这时报"QQ 断了 0 分钟"是假警报（顶栏还写着在线，自相矛盾）。
  if (qq && loadSettings().qq.enabled && !qq.connected && Number(qq.downMinutes) >= 1) {
    out.push({ key: 'qq', level: 'danger', text: qq.autoRecover ? `QQ 断了 ${qq.downMinutes} 分钟，她在自己试着恢复；不行就要重新扫码` : 'QQ 通道断了，而且自愈是关的' });
  }
  try {
    const settings = loadSettings();
    const legacy = listPosts({ status: 'posted', limit: 50 }).find(
      (post) => post.kind === 'qzone' && post.posted_at && post.posted_at < '2026-10-29T15:00:00.000Z' && privacyProblems(post.content, settings).length,
    );
    if (legacy) {
      out.push({
        key: 'legacy-post',
        level: 'warn',
        postId: legacy.id,
        text: `有一条 ${String(legacy.posted_at).slice(0, 10)} 的旧说说可能带私密内容，请在 QQ 空间手动删掉；删完点这里的「我已删掉」（动态里能看到原文）`,
      });
    }
  } catch {
    // 读旧说说失败不影响状态接口
  }
  const cooldown = kvGet('xhs_cooldown_until');
  if (cooldown && new Date(cooldown).getTime() > Date.now()) out.push({ key: 'xhs', level: 'warn', text: `小红书风控冷却中，到 ${cooldown.slice(11, 16)} 才继续` });
  return out;
}

function balanceText() {
  const cached = balanceCache.value?.total;
  return cached == null ? '余额没读到' : `${Number(cached).toFixed(2)} CNY`;
}
function shanghaiDay() {
  return shanghaiDayKey();
}
import { writeXhsWeekly } from './weekly-report.js';
import {
  compactIfNeeded,
  getMemoryOverview,
  handoverIfNeeded,
  listDailyDigests,
  listLetters,
  readLetter,
} from './memory.js';
import { getMood } from './mood.js';
import { buildQzoneCommentReplyPrompt } from './prompt.js';
import {
  approvePost,
  generateComments,
  generatePost,
  listAllPosts,
  markPosted,
  removePost,
  tryAutoPublish,
  PLATFORM_LABELS,
} from './social.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const llm = new DeepSeek();
const companion = new Companion({ llm });
let scheduler = null;
let onebot = null;
let server = null;
const chatRate = [];
let balanceCache = { at: 0, value: null };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // 只放开「本控制台自己」用摄像头和麦克风；第三方帧和定位一律不给。
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function errorMessage(error) {
  let message = error?.message || String(error);
  for (const [from, to] of [
    [paths.root, '<项目目录>'],
    [paths.data, '<数据目录>'],
  ]) {
    message = message.split(from).join(to);
  }
  return logger.redact(message);
}

function requestHasBody(req) {
  return Number(req.headers['content-length'] || 0) > 0 || Boolean(req.headers['transfer-encoding']);
}

function isLocalHostname(hostname) {
  const name = String(hostname || '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (!isLocalHostname(url.hostname)) return false;
    return url.port === String(env.port) || (!url.port && String(env.port) === '80');
  } catch {
    return false;
  }
}

const SESSION_COOKIE = 'bz_session';
const SESSION_KEY = 'console_sessions';
const SESSION_TTL_MS = 30 * 86400000;

function readCookie(req, name) {
  const match = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  try { return match ? decodeURIComponent(match[1]) : ''; } catch { return ''; }
}

function passwordTag() {
  return crypto.createHash('sha256').update(env.consolePassword).digest('base64url').slice(0, 16);
}

function readSessions() {
  const stored = kvGetJson(SESSION_KEY, {});
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const now = Date.now();
  const clean = {};
  for (const [id, value] of Object.entries(stored)) {
    if (value && Number(value.exp) > now && value.tag === passwordTag()) clean[id] = value;
  }
  return clean;
}

function saveSessions(sessions) {
  const entries = Object.entries(sessions)
    .sort((a, b) => Number(b[1].exp) - Number(a[1].exp))
    .slice(0, 20);
  kvSetJson(SESSION_KEY, Object.fromEntries(entries));
}

function issueSession() {
  const id = crypto.randomBytes(32).toString('base64url');
  const sessions = readSessions();
  sessions[id] = { exp: Date.now() + SESSION_TTL_MS, tag: passwordTag(), at: Date.now() };
  saveSessions(sessions);
  return id;
}

function validSession(req) {
  if (!env.consolePassword) return false;
  const id = readCookie(req, SESSION_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return false;
  return Object.hasOwn(readSessions(), id);
}

function revokeSession(req) {
  const id = readCookie(req, SESSION_COOKIE);
  if (!id) return;
  const sessions = kvGetJson(SESSION_KEY, {});
  if (sessions && typeof sessions === 'object' && sessions[id]) {
    delete sessions[id];
    kvSetJson(SESSION_KEY, sessions);
  }
}

function sessionCookie(req, value, maxAgeSeconds) {
  const secure = req.socket?.encrypted || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function assertLocalRequest(req, url) {
  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '');
  const local = Boolean(host) && isLocalHostname(hostname);
  const isHealth = url?.pathname === '/api/health';
  if (!env.consolePassword) {
    if (!local) {
      throw new HttpError(403, '只允许通过本机地址访问控制台（外网访问请在 .env 里设 CONSOLE_PASSWORD）');
    }
    if (local && !isAllowedOrigin(req.headers.origin)) throw new HttpError(403, '拒绝跨站请求');
  } else if (!isHealth && !validSession(req)) {
    const error = new HttpError(401, '需要登录控制台');
    error.login = true;
    throw error;
  }
  if (req.method && !['GET', 'HEAD'].includes(req.method) && requestHasBody(req)) {
    const type = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(type)) {
      throw new HttpError(415, '请求体必须是 application/json');
    }
  }
}

const loginFailures = new Map();
function loginGate(req) {
  const key = String(req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  for (const [ip, failure] of loginFailures) if (now - failure.firstAt > 20 * 60000 && failure.blockedUntil <= now) loginFailures.delete(ip);
  if (loginFailures.size >= 512 && !loginFailures.has(key)) loginFailures.delete(loginFailures.keys().next().value);
  const record = loginFailures.get(key) || { count: 0, firstAt: now, blockedUntil: 0 };
  if (record.blockedUntil > now) return { ok: false, key, retryAfter: Math.ceil((record.blockedUntil - now) / 1000) };
  if (now - record.firstAt > 10 * 60000) {
    record.count = 0;
    record.firstAt = now;
    record.blockedUntil = 0;
  }
  return { ok: true, key, record };
}

function noteLoginFailure(key, record) {
  record.count += 1;
  if (record.count >= 5) record.blockedUntil = Date.now() + 10 * 60000;
  loginFailures.set(key, record);
}

async function handleLogin(req, res) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    return sendJson(res, 415, { error: '登录请求必须是 JSON' });
  }
  const gate = loginGate(req);
  if (!gate.ok) return sendJson(res, 429, { error: `密码试太多次了，${gate.retryAfter} 秒后再试` });
  if (!env.consolePassword) {
    return sendJson(res, 400, { error: '还没有设置控制台密码：在 .env 里写 CONSOLE_PASSWORD（也可以沿用 CONSOLE_TOKEN）' });
  }
  const body = await readJsonBody(req);
  const password = String(body.password || '');
  if (!password || !safeEqual(password, env.consolePassword)) {
    noteLoginFailure(gate.key, gate.record);
    const last = Number(kvGet('console_login_fail_at', '0') || 0);
    if (Date.now() - last > 10 * 60000) {
      kvSet('console_login_fail_at', String(Date.now()));
      addEvent('console_login_failed', '有人试了控制台密码，没对', {});
      logger.warn('控制台登录失败', { remote: String(req.socket?.remoteAddress || '').slice(0, 48) });
    }
    return sendJson(res, 401, { error: '密码不对' });
  }
  loginFailures.delete(gate.key);
  res.setHeader('Set-Cookie', [
    sessionCookie(req, issueSession(), Math.floor(SESSION_TTL_MS / 1000)),
    'bz_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
  ]);
  addEvent('console_login', '控制台登录成功', {});
  return sendJson(res, 200, { ok: true });
}

function handleLogout(req, res) {
  revokeSession(req);
  res.setHeader('Set-Cookie', [
    sessionCookie(req, '', 0),
    'bz_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
  ]);
  return sendJson(res, 200, { ok: true });
}

const actionLocks = new Set();
const EXPENSIVE_API = new Set([
  '/api/chat',
  '/api/posts/generate',
  '/api/social/comments',
  '/api/actions/proactive',
  '/api/actions/weekly',
  '/api/actions/daily',
  '/api/actions/dream',
  '/api/actions/compact',
  '/api/actions/handover',
  '/api/qzone/comments/draft',
  '/api/qzone/comments/reply',
  '/api/qzone/auto-reply/run',
  '/api/xhs/note/preview',
  '/api/stickers/find',
  '/api/stickers/memes',
  '/api/voice/preview',
  '/api/voice/echo',
  '/api/qq/test-voice',
  '/api/qq/token/reveal',
  '/api/qq/stop',
  '/api/xhs/logout',
  '/api/xhs/phone/code',
  '/api/xhs/phone/login',
  '/api/xhs/login',
  '/api/xhs/verify',
  '/api/xhs/close',
  '/api/xhs/run/browse',
  '/api/xhs/run/reply',
  '/api/xhs/run/all',
  '/api/qq/qr/restart',
  '/api/xhs/note/publish',
  '/api/xhs/dm/read',
  '/api/xhs/dm/draft',
  '/api/xhs/dm/send',
  '/api/xhs/report',
  '/api/xhs/profile/draft',
  '/api/qzone/import-napcat',
  '/api/presence/hear',
  '/api/presence/look',
  '/api/presence/speak',
]);

// 只锁"人点一下才跑"的只读重接口；/api/xhs/status 和 /api/xhs/qr 是前端定时轮询的，
// 上锁会让正常的轮询互相撞成 409 —— 它们已经由 withXhsBrowser 排队，不需要再加锁。
const EXPENSIVE_GET = new Set([
  '/api/xhs/feed',
  '/api/xhs/profile',
  '/api/qzone/feed',
  '/api/qzone/verify',
  '/api/balance',
]);

const actionRate = [];
function consumeActionRate() {
  const now = Date.now();
  while (actionRate.length && now - actionRate[0] > 60000) actionRate.shift();
  if (actionRate.length >= 20) throw new HttpError(429, '一分钟内操作太多了，歇一下下。');
  actionRate.push(now);
}

async function withActionLock(key, fn) {
  if (actionLocks.has(key)) throw new HttpError(409, '这个操作正在处理中，等它完成再试');
  actionLocks.add(key);
  try {
    return await fn();
  } finally {
    actionLocks.delete(key);
  }
}

async function readJsonBody(req, limit = 256 * 1024) {
  return readRequestBody(req, limit);
}

function serveStatic(res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': filePath.startsWith(paths.media + path.sep) ? 'no-store' : ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}

function safeJoin(base, relative) {
  const full = path.resolve(base, '.' + path.sep + relative.replace(/^\/+/, ''));
  if (!full.startsWith(path.resolve(base) + path.sep) && full !== path.resolve(base)) return null;
  if (fs.existsSync(full)) {
    try {
      const rel = path.relative(fs.realpathSync(base), fs.realpathSync(full));
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
    } catch { return null; }
  }
  return full;
}

function activeSessionInfo() {
  const session = getActiveSession();
  return {
    ...session,
    messageCount: countMessages(session.id),
    contextTokens: lastAssistantContextTokens(session.id),
  };
}

function maskQq(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 6) return '***';
  return `${s.slice(0, 3)}****${s.slice(-3)}`;
}

async function handleApi(req, res, pathname, url) {
  const method = req.method || 'GET';

  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, version: appInfo.version });

  if (pathname === '/api/status' && method === 'GET') {
    return sendJson(res, 200, {
      app: appInfo,
      companion: loadSettings().companion,
      model: loadSettings().model.name,
      keyConfigured: llm.configured,
      keyMasked: maskKey(),
      mock: env.mock,
      session: activeSessionInfo(),
      mood: getMood(),
      memoryCounts: countMemories(),
      intentions: listIntentions({ limit: 6 }),
      pendingPosts: countPendingPosts(),
      costs: costSummary(7),
      scheduler: scheduler?.status() || null,
      qq: onebot?.status() || null,
      llmLastError: llm.lastError,
      lastUserMessageAt: lastUserMessageAt(),
      health: healthAlerts(),
      runtime: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()), memory: process.memoryUsage() },
      cost: readCostState(),
    });
  }

  if (pathname === '/api/messages' && method === 'GET') {
    const limit = Math.min(200, Math.max(10, Number(url.searchParams.get('limit')) || 80));
    const requestedSession = url.searchParams.get('sessionId');
    const session = requestedSession ? getSession(requestedSession) : getActiveSession();
    if (!session) return sendJson(res, 404, { error: '会话不存在' });
    const page = getMessagePage(session.id, { limit, before: url.searchParams.get('before') });
    const messages = page.messages;
    const summary = kvGet(`session_summary:${session.id}`) || '';
    return sendJson(res, 200, { session, messages, summary, hasMore: page.hasMore });
  }

  if (pathname === '/api/sessions' && method === 'GET') {
    return sendJson(res, 200, { sessions: listSessions(200).map(({id,title,status,created_at})=>({id,title,status,created_at})) });
  }

  const singleMessage = pathname.match(/^\/api\/messages\/(\d+)$/);
  if (singleMessage && method === 'GET') {
    const message = getMessage(Number(singleMessage[1]));
    if (!message) return sendJson(res, 404, { error: '消息不存在' });
    return sendJson(res, 200, { message });
  }

  if (pathname === '/api/chat' && method === 'POST') {
    const now = Date.now();
    while (chatRate.length && now - chatRate[0] > 60000) chatRate.shift();
    if (chatRate.length >= 30) return sendJson(res, 429, { error: '一分钟内说得太多啦，歇一下下。' });
    chatRate.push(now);

    let body;
    try {
      body = await readJsonBody(req, 32 * 1024 * 1024);
    } catch (error) {
      return sendJson(res, Number(error.status) || 400, { error: errorMessage(error) });
    }
    const text = String(body.text || '');
    const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
    if (!text.trim() && !images.length) return sendJson(res, 400, { error: '消息不能为空' });
    if (text.length > 20000) return sendJson(res, 400, { error: '消息太长了，截断到 2 万字以内吧。' });

    const wantsStream = String(req.headers.accept || '').includes('text/event-stream');
    if (!wantsStream) {
      try {
        const result = await companion.reply({ text, images, channel: 'web' });
        return sendJson(res, 200, {
          ok: true,
          message: result.message,
          text: result.text,
          costCny: result.costCny,
          mood: getMood(),
        });
      } catch (error) {
        logger.error('聊天失败', { error: error.message });
        return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (obj) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) clientGone = true;
    });

    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    send({ type: 'start', sessionId: getActiveSession().id });
    try {
      const gen = companion.streamReply({ text, images, channel: 'web', signal: controller.signal });
      for await (const event of gen) {
        if (clientGone) {
          await gen.return();
          break;
        }
        send(event);
      }
      send({ type: 'end' });
    } catch (error) {
      logger.error('流式聊天失败', { error: error.message });
      send({ type: 'error', message: error.message });
    } finally {
      res.removeListener('close', cancel);
      controller.abort();
      if (!res.writableEnded) res.end();
    }
    return undefined;
  }

  if (pathname === '/api/memories' && method === 'GET') {
    const layer = url.searchParams.get('layer') || null;
    const q = (url.searchParams.get('q') || '').trim();
    let memories = listMemories({ layer, limit: 300 });
    if (q) {
      const lower = q.toLowerCase();
      memories = memories.filter(
        (m) => m.content.toLowerCase().includes(lower) || (m.tags || []).some((t) => t.includes(q)),
      );
    }
    return sendJson(res, 200, { memories });
  }

  if (pathname === '/api/memories' && method === 'POST') {
    const body = await readJsonBody(req);
    const layer = ['core', 'mid', 'long'].includes(body.layer) ? body.layer : 'core';
    const content = String(body.content || '').trim();
    if (!content) return sendJson(res, 400, { error: '记忆内容不能为空' });
    const memory = addMemory({
      layer,
      content: content.slice(0, 500),
      importance: Math.min(5, Math.max(1, Number(body.importance) || 5)),
      tags: Array.isArray(body.tags) ? body.tags : ['手动'],
      reasoning: '由你在控制台手动添加',
    });
    addEvent('memory_added', '你手动添加了一条记忆', { id: memory?.id, layer });
    return sendJson(res, 200, { ok: true, memory });
  }

  const memoryDelete = pathname.match(/^\/api\/memories\/(\d+)$/);
  if (memoryDelete && method === 'PUT') {
    const body = await readJsonBody(req);
    const memory = reviseMemory(Number(memoryDelete[1]), body.content, body.expectedUpdatedAt);
    addEvent('memory_revised', '你更正了一条记忆', { id: memory.id });
    return sendJson(res, 200, { memory });
  }
  if (memoryDelete && method === 'DELETE') {
    deleteMemory(Number(memoryDelete[1]));
    addEvent('memory_deleted', '你删除了一条记忆', { id: Number(memoryDelete[1]) });
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/memory/overview' && method === 'GET') {
    return sendJson(res, 200, getMemoryOverview({ query: url.searchParams.get('q') || '' }));
  }

  if (pathname === '/api/letters' && method === 'GET') {
    return sendJson(res, 200, { letters: listLetters() });
  }

  const letterMatch = pathname.match(/^\/api\/letters\/(.+)$/);
  if (letterMatch && method === 'GET') {
    try {
      const content = readLetter(decodeURIComponent(letterMatch[1]));
      return sendJson(res, 200, { name: decodeURIComponent(letterMatch[1]), content });
    } catch (error) {
      return sendJson(res, 404, { error: error.message });
    }
  }

  if (pathname === '/api/posts' && method === 'GET') {
    return sendJson(res, 200, { posts: listAllPosts(80), labels: PLATFORM_LABELS });
  }

  if (pathname.startsWith('/api/posts/') && method === 'DELETE') {
    const id = Number(pathname.split('/').pop());
    const post = Number.isFinite(id) ? getPost(id) : null;
    if (!post) return sendJson(res, 404, { error: '没有这条动态记录' });
    deletePost(id);
    addEvent('post_deleted', '从控制台的动态记录里删掉了一条（如果已经发到平台，平台上的内容仍要在平台里删）', {
      postId: id,
      status: post.status,
    });
    return sendJson(res, 200, { ok: true, deleted: id });
  }

  if (pathname === '/api/posts/generate' && method === 'POST') {
    const body = await readJsonBody(req);
    const kind = PLATFORM_LABELS[body.kind] ? body.kind : 'qzone';
    try {
      const post = await generatePost({ llm, kind });
      return sendJson(res, 200, { ok: true, post });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  const postAction = pathname.match(/^\/api\/posts\/(\d+)\/(approve|posted|publish)$/);
  if (postAction && method === 'POST') {
    const id = Number(postAction[1]);
    const action = postAction[2];
    try {
      if (action === 'approve') return sendJson(res, 200, { ok: true, post: approvePost(id) });
      if (action === 'posted') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { ok: true, post: markPosted(id, { url: body.url || '', note: body.note || '手动发布' }) });
      }
      const post = getPost(id);
      if (!post) return sendJson(res, 404, { error: '动态不存在' });
      const result = await tryAutoPublish(post, { requireApproved: true });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  const postMatch = pathname.match(/^\/api\/posts\/(\d+)$/);
  if (postMatch && method === 'DELETE') {
    removePost(Number(postMatch[1]));
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/social/comments' && method === 'POST') {
    const body = await readJsonBody(req);
    const context = String(body.context || '').trim();
    if (!context) return sendJson(res, 400, { error: '先把视频/笔记的内容贴进来' });
    try {
      const comments = await generateComments({ llm, context, platform: body.platform || 'douyin' });
      return sendJson(res, 200, { ok: true, comments });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/settings' && method === 'GET') {
    const settings = loadSettings();
    return sendJson(res, 200, {
      settings,
      revision: crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
      persona: getPersona(),
      meta: {
        keyMasked: maskKey(),
        keyConfigured: llm.configured,
        mock: env.mock,
        dataDir: paths.data,
        version: appInfo.version,
        wsUrl: `ws://127.0.0.1:${env.port}/onebot`,
      },
    });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readJsonBody(req);
    try {
      const before = loadSettings();
      const revision = crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex');
      if (req.headers['if-match'] && req.headers['if-match'] !== revision) return sendJson(res, 409, { error: '设置已被其他页面或后台更新，草稿已保留，请重新载入后合并修改。' });
      const settings = saveSettings(body);
      writeBotAccountFile(settings.qq?.botAccount);
      if (before.proactive.enabled !== settings.proactive.enabled) {
        if (!settings.proactive.enabled) {
          kvSet('next_proactive_at', new Date(Date.now() + 86400000).toISOString());
        } else {
          scheduler?.scheduleProactive();
        }
      }
      if (before.social.enabled !== settings.social.enabled) {
        if (!settings.social.enabled) {
          kvSet('next_post_at', new Date(Date.now() + 86400000).toISOString());
        } else {
          scheduler?.schedulePost();
        }
      }
      if (before.qq.botAccount !== settings.qq.botAccount || before.qq.enabled !== settings.qq.enabled && !settings.qq.enabled) {
        onebot?.disconnectAll();
      }
      if (JSON.stringify(before.proactive) !== JSON.stringify(settings.proactive)) {
        kvSetJson('proactive_plan', null);
        scheduler?.scheduleProactive();
      }
      if (JSON.stringify(before.social) !== JSON.stringify(settings.social)) {
        kvSet(`xhs_publish_target:${shanghaiDay()}`, '');
        scheduler?.schedulePost();
      }
      addEvent('settings_saved', '设置已更新');
      return sendJson(res, 200, { ok: true, settings, revision: crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex') });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/persona' && method === 'PUT') {
    const body = await readJsonBody(req);
    try {
      const persona = savePersona(body.persona);
      addEvent('persona_saved', '人设已更新');
      return sendJson(res, 200, { ok: true, persona });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/balance' && method === 'GET') {
    if (balanceCache.value && Date.now() - balanceCache.at < 60000) return sendJson(res, 200, balanceCache.value);
    try {
      const balance = await llm.balance();
      balanceCache = { at: Date.now(), value: balance };
      return sendJson(res, 200, balance);
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/costs' && method === 'GET') {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
    return sendJson(res, 200, costSummary(days));
  }

  if (pathname === '/api/moods' && method === 'GET') {
    return sendJson(res, 200, { moods: listMoods(30) });
  }

  if (pathname === '/api/events' && method === 'GET') {
    return sendJson(res, 200, { events: listEvents(60) });
  }

  if (pathname === '/api/actions/proactive' && method === 'POST') {
    try {
      const result = await scheduler.manual(() => scheduler.triggerProactive({ reason: 'manual' }));
      if (!result) return sendJson(res, 200, { ok: false, reason: '当前主动开关、次数或预算不允许发送，未生成新消息' });
      return sendJson(res, 200, { ok: true, message: result.message, sent: result.sent });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/actions/weekly' && method === 'POST') {
    try {
      const result = await scheduler.manual(() => scheduler.triggerWeekly({ force: true }));
      if (!result) return sendJson(res, 200, { ok: false, reason: '最近 7 天的对话还不够，先说几句再来写吧。' });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/actions/daily' && method === 'POST') {
    try {
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
      if (listDailyDigests().some((item) => item.date === today)) {
        return sendJson(res, 200, { ok: false, reason: '今天的日记已经写过了，去「记忆 → 信」里看。' });
      }
      const result = await scheduler.manual(() => scheduler.triggerDaily({ force: false }));
      if (!result) return sendJson(res, 200, { ok: false, reason: '今天至少要有 4 条消息才会写日记。' });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/actions/compact' && method === 'POST') {
    try {
      const settings = loadSettings();
      const session = getActiveSession();
      const result = await scheduler.manual(() =>
        compactIfNeeded({ llm, sessionId: session.id, settings, force: true }),
      );
      if (!result) return sendJson(res, 200, { ok: false, reason: '当前没有足够多的旧消息可以压缩。' });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/actions/handover' && method === 'POST') {
    try {
      const settings = loadSettings();
      const session = getActiveSession();
      const result = await scheduler.manual(() =>
        handoverIfNeeded({ llm, sessionId: session.id, settings, force: true }),
      );
      if (!result) return sendJson(res, 200, { ok: false, reason: '当前会话还没有内容可以交接。' });
      return sendJson(res, 200, { ok: true, letter: result.letter, name: result.name, nextSession: result.nextSession });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/actions/reset-schedule' && method === 'POST') {
    scheduler.scheduleProactive();
    scheduler.schedulePost();
    return sendJson(res, 200, { ok: true, scheduler: scheduler.status() });
  }

  if (pathname === '/api/qzone/status' && method === 'GET') {
    return sendJson(res, 200, qzoneStatus());
  }

  if (pathname === '/api/xhs/status' && method === 'GET') {
    try {
      const status = xhsBrowserBusy() && url.searchParams.get('verify') !== '1'
        ? { loggedIn: kvGet('xhs_logged_in') === '1', browserRunning: true, busy: true, selfName: kvGet('xhs_self_name'), selfUserId: kvGet('xhs_self_user_id'), lastError: scheduler?.lastXhsError }
        : await withXhsBrowser(() => xhsBrowserStatus({ verify: url.searchParams.get('verify') === '1' }));
      status.ownerBinding = kvGetJson('xhs_owner_binding', null);
      status.notificationBadge = Number(kvGet('xhs_notification_badge', '0') || 0);
      status.notificationCheckedAt = kvGet('xhs_notification_checked_at') || null;
      const dms = readCachedXhsDms();
      status.directMessages = dms;
      status.dmsAt = kvGet('xhs_dms_at') || null;
      status.dmStatus = xhsDmStatus(dms.map((x) => x.name));
      try {
        status.ownerProfile = JSON.parse(kvGet('xhs_owner_profile', 'null'));
      } catch {
        status.ownerProfile = null;
      }
      try {
        status.followGraph = JSON.parse(kvGet('xhs_follow_graph', 'null'));
      } catch {
        status.followGraph = null;
      }
      return sendJson(res, 200, status);
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/login' && method === 'POST') {
    try {
      return sendJson(res, 200, await withXhsBrowser(openXhsLogin));
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/phone/code' && method === 'POST') {
    const body = await readJsonBody(req, 64 * 1024);
    try {
      return sendJson(res, 200, await withXhsBrowser(() => requestXhsSmsCode(body.phone)));
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/phone/login' && method === 'POST') {
    const body = await readJsonBody(req, 64 * 1024);
    try {
      return sendJson(res, 200, await withXhsBrowser(() => loginXhsWithSms(body.phone, body.code)));
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/verify' && method === 'POST') {
    try {
      return sendJson(res, 200, await withXhsBrowser(verifyXhsLogin));
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/logout' && method === 'POST') {
    try {
      return sendJson(res, 200, await xhsLogout());
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/close' && method === 'POST') {
    try {
      return sendJson(res, 200, await closeXhsBrowser());
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/feed' && method === 'GET') {
    try {
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 8));
      const keyword = String(url.searchParams.get('keyword') || '').trim();
      return sendJson(res, 200, { ok: true, notes: await withXhsBrowser(() => fetchXhsFeed({ limit, keyword })) });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/dm/bind-owner' && method === 'POST') {
    const body = await readJsonBody(req);
    if (body.confirm !== true) throw new HttpError(400, '请明确确认这是你的私信会话');
    const item = readCachedXhsDms().find((entry) => entry.convId === body.convId && entry.name === body.target);
    const selfId = kvGet('xhs_self_user_id');
    if (!item || !selfId) throw new HttpError(409, '请先读取当前账号资料与私信列表，再确认绑定');
    kvSetJson('xhs_owner_binding', { selfId, convId: item.convId, name: item.name, at: new Date().toISOString() });
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/xhs/dm/read' && method === 'POST') {
    try {
      const result = await withXhsBrowser(() => readXhsDirectMessages());
      let auto = null;
      try {
        auto = await withXhsBrowser(() => scheduler?.autoReplyOwnerDm?.(result.items || [], loadSettings()) || null);
      } catch (error) {
        logger.warn('手动刷新私信时自动回复失败', { error: error.message });
      }
      return sendJson(res, 200, { ok: true, items: result.items, at: result.at, auto });
    } catch (error) {
      addEvent('xhs_dm_failed', '这次没读到私信列表', { error: String(error.message).slice(0, 100) });
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/dm/draft' && method === 'POST') {
    const body = await readJsonBody(req);
    const settings = loadSettings();
    const target = String(body.target || '').trim().slice(0, 40);
    const message = String(body.message || '').trim().slice(0, 300);
    if (!message) return sendJson(res, 400, { error: '先告诉我对方说了什么' });
    try {
      const result = await llm.chat(
        [
          { role: 'system', content: '你只输出要发出去的那句话，不要解释、不要引号。' },
          {
            role: 'user',
            content: buildXhsDmReplyPrompt({
              settings,
              mood: getMood(),
              from: target,
              message,
              isOwner: Boolean(target) && target === settings.social?.xhsOwnerName,
              ownerName: settings.social?.xhsOwnerName || '',
            }),
          },
        ],
        { kind: 'xhs_dm', temperature: 0.9, maxTokens: 200, reasoningEffort: 'low', mockKind: 'plain' },
      );
      const text = String(result.content || '').replace(/^["“”']+|["“”']+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) return sendJson(res, 500, { error: '她没想出合适的话' });
      return sendJson(res, 200, { ok: true, text, to: target });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/dm/send' && method === 'POST') {
    const body = await readJsonBody(req);
    const target = String(body.target || '').trim().slice(0, 40);
    const text = String(body.text || '').replace(/\s+/g, ' ').trim();
    if (!target) return sendJson(res, 400, { error: '要说清楚这条回给谁' });
    if (body.confirm !== true) return sendJson(res, 400, { error: '这条私信要你在控制台勾选确认才会发' });
    const gate = canSendXhsDm(target);
    if (!gate.ok) {
      addEvent('xhs_dm_blocked', '这条小红书私信没发出去', { reason: gate.reason, target });
      return sendJson(res, 409, { error: gate.reason });
    }
    try {
      const isOwnerTarget = Boolean(target) && target === String(loadSettings().social?.xhsOwnerName || '');
      const result = await withXhsBrowser(() => sendXhsDirectMessage({ target, convId: String(body.convId || ''), text, privateToOwner: isOwnerTarget }));
      recordXhsActivity({ type: 'dm_reply', text: result.text, target });
      addEvent('xhs_dm_reply', `她回了一条小红书私信给「${target}」`, { verified: result.verified });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      if (isRiskyError(error)) triggerXhsCooldown(6, error.message);
      addEvent('xhs_dm_reply_failed', '小红书私信没发出去', { error: String(error.message).slice(0, 120), target });
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/qr' && method === 'GET') {
    try {
      return sendJson(res, 200, await withXhsBrowser(() => getXhsLoginQr({ force: url.searchParams.get('refresh') === '1' })));
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/budget' && method === 'GET') {
    const cooldown = xhsCooldownUntil();
    return sendJson(res, 200, {
      ok: true,
      ...xhsBudgetStatus(),
      cooldownUntil: cooldown && new Date(cooldown).getTime() > Date.now() ? cooldown : '',
      publishesToday: Number(kvGet(`xhs_publish_day:${shanghaiDay()}`) || 0),
      publishPerDay: loadSettings().social?.xhsPublishPerDay ?? 1,
      lastPublishAt: kvGet('xhs_last_publish_at') || '',
    });
  }

  if (pathname === '/api/xhs/profile' && method === 'GET') {
    try {
      return sendJson(res, 200, { ok: true, profile: await withXhsBrowser(discoverSelfProfile) });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/stickers/status' && method === 'GET') {
    return sendJson(res, 200, { ok: true, ...stickerLibraryStatus() });
  }

  if (pathname === '/api/stickers/find' && method === 'POST') {
    const body = await readJsonBody(req);
    try {
      const result = await withActionLock('sticker-find', () =>
        findAndAdoptStickers({ query: body.query || '蓝鲸鱼 表情包', limit: body.limit || 3 }),
      );
      return sendJson(res, 200, { ...result, ...stickerLibraryStatus() });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/stickers/memes' && method === 'POST') {
    const body = await readJsonBody(req);
    try {
      const result = await withActionLock('sticker-find', async () => {
        const templates = await listMemeTemplates({ limit: 20 });
        const wanted = Math.max(1, Math.min(6, Number(body.limit) || 3));
        const adopted = [];
        const failed = [];
        for (const item of templates) {
          if (adopted.length >= wanted) break;
          try {
            const record = await adoptStickerImage(item.url);
            if (record) adopted.push({ file: record.file, bytes: record.bytes, name: item.name });
          } catch (error) {
            failed.push(error.message);
          }
        }
        if (!adopted.length) throw new Error(new Set(failed).size ? [...new Set(failed)].slice(0, 2).join('；') : '一张梗图都没收进来');
        addEvent('sticker_meme', `收了 ${adopted.length} 张现成梗图模板进表情库`, { adopted: adopted.length });
        return { ok: true, adopted, failed: failed.slice(0, 3) };
      });
      return sendJson(res, 200, { ...result, ...stickerLibraryStatus() });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/actions/dream' && method === 'POST') {
    try {
      const result = await scheduler.manual(() => withActionLock('dream', () => scheduler.runDream()));
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/voice/setup' && method === 'GET') {
    const asr = asrStatus();
    return sendJson(res, 200, {
      ok: true,
      voices: ttsVoices(),
      engines: ttsStatus(),
      asr: { ...asr, modelMb: Math.round((asr.modelBytes || 0) / 1024 / 1024) },
    });
  }

  if (pathname === '/api/voice/preview' && method === 'POST') {
    const body = await readJsonBody(req);
    const cfg = loadSettings().tts || {};
    const text = String(body.text || '').trim().slice(0, 80) || '你好呀，我想用这个声音跟你说说话，你听听看。';
    try {
      const audio = await synthesizeSpeech(text, {
        voice: body.voice || cfg.voice,
        rate: body.rate || cfg.rate,
        pitch: body.pitch || cfg.pitch,
        maxChars: 80,
      });
      addEvent('voice_preview', `试听了一次（${audio.voice || audio.engine}）`, { bytes: audio.bytes });
      return sendJson(res, 200, {
        ok: true,
        url: `/api/voice/audio?file=${encodeURIComponent(path.basename(audio.file))}`,
        engine: audio.engine,
        voice: audio.voice,
        bytes: audio.bytes,
      });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/voice/compare' && method === 'POST') {
    // 同一句文本喂给所有候选音色：文本固定，听感差异就只能来自引擎本身。
    // 自然度不由我断言，出声给用户盲听，选中的才写回设置。
    const body = await readJsonBody(req);
    const cfg = loadSettings().tts || {};
    const catalog = ttsVoices();
    const labelOf = (id) => (catalog.find((item) => item.id === id) || {}).label || id;
    const text = String(body.text || '').trim().slice(0, 60) || '今天怎么啦？听起来你有点累，要不要先喝口水。';
    // 试听名单显式排：基线女声 + 几个差异大的中文音色 + 两个本地离线引擎都要在列，
    // 否则「抓前 N 个」会把本地那两个挤掉（第一版就是这么漏的）。
    const preferred = [
      'zh-CN-XiaoxiaoNeural',
      'zh-CN-XiaoyiNeural',
      'zh-TW-HsiaoYuNeural',
      'zh-CN-shaanxi-XiaoniNeural',
      'zh-CN-YunxiNeural',
      'local-matcha',
      'local-piper',
    ];
    const known = new Set(catalog.map((item) => item.id));
    const fallback = preferred.filter((id) => known.has(id));
    const queue = (Array.isArray(body.voices) && body.voices.length ? body.voices : fallback).slice(0, 10).map(String);
    const results = [];
    const lane = async () => {
      while (queue.length) {
        const voice = queue.shift();
        const t0 = Date.now();
        try {
          const audio = await synthesizeSpeech(text, { voice, rate: cfg.rate, pitch: cfg.pitch, volume: cfg.volume || '', maxChars: 80 });
          results.push({
            voice,
            label: labelOf(voice),
            ok: true,
            engine: audio.engine,
            ms: Date.now() - t0,
            bytes: audio.bytes,
            // wav 有精确样本数；mp3 没有解码器，宁可报未测量，也不拿估算冒充。
            seconds: audio.seconds ?? null,
            url: `/api/voice/audio?file=${encodeURIComponent(path.basename(audio.file))}`,
          });
        } catch (error) {
          results.push({ voice, label: labelOf(voice), ok: false, error: errorMessage(error) });
        }
      }
    };
    await Promise.all([lane(), lane(), lane()]);
    const spoken = results.filter((item) => item.ok).length;
    addEvent('voice_compare', `一次音色试听对比：${spoken}/${results.length} 个出了声`, { text: text.length });
    return sendJson(res, 200, { ok: true, text, results });
  }

  if (pathname === '/api/voice/echo' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const result = await onebot.echoCheck(String(body.text || ''));
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: errorMessage(error) });
    }
  }

  if (pathname === '/api/voice/audio' && method === 'GET') {
    const file = safeJoin(paths.media, String(url.searchParams.get('file') || ''));
    if (!file || !/\.(mp3|wav)$/i.test(file)) throw new HttpError(403, '只给放她自己合成的声音');
    return serveStatic(res, file);
  }

  if (pathname === '/api/intentions/complete' && method === 'POST') {
    const body = await readJsonBody(req);
    const id = String(body.id || '');
    if (!id) throw new HttpError(400, '缺少 id');
    return sendJson(res, 200, { ok: true, done: completeIntention(id, '控制台点的') });
  }

  if (pathname === '/api/xhs/images' && method === 'GET') {
    try {
      return sendJson(res, 200, { ok: true, images: listXhsImages().map((i) => ({ name: i.name, bytes: i.bytes })) });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/image' && method === 'GET') {
    const image = listXhsImages().find((item) => item.name === url.searchParams.get('name'));
    if (!image) return sendJson(res, 404, { error: '没有这张公开配图' });
    return serveStatic(res, image.file);
  }

  if (pathname === '/api/xhs/profile/draft' && method === 'POST') {
    try {
      const settings = loadSettings();
      const profile = await withActionLock('xhs-profile', () => withXhsBrowser(discoverSelfProfile));
      const result = await llm.chat(
        [
          { role: 'system', content: '你只输出严格 JSON，不要 markdown。' },
          {
            role: 'user',
            content: buildXhsProfilePrompt({
              settings,
              mood: getMood(),
              current: profile,
              memories: listMemories({ layer: 'core', limit: 8 }),
            }),
          },
        ],
        {
          kind: 'xhs_profile',
          model: settings.model.name,
          temperature: 0.95,
          maxTokens: 700,
          reasoningEffort: 'low',
          responseFormat: { type: 'json_object' },
          mockKind: 'xhs_profile',
        },
      );
      const data = parseJsonLoose(result.content);
      const names = Array.isArray(data.names) ? data.names.map((n) => String(n).slice(0, 24)).filter(Boolean).slice(0, 3) : [];
      const bio = String(data.bio || '').trim().slice(0, 120);
      if (!names.length && !bio) throw new Error('她这次没想起来要改成什么');
      return sendJson(res, 200, {
        ok: true,
        current: profile,
        names,
        bio,
        why: String(data.why || '').slice(0, 60),
        steps: [
          '手机小红书 → 我 → 点头像进主页 → 右上角「编辑资料」',
          '改「名字」和「简介」，保存',
          '回到控制台点「读一下我现在叫什么」，她会核对有没有真的改上',
        ],
      });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/activity' && method === 'GET') {
    const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 48));
    return sendJson(res, 200, { ok: true, activity: getRecentXhsActivity({ hours, limit: 20 }) });
  }

  if (pathname === '/api/xhs/report' && method === 'POST') {
    try {
      const stats = await withActionLock('xhs-report', () => withXhsBrowser(fetchXhsCreatorStats));
      const notes = loadSettings().social?.xhsEnabled ? await withXhsBrowser(() => listSelfNotesForReport(8)).catch(() => []) : [];
      const activity = getRecentXhsActivity({ hours: 168, limit: 20 });
      const settings = loadSettings();
      const result = await llm.chat(
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
      const topics = Array.isArray(data.topics)
        ? data.topics.slice(0, 3).map((t) => ({
            title: String(t?.title || '').slice(0, 60),
            why: String(t?.why || '').slice(0, 120),
            need: String(t?.need || '').slice(0, 120),
          }))
        : [];
      if (!report) throw new Error('她这次没写出周报');
      const file = writeXhsWeekly(report, topics, stats);
      recordXhsActivity({ type: 'report', note: '写了这周的小红书数据小结', text: report.slice(0, 80) });
      addEvent('xhs_weekly', '写好了这周的小红书数据小结', { file, views: stats.views, followers: stats.followers });
      return sendJson(res, 200, { ok: true, report, topics, stats, file });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/note/preview' && method === 'POST') {
    const body = await readJsonBody(req);
    try {
      const result = await withActionLock('xhs-publish', () =>
        withXhsBrowser(() => fillXhsNote({ images: body.images || [], title: body.title || '', body: body.body || '' })),
      );
      recordXhsActivity({ type: 'note_fill', note: result.title, text: result.body, target: `${(body.images || []).length} 张图` });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/note/publish' && method === 'POST') {
    const body = await readJsonBody(req);
    if (body.confirm !== true) throw new HttpError(400, '要真的发布，请在控制台勾选确认后再点');
    try {
      const result = await withActionLock('xhs-publish', () => withXhsBrowser(publishFilledXhsNote));
      if (result.published) {
        recordXhsActivity({
          type: 'note_publish',
          note: result.title || '图文笔记',
          text: '他在控制台上按了发布',
          target: '手动',
        });
      }
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/note/stash' && method === 'POST') {
    try {
      const result = await withActionLock('xhs-publish', () => withXhsBrowser(stashXhsDraft));
      if (result.stashed) recordXhsActivity({ type: 'note_draft', note: '存进草稿箱', text: `草稿箱现在 ${result.after} 条` });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/note/leave' && method === 'POST') {
    try {
      await withActionLock('xhs-publish', () => withXhsBrowser(leaveXhsPublishEditor));
      return sendJson(res, 200, { ok: true, left: true });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/run/browse' && method === 'POST') {
    try {
      const result = await scheduler.manual(() =>
        withActionLock('xhs-run', () => withXhsBrowser(() => scheduler.runXhs({ browse: true, reply: false, maxNotes: 2, manual: true }))),
      );
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/xhs/run/reply' && method === 'POST') {
    try {
      const result = await scheduler.manual(() =>
        withActionLock('xhs-run', () => withXhsBrowser(() => scheduler.runXhs({ browse: false, reply: true, maxNotes: 3, manual: true }))),
      );
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/qzone/verify' && method === 'GET') {
    return sendJson(res, 200, await verifyQzoneCookie());
  }

  if (pathname === '/api/qzone/feed' && method === 'GET') {
    try {
      const refresh = url.searchParams.get('refresh') === '1';
      const cached = getQzoneFeedCache();
      const feed = refresh || !cached ? await refreshQzoneFeed({ num: 20 }) : cached;
      return sendJson(res, 200, { ok: true, ...feed });
    } catch (error) {
      const cached = getQzoneFeedCache();
      return sendJson(res, 500, { error: error.message, cached });
    }
  }

  if (pathname === '/api/qzone/comments/draft' && method === 'POST') {
    const body = await readJsonBody(req);
    const settings = loadSettings();
    const comment = body.comment || {};
    try {
      const result = await llm.chat(
        [
          { role: 'system', content: '你只输出回复正文，不要解释。' },
          {
            role: 'user',
            content: buildQzoneCommentReplyPrompt({
              settings,
              mood: getMood(),
              postContent: body.postContent,
              comment,
            }),
          },
        ],
        {
          kind: 'qzone_reply',
          temperature: 0.85,
          maxTokens: 250,
          reasoningEffort: 'low',
          mockKind: 'plain',
        },
      );
      return sendJson(res, 200, { ok: true, text: String(result.content || '').trim() });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/qzone/comments/reply' && method === 'POST') {
    const body = await readJsonBody(req);
    try {
      const result = await sendQzoneComment({
        tid: body.tid,
        content: body.content,
        commentId: body.commentId,
        replyUin: body.replyUin,
        postUin: body.postUin,
      });
      if (body.tid && body.commentId) {
        const key = `${body.tid}:${body.commentId}:${body.replyUin || ''}`;
        const keys = kvGetJson('qzone_replied_comments', []);
        if (!keys.includes(key)) {
          keys.push(key);
          kvSetJson('qzone_replied_comments', keys.slice(-1000));
        }
      }
      addEvent('qzone_comment', '你在控制台确认后，她回复了一条空间评论', {
        tid: body.tid,
        commentId: body.commentId || null,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      addEvent('qzone_comment_error', '空间评论回复失败', { error: error.message });
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/qzone/auto-reply/run' && method === 'POST') {
    try {
      const result = await scheduler.manual(() => scheduler.runQzoneAutoReply({ force: true }));
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/qzone/import-napcat' && method === 'POST') {
    try {
      const status = await importQzoneCookieFromNapCat();
      return sendJson(res, 200, { ok: true, ...status });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/qzone/cookie' && method === 'POST') {
    const body = await readJsonBody(req);
    try {
      const status = saveQzoneCookie(body.cookie);
      addEvent('qzone_cookie', '已保存 QQ 空间 Cookie（仅本机）', { uin: status.uin });
      return sendJson(res, 200, { ok: true, ...status });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/qzone/cookie' && method === 'DELETE') {
    const status = clearQzoneCookie();
    addEvent('qzone_cookie', '已清除 QQ 空间 Cookie');
    return sendJson(res, 200, { ok: true, ...status });
  }

  if (pathname === '/api/qq/setup' && method === 'GET') {
    const napcatDir = path.join(paths.root, 'napcat');
    const installed = fs.existsSync(napcatDir) && fs.readdirSync(napcatDir).length > 0;
    const candidate = kvGetJson('qq_owner_candidate', null);
    const qrFile = path.join(paths.root, 'napcat', 'cache', 'qrcode.png');
    let qrStat = null;
    try {
      qrStat = fs.statSync(qrFile);
    } catch {
      qrStat = null;
    }
    return sendJson(res, 200, {
      wsUrl: `ws://127.0.0.1:${env.port}/onebot`,
      token: maskKey(env.onebotToken),
      tokenConfigured: Boolean(env.onebotToken),
      installed,
      dir: napcatDir,
      status: onebot?.status() || null,
      ownerId: kvGet('qq_owner_id') || '',
      candidate,
      qrAvailable: Boolean(qrStat),
      qrUpdatedAt: qrStat ? qrStat.mtime.toISOString() : null,
      learnedMfaces: onebot?.learnedMfaceCount?.() || 0,
      learnedImages: onebot?.learnedImageCount?.() || 0,
      settings: loadSettings().qq,
    });
  }

  if (pathname === '/api/qq/stop' && method === 'POST') {
    const selfId = kvGet('qq_self_id') || '';
    saveSettings({ qq: { enabled: false } });
    writeBotAccountFile(loadSettings().qq?.botAccount);
    onebot?.disconnectAll();
    await killNapCatTree();
    addEvent('qq_channel_stopped', `她停用了 QQ 通道并退出了 NapCat 挂着的 QQ（${selfId || '未知号'}）；主号如果被它占用过，需要你重新打开主号`, {
      selfId,
    });
    return sendJson(res, 200, { ok: true, exited: !env.testMode, simulated: env.testMode, selfId });
  }

  if (pathname === '/api/qq/token/reveal' && method === 'POST') {
    if (!env.onebotToken) return sendJson(res, 200, { ok: false, reason: '还没设置 ONEBOT_TOKEN' });
    addEvent('qq_token_revealed', '把 OneBot 令牌完整显示了一次');
    return sendJson(res, 200, { ok: true, token: env.onebotToken });
  }

  if (pathname === '/api/qq/bind-owner' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req, 64 * 1024);
    } catch (error) {
      return sendJson(res, Number(error.status) || 400, { error: errorMessage(error) });
    }
    const candidate = kvGetJson('qq_owner_candidate', null);
    const userId = String(body.userId || candidate?.userId || '').trim();
    if (!/^\d{5,12}$/.test(userId)) return sendJson(res, 400, { error: 'QQ 号格式不对' });
    if (String(userId) === String(onebot?.status()?.selfId || '')) {
      return sendJson(res, 400, { error: '不能把机器人自己的 QQ 设成主人' });
    }
    if (candidate && String(candidate.userId) !== userId && body.manual !== true) {
      return sendJson(res, 409, { error: '待确认的 QQ 号已经变了，刷新后重试' });
    }
    onebot?.cancelPending();
    kvSet('qq_owner_id', userId);
    kvSetJson('qq_owner_candidate', null);
    addEvent('qq_owner', body.manual ? '你在控制台手动绑定了主人 QQ' : '你在控制台确认了 QQ 主人', { userId });
    return sendJson(res, 200, { ok: true, ownerIdMasked: maskQq(userId) });
  }

  if (pathname === '/api/qq/qr/restart' && method === 'POST') {
    const settings = loadSettings();
    const current = onebot?.status?.() || null;
    if (current?.connected && String(current.selfId) === String(settings.qq?.botAccount || '')) {
      return sendJson(res, 409, { error: '现在挂的就是机器人小号，不需要重新扫码' });
    }
    try {
      const result = await restartQqLogin(
        current?.connected
          ? `你要求切换账号：先退出当前 QQ（${current.selfId}），再登录机器人小号`
          : '你在控制台重新生成了 QQ 登录二维码',
      );
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/qq/qr' && method === 'GET') {
    const qrFile = path.join(paths.root, 'napcat', 'cache', 'qrcode.png');
    if (!fs.existsSync(qrFile)) return sendJson(res, 404, { error: '还没有生成 QQ 登录二维码' });
    res.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(qrFile).pipe(res);
    return undefined;
  }

  if (pathname === '/api/qq/reset-owner' && method === 'POST') {
    onebot?.cancelPending();
    kvSet('qq_owner_id', '');
    kvSetJson('qq_owner_candidate', null);
    addEvent('qq_owner_reset', '你解绑了 QQ 主人，下一条私聊需要重新确认');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/qq/health' && method === 'GET') {
    if (!onebot?.status()?.connected) return sendJson(res, 200, { ok: false, error: 'NapCat 反向 WebSocket 没连上' });
    try {
      const info = await onebot.sendAction('get_login_info', {}, 8000);
      return sendJson(res, 200, {
        ok: true,
        selfId: String(info?.data?.user_id || ''),
        nickname: String(info?.data?.nickname || ''),
      });
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: error.message });
    }
  }

  if (pathname === '/api/qq/test' && method === 'POST') {
    try {
      const sent = await onebot.sendToOwner('我在的，测试一下。');
      return sendJson(res, 200, { ok: sent, reason: sent ? '' : 'QQ 还没连上，或者还没有绑定主人。' });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/qq/test-voice' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const audio = await onebot.sendVoiceAndCount(
        String(body.text || '').trim() || '这条是刚调好的音色，你在手机上放来听听，好不好听你说了算。',
        { source: 'console', voice: String(body.voice || ''), rate: String(body.rate || ''), pitch: String(body.pitch || '') },
      );
      return sendJson(res, 200, { ok: true, engine: audio.engine, voice: audio.voice, bytes: audio.bytes });
    } catch (error) {
      const message = errorMessage(error);
      return sendJson(res, 400, { ok: false, error: message, reason: message });
    }
  }

  if (pathname === '/api/qq/test-sticker' && method === 'POST') {
    try {
      const sent = await onebot.sendStickerToOwner('happy');
      return sendJson(res, 200, { ok: sent, reason: sent ? '' : 'QQ 还没连上，或者还没有绑定主人。' });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/qq/test-face' && method === 'POST') {
    try {
      const sent = await onebot.sendFaceToOwner(14);
      return sendJson(res, 200, { ok: sent, reason: sent ? '' : 'QQ 还没连上，或者还没有绑定主人。' });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/qq/test-mface' && method === 'POST') {
    try {
      const sent = await onebot.sendMfaceToOwner();
      return sendJson(res, 200, {
        ok: sent,
        reason: sent ? '' : '还没有学会你的QQ表情包：先用QQ发一个表情包给她。',
      });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/qq/test-learned-image' && method === 'POST') {
    try {
      const sent = await onebot.sendLearnedImageToOwner();
      return sendJson(res, 200, {
        ok: sent,
        reason: sent ? '' : '还没有学过图片表情：先私聊发一张图片给她。',
      });
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, { error: errorMessage(error) });
    }
  }

  if (pathname === '/api/qq/learned-images' && method === 'DELETE') {
    clearLearnedImages();
    addEvent('qq_learn_clear', '已清空学到的图片表情');
    return sendJson(res, 200, { ok: true, count: 0 });
  }

  /* ---------------- 陪伴模式：摄像头 / 麦克风 / 念话 / 身体状态 ---------------- */

  if (pathname === '/api/presence/state' && method === 'GET') {
    const settings = loadSettings();
    return sendJson(res, 200, {
      ok: true,
      presence: settings.presence,
      budget: presenceBudget(settings),
      neuro: neuroStatus(settings),
      senses: sensesStatus(),
      brain: brainStats(),
      mood: getMood(),
      asrReady: asrStatus().ready,
    });
  }

  if (pathname === '/api/presence/curve' && method === 'GET') {
    const id = Number(url.searchParams.get('id'));
    if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, '缺少记忆 id');
    const curve = curveForMemory(id);
    if (!curve) throw new HttpError(404, '这条记忆不在了');
    return sendJson(res, 200, { ok: true, ...curve });
  }

  if (pathname === '/api/presence/hear' && method === 'POST') {
    const settings = loadSettings();
    const body = await readJsonBody(req, 4 * 1024 * 1024);
    const result = await hearWav(body.audio, { settings });
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (pathname === '/api/presence/look' && method === 'POST') {
    const settings = loadSettings();
    const body = await readJsonBody(req, 12 * 1024 * 1024);
    const image = String(body.image || '');
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(image) || image.length > 8 * 1024 * 1024) {
      throw new HttpError(400, '只收 png/jpeg/webp 的数据块，单张别超过 8MB');
    }
    if (costBlocked('look')) throw new HttpError(429, '今天花费到线了，先不让她看东西');
    const budget = consumeCameraSlot(settings);
    const caption = String(body.caption || '').trim().slice(0, 200);
    const result = await companion.reply({
      text: caption || '（他把摄像头对准了这边）你看看，说说你看到了什么',
      images: [image],
      channel: 'web',
      extraContext:
        '这是他现在用摄像头给你的实时画面，不是他上传的旧照片。只说画面里真看得清的东西；看不清、光线差就说看不清，别补画面外的细节。',
    });
    applyNeuroEvent('novelty_sight');
    noteBrainLink('look');
    if (settings.presence?.sensesEnabled) {
      const sense = addSense({
        kind: 'sight',
        text: String(result.text || '').slice(0, 60),
        detail: caption,
        source: 'camera',
      });
      if (sense.ok) noteBrainLink('sense');
    }
    return sendJson(res, 200, {
      ok: true,
      text: result.text,
      message: result.message,
      stickerHint: result.stickerHint || null,
      costCny: result.costCny,
      budget,
    });
  }

  if (pathname === '/api/presence/speak' && method === 'POST') {
    const settings = loadSettings();
    if (!settings.presence?.speakReplies) {
      throw new HttpError(403, '控制台念话是关的：设置页「陪伴与感官」里打开');
    }
    const body = await readJsonBody(req);
    const text = String(body.text || '').trim();
    if (!text) throw new HttpError(400, '没有要念的话');
    checkSpeakSlot(settings);
    try {
      const audio = await speakLine(text, settings);
      return sendJson(res, 200, { ok: true, ...audio, budget: noteSpeakUsed(settings) });
    } catch (error) {
      addEvent('presence_speak_error', '控制台念话没合成出来', { error: errorMessage(error).slice(0, 120) });
      throw new HttpError(502, `语音没合成出来：${errorMessage(error)}`);
    }
  }

  if (pathname === '/api/presence/senses' && method === 'DELETE') {
    clearSenses();
    addEvent('presence_senses_clear', '她清空了自己的感官记忆');
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'API 不存在' });
}

function shouldLockApi(pathname, method) {
  if (!method || ['GET', 'HEAD'].includes(method)) return EXPENSIVE_GET.has(pathname);
  if (EXPENSIVE_API.has(pathname)) return true;
  return /^\/api\/posts\/\d+\/publish$/.test(pathname);
}

export function botAccountFile() {
  return path.join(paths.data, 'qq-account.txt');
}

export function writeBotAccountFile(account) {
  const value = String(account || '').trim();
  if (!/^[0-9]{5,12}$/.test(value)) return false;
  try {
    fs.writeFileSync(botAccountFile(), value, 'utf8');
    return true;
  } catch (error) {
    logger.warn('机器人 QQ 号写不进 qq-account.txt', { error: error.message });
    return false;
  }
}

async function killNapCatTree() { return stopOwned('napcat'); }

export async function restartQqLogin(note = '重新启动了 QQ 登录') {
  if (env.testMode) return { ok: true, simulated: true, reason: '隔离测试：未控制真实 QQ 进程' };
  const settings = loadSettings();
  if (!settings.qq?.enabled) {
    saveSettings({ qq: { enabled: true } });
    addEvent('qq_channel_enabled', '重新登录时自动启用了 QQ 通道');
  }
  await killNapCatTree();
  writeBotAccountFile(loadSettings().qq?.botAccount);
  await startNapCat();
  addEvent('qq_login_restart', note);
  return {
    ok: true,
    enabled: true,
    reason: '正在重新启动 QQ 登录；二维码出来会自动刷新，扫完这里会自动变成已连接',
  };
}

async function handleRequest(req, res) {
  let url;
  let pathname;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    pathname = decodeURIComponent(url.pathname);
    assertCsrf(req);
  } catch (error) {
    req.resume();
    return sendJson(res, Number(error.status) || 400, { error: error.status ? errorMessage(error) : '请求地址不合法' });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    try {
      return await handleLogin(req, res);
    } catch (error) {
      logger.warn('控制台登录处理失败', { error: error.message });
      return sendJson(res, Number(error.status) || 400, { error: errorMessage(error) });
    }
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    try { assertLocalRequest(req, url); return handleLogout(req, res); }
    catch (error) { return sendJson(res, Number(error.status) || 400, { error: errorMessage(error) }); }
  }

  if (pathname.startsWith('/api/')) {
    try {
      assertLocalRequest(req, url);
      if (shouldLockApi(pathname, req.method)) {
        if (!['GET', 'HEAD'].includes(req.method || 'GET')) consumeActionRate();
        await withActionLock(pathname, () => handleApi(req, res, pathname, url));
      } else {
        await handleApi(req, res, pathname, url);
      }
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) logger.error('API 处理失败', { pathname, error: error.message });
      else if (status !== 401) logger.warn('API 请求被拒绝', { pathname, status, error: error.message });
      if (!res.headersSent) {
        sendJson(res, status, {
          error: errorMessage(error),
          ...(status === 401 ? { login: true } : {}),
        });
      } else if (!res.writableEnded) res.end();
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    return serveStatic(res, path.join(paths.web, 'index.html'));
  }
  if (pathname.startsWith('/char/')) {
    const file = safeJoin(path.join(paths.assets, 'char'), pathname.slice('/char/'.length));
    if (!file) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    return serveStatic(res, file);
  }
  if (pathname.startsWith('/media/')) {
    try { assertLocalRequest(req, url); }
    catch (error) { return sendJson(res, Number(error.status) || 403, { error: errorMessage(error), ...(error.status === 401 ? { login: true } : {}) }); }
    const file = safeJoin(paths.media, pathname.slice('/media/'.length));
    if (!file || !/\.(png|jpe?g|webp)$/i.test(file)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    return serveStatic(res, file);
  }
  if (pathname.startsWith('/assets/')) {
    const file = safeJoin(path.join(paths.web, 'assets'), pathname.slice('/assets/'.length));
    if (!file) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    return serveStatic(res, file);
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  const file = safeJoin(paths.web, pathname);
  if (!file) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  return serveStatic(res, file);
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function main() {
  server = http.createServer({ requestTimeout: 30000, headersTimeout: 15000 }, handleRequest);
  onebot = new OneBotChannel({
    server,
    companion,
    onNeedRecover: () => restartQqLogin('QQ 断了挺久，她自己把登录重新拉起来了'),
    onCommand: async (name, arg) => {
      const { loadSettings: ls, saveSettings: ss } = await import('./config.js');
      if (name === 'auto') {
        ss({ social: { xhsEnabled: arg.on, xhsAutoBrowse: arg.on, xhsAutoReply: arg.on, xhsAutoLike: arg.on, xhsAutoCollect: arg.on, xhsAutoPublish: arg.on } });
        const s2 = ls().social;
        return { publishPerDay: s2.xhsPublishPerDay, commentMax: s2.xhsDailyCommentMax };
      }
      if (name === 'status') {
        const st = scheduler?.status() || {};
        const s2 = ls();
        const cooldown = kvGet('xhs_cooldown_until');
        const cooling = cooldown && new Date(cooldown).getTime() > Date.now();
        return [
          `QQ ${onebot.status().connected ? '连着' : '断了'}；余额 ${balanceText()}`,
          `今天：主动找你了 ${st.todayProactive || 0} 次，小红书评论 ${kvGet(`xhs_comment_day:${shanghaiDay()}`) || 0} 条、发笔记 ${kvGet(`xhs_publish_day:${shanghaiDay()}`) || 0} 条`,
          `下一次主动找你：${st.nextProactiveAt ? new Date(st.nextProactiveAt).toLocaleString('zh-CN', { hour12: false }) : '还没排上'}`,
          `自动运营：${s2.social.xhsEnabled ? '开着' : '关着'}${cooling ? `（风控冷却到 ${cooldown.slice(11, 16)}）` : ''}`,
          '可以跟我说：状态 / 今天做了啥 / 逛一下 / 发一条 / 自动运营 开|关',
        ].join('\n');
      }
      if (name === 'browse') {
        const r = await scheduler.manual(() => scheduler.runXhs({ browse: true, reply: false, maxNotes: 0, manual: true }));
        return `刚逛了 ${r.browsed || 0} 条，说了 ${r.commented || 0} 句，点了 ${r.liked || 0} 个赞，${r.passed || 0} 条看完没说话${r.reason ? `（${r.reason}）` : ''}`;
      }
      if (name === 'publish') {
        const r = await scheduler.manual(() => scheduler.maybeXhsPublish());
        if (r && r.skipped) return `我想了想今天不发：${r.reason || '没理由'}`;
        if (r && r.title) return `发出去了：「${r.title}」`;
        return '这次没发成，原因记在控制台事件里了';
      }
      if (name === 'voice') {
        try {
          await onebot.sendVoiceAndCount('这条是我试着用语音发出来的，音质还能再调。', { source: 'qq-command' });
          return '';
        } catch (error) {
          return `语音没发出去：${error.message}`;
        }
      }
      if (name === 'today') {
        const acts = getRecentXhsActivity({ hours: 16, limit: 8 });
        if (!acts.length) return '今天我在小红书上没做什么事';
        return `今天到现在：${acts.map((a) => `${a.type}·${(a.note || a.text || '').slice(0, 18)}`).join('；')}`;
      }
      return '';
    },
  });
  scheduler = new Scheduler({
    llm,
    companion,
    sendToOwner: (text) => onebot.sendToOwner(text),
    refreshQzoneCookie: () => importQzoneCookieFromNapCat(),
  });

  server.on('error', (error) => {
    logger.error(`HTTP 服务启动失败：${error.message}`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100);
  });

  try {
    maintenance();
  } catch (error) {
    logger.warn('启动清理失败', { error: error.message });
  }

  writeBotAccountFile(loadSettings().qq?.botAccount);
  server.listen(env.port, '127.0.0.1', () => {
    env.port = server.address().port;
    const url = `http://127.0.0.1:${env.port}`;
    if (!env.testMode) scheduler.start();
    if (env.testMode) console.log(`BIZHI_READY:${env.port}`);
    logger.info(`小知已启动：${url}`);
    logger.info(`模型：${loadSettings().model.name} | Key：${maskKey() || '未配置'} | 模拟模式：${env.mock ? '开' : '关'}`);
    logger.info(`QQ 通道：ws://127.0.0.1:${env.port}/onebot（NapCat 反向 WS）`);
    if (env.openBrowser) openBrowser(url);
    if (llm.configured && !env.mock) {
      llm
        .balance()
        .then((b) => logger.info(`DeepSeek 余额：${b.total} ${b.currency}`))
        .catch((error) => logger.warn(`余额查询失败：${error.message}`));
    }
  });

  const shutdown = () => {
    logger.info('正在关闭…');
    try {
      scheduler?.stop();
      onebot?.destroy();
      server?.close();
      closeDb();
    } catch {
      // ignore
    }
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => logger.error('未处理的 Promise 拒绝', { reason: String(reason) }));
}

main();
