// X / Twitter 通道：用本项目专用的浏览器（独立 profile + 显式代理）读写他的账号。
//
// 三条和小红书一样硬的规矩，另有两条 X 特有的：
// 1) 代理不通就绝不动手。X 在这张网上直连不通（实测直连 000、代理 200），
//    跟着系统代理走会把"代理没起来"记成"页面打不开"，那是假原因。
// 2) 列表为空必须能分清"真的没有"和"页面没加载出来"——后者一律报错，不许当成 0 条继续跑。
// 3) 任何限流/验证/封禁字样 → 立刻进 24 小时冷却，不再重试。
// 4) 发推、私信、关注这类不可撤回的动作，默认只填不发；真发要点一下"发布"并逐字核对。
// 5) 选择器只认 data-testid；X 的 class 名是混淆的，按 class 写的判据撑不过一次改版。

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env, loadSettings, paths } from '../config.js';
import { addEvent, kvGet, kvGetJson, kvSet, kvSetJson, recentUserMessages } from '../db.js';
import { logger } from '../logger.js';
import { assertPublicContent } from '../privacy.js';
import { hashText, nowIso, sleep } from '../util.js';
import { CdpBrowser } from '../browser/cdp.js';
import { SerialQueue } from '../serial.js';
import { beginEffect, DeliveryUnknownError, failEffect, finishEffect } from '../effects.js';
import { assertXAction, assertXDeliveryEvidence, assertXPage, assertXReactEvidence, assertXReplyEvidence, isXLoginPage, triggerXCooldown, xCooldownUntil } from './x-safety.js';

const BASE = 'https://x.com';
const PORT = Number(env.xBrowserPort || 9334);
const browser = new CdpBrowser({ port: PORT, profileDir: paths.xProfile, visible: false, proxyServer: env.xProxy, lang: 'en-US' });
const queue = new SerialQueue({ maxWaiting: 12, waitMs: 60000 });

let lastError = '';
let lastCheckAt = null;

function noteError(message) {
  lastError = String(message || '').slice(0, 200);
  return lastError;
}

export function xLastError() {
  return lastError;
}

// 代理活着吗：只连 TCP，不发请求。不通就是不通，别拿"页面打不开"糊弄过去。
export function xProxyAlive(timeoutMs = 800) {
  const url = String(env.xProxy || '');
  const m = /^https?:\/\/([^:/]+):?(\d+)?/i.exec(url);
  if (!m) return Promise.resolve({ ok: false, reason: '没配 X 代理地址（.env 里写 X_PROXY_URL）' });
  const host = m[1];
  const port = Number(m[2] || 80);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, host, port, reason: `代理 ${host}:${port} 没应答（X 直连不通，必须先把它起来）` });
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true, host, port });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, host, port, reason: `代理 ${host}:${port} 连不上（${error.code || error.message}）：X 需要它才出得去` });
    });
  });
}

async function requireProxy() {
  const probe = await xProxyAlive();
  if (!probe.ok) {
    const error = new Error(probe.reason || '代理不通，X 打不开');
    error.code = 'X_PROXY_DOWN';
    throw error;
  }
  return probe;
}

export function xBrowser() {
  return browser;
}

export function withXBrowser(task, options) {
  return queue.run('browser', async () => {
    try {
      return await task();
    } catch (error) {
      noteError(error.message);
      if (/限流|频繁|验证|封禁|restricted|suspended|rate limit/i.test(error.message)) {
        const until = triggerXCooldown(24, error.message);
        addEvent('x_cooldown', 'X 提示限流或验证，所有动作暂停 24 小时', { until, reason: String(error.message).slice(0, 120) });
      }
      throw error;
    }
  }, options);
}

export function xBrowserBusy() {
  return queue.busy;
}

// ---- 页面读取原语 -----------------------------------------------------------

const TWEET_SCAN = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cards = [...document.querySelectorAll('article[data-testid="tweet"]')];
  const parseCount = (el) => {
    const t = clean(el && el.innerText).replace(/,/g, '');
    const m = t.match(/^(\d+(?:\.\d+)?)[KkM]?$/);
    if (!m) return 0;
    const base = Number(m[1]);
    if (/[Kk]$/.test(t)) return Math.round(base * 1e3);
    if (/M$/.test(t)) return Math.round(base * 1e6);
    return base;
  };
  return cards.map((card) => {
    const link = card.querySelector('a[href*="/status/"]');
    const idMatch = link && link.getAttribute('href').match(/\/status\/(\d+)/);
    const user = card.querySelector('[data-testid="User-Name"]');
    const handle = clean(user && user.innerText).match(/@([A-Za-z0-9_]{1,20})/);
    const stat = (testid) => parseCount(card.querySelector('[data-testid=\"' + testid + '\"]'));
    return {
      id: idMatch ? idMatch[1] : '',
      href: link ? link.getAttribute('href') : '',
      author: clean(user && user.querySelector('div')?.innerText).split('\n')[0],
      handle: handle ? handle[1] : '',
      text: clean(card.querySelector('[data-testid="tweetText"]')?.innerText),
      time: clean(card.querySelector('time')?.getAttribute('datetime')),
      likes: stat('tweetAction-ShowReplies') || parseCount(card.querySelector('button[aria-label*="like"]')),
      replyCount: parseCount(card.querySelector('button[aria-label*="Reply"]')),
      retweetCount: parseCount(card.querySelector('button[aria-label*="Repost"]')),
      likeCount: parseCount(card.querySelector('button[aria-label*="Like"]')),
      liked: Boolean(card.querySelector('button[aria-label*="Unlike"]')),
      retweeted: Boolean(card.querySelector('button[aria-label*="Undo Repost"]')),
      media: Boolean(card.querySelector('[data-testid="tweetPhoto"], video')),
    };
  }).filter((item) => item.text || item.id);
})()`;

// 页面到底是"没加载出来"还是"真的没有内容"——这两种情况绝不能混成一句"0 条"。
async function timelineProbe() {
  return await browser.evaluate(String.raw`(() => ({
    url: location.href,
    title: document.title,
    body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
    tweets: document.querySelectorAll('article[data-testid="tweet"]').length,
    cells: document.querySelectorAll('div[data-testid="cell-innerContent"], section[data-testid="SessioContainer"], div[data-testid="primaryColumn"]').length,
    spinner: Boolean(document.querySelector('[data-testid="spinner"]')),
  }))()`);
}

async function assertTimelineLoaded(where, { timeoutMs = 25000 } = {}) {
  // X 的推文是渲染完才挂到 DOM 上的：刚导航完就读只能拿到导航壳（"主页 探索 通知…"）。
  // 直接判 0 条会把"还没加载完"误报成"选择器过期"（实测她的 2 条主页推文就是这么丢的），
  // 所以先等内容出现，等到期限还空着才让下面的判据去区分"真没有"和"没渲染"。
  const deadline = Date.now() + timeoutMs;
  let state = await timelineProbe();
  while (state.tweets === 0 && !isXLoginPage(state.url, state.body) && Date.now() < deadline) {
    await sleep(1200);
    state = await timelineProbe();
  }
  if (isXLoginPage(state.url, state.body)) {
    const error = new Error('X 要登录（被导向登录页），请先在登录窗口里登录一次');
    error.code = 'X_LOGIN_REQUIRED';
    throw error;
  }
  assertXPage(state);
  if (state.tweets > 0) return state;
  if (state.spinner) throw new Error(`${where}还在加载（页面有转圈），这次不当成"没有内容"`);
  if (!state.cells) throw new Error(`${where}没有渲染出内容区，不能当作空列表：${state.body.slice(0, 60)}`);
  if (/Nothing here|No posts|还没有|暂无/.test(state.body)) return state;
  throw new Error(`${where}一条都没解析到，但页面没说"没有内容"，选择器可能过期了：${state.body.slice(0, 60)}`);
}

// ---- 登录与状态 ------------------------------------------------------------

async function xStatusLocked({ verify = false } = {}) {
  const proxy = await xProxyAlive();
  const running = await browser.alive();
  const cached = {
    configured: Boolean(kvGet('x_self_handle') || kvGet('x_logged_in') === '1'),
    loggedIn: kvGet('x_logged_in') === '1',
    browserRunning: running,
    selfHandle: kvGet('x_self_handle') || '',
    selfName: kvGet('x_self_name') || '',
    selfUserId: kvGet('x_self_user_id') || '',
    profileUrl: kvGet('x_profile_url') || '',
    proxy,
    cooldownUntil: xCooldownUntil(),
    lastCheckAt,
    lastError,
  };
  if (!verify && !running) return cached;
  if (!proxy.ok) {
    noteError(proxy.reason);
    return { ...cached, proxyOk: false, loggedIn: cached.loggedIn, error: proxy.reason };
  }
  try {
    await browser.ensure({ visible: false });
    const url = await browser.getUrl();
    if (isXLoginPage(url, '')) {
      kvSet('x_logged_in', '0');
      return { ...cached, loggedIn: false, url, pending: true, proxyOk: true };
    }
    if (!url.startsWith(BASE)) await browser.navigate(`${BASE}/home`);
    await browser.waitFor('[data-testid="primaryColumn"]', 20000);
    const state = await browser.evaluate(String.raw`(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      // 实测：侧栏个人资料链接的 data-testid 是 AppTabBar_Profile_Link，href=/自己的号。
      // 早前用 a[href^="/"][role=link][tabindex="-1"] 抓到的是 /i/keyboard_shortcuts——
      // 把"键盘快捷键"当成了她的账号，后面所有"这条是我发的"判断都会错位。
      const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      const handle = (profile && profile.getAttribute('href')) || '';
      const badge = document.querySelector('a[data-testid="AppTabBar_Notifications_Link"]');
      return {
        url: location.href,
        body: clean(document.body.innerText).slice(0, 300),
        hasHome: Boolean(document.querySelector('[data-testid="primaryColumn"]')),
        tweets: document.querySelectorAll('article[data-testid="tweet"]').length,
        selfHandle: handle.startsWith('/') && handle.length > 1 ? handle.slice(1) : '',
        selfName: (() => {
          // 实测侧栏账号按钮里就是两行：「nodeNetwork」+「@MetaverseTomOne」，主页上就能读到名字，
          // 不用先跑去个人主页（AccountGridItem_fullName 那个 testid 在这个版本的页面上不存在）。
          const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
          const lines = ((btn && btn.innerText) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          const at = lines.findIndex((s) => /^@\w{1,15}$/.test(s));
          return at > 0 ? lines[at - 1] : '';
        })(),
        notifyBadge: clean((badge?.getAttribute('aria-label') || badge?.innerText || '')).replace(/\D+/g, '').slice(0, 6),
      };
    })()`);
    assertXPage(state);
    const loggedIn = state.hasHome && !isXLoginPage(state.url, state.body);
    kvSet('x_logged_in', loggedIn ? '1' : '0');
    if (loggedIn && state.selfHandle) {
      kvSet('x_self_handle', state.selfHandle);
      kvSet('x_profile_url', `${BASE}/${state.selfHandle}`);
    }
    if (loggedIn && state.selfName) kvSet('x_self_name', state.selfName);
    lastCheckAt = nowIso();
    lastError = '';
    return {
      ...cached,
      loggedIn,
      browserRunning: true,
      url: state.url,
      selfHandle: state.selfHandle || cached.selfHandle,
      selfName: state.selfName || cached.selfName,
      profileUrl: loggedIn && state.selfHandle ? `${BASE}/${state.selfHandle}` : cached.profileUrl,
      notifyBadge: state.notifyBadge,
      lastError: '',
      proxyOk: true,
    };
  } catch (error) {
    noteError(error.message);
    logger.warn('X 登录状态检查失败', { error: error.message });
    return { ...cached, proxyOk: proxy.ok, error: error.message };
  }
}

async function openXLoginLocked() {
  const proxy = await requireProxy();
  // 登录就用这个带调试端口的窗口：Google 拦的是 --enable-automation 那面旗子（实测回
  // "This browser or app may not be secure"），旗子摘掉后端口本身不影响授权。
  // 这样他登完直接点「验证登录」就行，不用先关窗口——两个窗口抢同一个 profile 只会互相绊住。
  await browser.relaunch({ visible: true });
  await browser.navigate(`${BASE}/i/flow/login`);
  await browser.showWindow();
  await browser.bringToFront();
  await sleep(1500);
  lastError = '';
  return {
    ok: true,
    url: `${BASE}/i/flow/login`,
    proxy,
    hint: '登录窗口已打开（不带自动化旗子，Google 授权也能走）。登完直接点「验证登录」就行，不用关窗口。登录态只存本机 data/x-profile，不保存密码。',
  };
}

async function closeXBrowserLocked() {
  await browser.close();
  return { ok: true };
}

// ---- 读 --------------------------------------------------------------------

async function readXTimelineLocked({ tab = 'home', limit = 12, keyword = '' } = {}) {
  assertXAction('read');
  await requireProxy();
  await browser.ensure({ visible: false });
  const url = tab === 'search' && keyword
    ? `${BASE}/search?q=${encodeURIComponent(keyword)}&f=live`
    : tab === 'notifications'
      ? `${BASE}/notifications`
      : tab === 'following'
        ? `${BASE}/home?show=following`
        : `${BASE}/home`;
  await browser.navigate(url);
  await sleep(2500);
  for (let i = 0; i < 3; i += 1) {
    await browser.scroll(1200);
    await sleep(1200);
  }
  const where = tab === 'search' ? `X 搜索「${keyword}」` : tab === 'notifications' ? 'X 通知' : 'X 首页时间线';
  await assertTimelineLoaded(where);
  const items = await browser.evaluate(TWEET_SCAN);
  return items.slice(0, Math.max(1, Math.min(Number(limit) || 12, 40)));
}

// 读主页上的昵称：实测 X 已经没有 accountFullName 这个 testid，UserProfileHeader_Items 的
// 第一行是"New York, USA"（地区），document.title 也还是空的。真名字在往上两层的行列表里，
// 就排在"@handle"那一行的上面——顺带把 handle 一起读回来核对，免得把别人的名字当成她的。
const PROFILE_IDENTITY_READ = String.raw`(() => {
  const items = document.querySelector('[data-testid="UserProfileHeader_Items"]');
  const box = items && items.parentElement && items.parentElement.parentElement;
  const lines = ((box && box.innerText) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const at = lines.findIndex((s) => /^@\w{1,15}$/.test(s));
  return { name: at > 0 ? lines[at - 1] : '', handle: at >= 0 ? lines[at].slice(1) : '' };
})()`;

async function readSelfTweetsLocked(limit = 8) {
  assertXAction('read');
  await requireProxy();
  const handle = kvGet('x_self_handle') || (loadSettings().social.xOwnerHandle || '');
  if (!handle) throw new Error('还不知道她的 X 用户名（先登录一次，或在设置里填「X 用户名」）');
  await browser.ensure({ visible: false });
  await browser.navigate(`${BASE}/${handle}`);
  await sleep(2500);
  await assertTimelineLoaded(`X 主页 @${handle}`);
  // 名字只有站在她自己的主页上才读得到（侧栏那个链接的文案是"个人资料"，不是她的名字）。
  const identity = await browser.evaluate(PROFILE_IDENTITY_READ);
  const name = identity.handle && identity.handle.toLowerCase() === handle.toLowerCase() ? identity.name : '';
  if (name) kvSet('x_self_name', name);
  const items = await browser.evaluate(TWEET_SCAN);
  return { handle, name: name || kvGet('x_self_name') || '', tweets: items.filter((item) => item.handle?.toLowerCase() === handle.toLowerCase()).slice(0, Math.max(1, Math.min(limit, 20))) };
}

async function readTweetThreadLocked(href, limit = 12) {
  assertXAction('read');
  await requireProxy();
  await browser.ensure({ visible: false });
  await browser.navigate(`${BASE}${href.startsWith('/') ? href : `/${href.replace(/^https?:\/\/[^/]+/, '')}`}`);
  await sleep(2500);
  await assertTimelineLoaded('X 推文详情');
  const items = await browser.evaluate(TWEET_SCAN);
  return items.slice(0, Math.max(1, Math.min(limit, 30)));
}

async function readXFollowGraphLocked(limit = 12) {
  assertXAction('read');
  await requireProxy();
  const handle = kvGet('x_self_handle') || '';
  if (!handle) throw new Error('还不知道她的 X 用户名，先登录一次');
  await browser.ensure({ visible: false });
  const out = {};
  for (const [key, pathName] of [['following', 'following'], ['followers', 'followers']]) {
    await browser.navigate(`${BASE}/${handle}/${pathName}`);
    await sleep(2200);
    out[key] = await browser.evaluate(String.raw`(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const rows = [...document.querySelectorAll('[data-testid="UserCell"]')];
      return {
        total: clean((document.body.innerText.match(/[\d,.]+[KM]?/g) || []).find(Boolean) || ''),
        items: rows.slice(0, ${Math.max(1, Math.min(limit, 30))}).map((row) => {
          const link = row.querySelector('a[data-testid="User-Name"]') || row.querySelector('a[href^="/"]');
          const handle = ((link && link.getAttribute('href')) || '').slice(1);
          return { handle, name: clean(row.innerText).split('\n')[0], bio: clean(row.querySelector('div[data-testid="UserBio"]')?.innerText).slice(0, 120) };
        }).filter((item) => item.handle),
      };
    })()`);
  }
  return out;
}

// ---- 写：只有这一类是不可撤回的，全部要求逐字核对 ------------------------------

// 动作按钮按 testid 认，不按界面语言认：这台机器的 X 界面是中文的
// （aria 实测是「1 喜欢次数。喜欢了」），只匹配 Like/Unlike 就读不到自己刚做成的动作。
// 喜欢/转帖在"已做/未做"两种状态下 testid 不一样，所以每个动作给一对 id，
// 出现"已做"那个 id 就等于 pressed=true。
const X_ACTIONS = {
  like: { ids: ['like', 'unlike'], active: 'unlike', aria: 'Like|Unlike|喜欢|取消喜欢', label: '点赞' },
  retweet: { ids: ['retweet', 'unretweet'], active: 'unretweet', aria: 'Repost|Undo Repost|转帖|取消转帖', label: '转推' },
  reply: { ids: ['reply'], active: '', aria: 'Reply|回复', label: '回复' },
};

// 找到那条卡片上的动作按钮：只标出来并回报状态，不在页面里 click()——
// 实测 X 这套界面对合成点击完全不响应（点赞点了状态不翻、发送点了没有回复）。
function actionProbe(spec, href) {
  return String.raw`(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const ids = ${JSON.stringify(spec.ids)};
    const active = ${JSON.stringify(spec.active)};
    const cards = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const card = cards.find((c) => {
      const a = c.querySelector('a[href*="/status/"]');
      return a && a.getAttribute('href').includes(${JSON.stringify(String(href || ''))});
    });
    if (!card) return { found: false, reason: '找不到那条推文' };
    let button = null;
    for (const id of ids) {
      button = card.querySelector('[data-testid="' + id + '"]');
      if (button) break;
    }
    if (!button) {
      button = [...card.querySelectorAll('button')].find((b) => new RegExp(${JSON.stringify(spec.aria)}, 'i').test(b.getAttribute('aria-label') || ''));
    }
    if (!button) return { found: false, reason: '那条推文上没有这个按钮' };
    const testid = button.getAttribute('data-testid') || '';
    return {
      found: true,
      testid,
      pressed: Boolean(active) && testid === active,
      label: clean(button.getAttribute('aria-label')),
      count: Number(clean(button.innerText).replace(/[^\d]/g, '') || '0'),
    };
  })()`;
}

async function clickTweetActionLocked(href, kind) {
  const spec = X_ACTIONS[kind] || { ids: [kind], active: '', aria: kind };
  const state = await browser.evaluate(actionProbe(spec, href), { timeoutMs: 45000 });
  if (!state.found) return { ok: false, reason: state.reason };
  const marked = await browser.evaluate(String.raw`(() => {
    const cards = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const card = cards.find((c) => (c.querySelector('a[href*="/status/"]')?.getAttribute('href') || '').includes(${JSON.stringify(String(href || ''))}));
    if (!card) return false;
    let button = null;
    for (const id of ${JSON.stringify(spec.ids)}) { button = card.querySelector('[data-testid="' + id + '"]'); if (button) break; }
    if (!button) button = [...card.querySelectorAll('button')].find((b) => new RegExp(${JSON.stringify(spec.aria)}, 'i').test(b.getAttribute('aria-label') || ''));
    if (!button) return false;
    button.setAttribute('data-bizhi-target', 'action');
    return true;
  })()`);
  if (!marked) return { ok: false, reason: '那条推文上没有这个按钮' };
  // 真鼠标事件点在标出来的那颗按钮上（合成 click() 实测不生效）。
  if (!(await browser.clickAt('[data-bizhi-target="action"]'))) return { ok: false, reason: '按钮点不到（位置或尺寸读不到）' };
  return { ok: true, label: state.label, pressed: state.pressed };
}

// 动作前先站到那条推文自己的页面上：卡片一定在眼前，回复/点赞不用赌时间线还在不在。
function threadPath(href) {
  const value = String(href || '');
  return `${BASE}${value.startsWith('/') ? value : `/${value.replace(/^https?:\/\/[^/]+/, '')}`}`;
}

async function openTweet(thread) {
  await browser.navigate(thread);
  await sleep(2500);
  await assertTimelineLoaded('X 推文详情');
}

async function reactXLocked(href, kind = 'like') {
  assertXAction(kind);
  await requireProxy();
  const spec = X_ACTIONS[kind];
  if (!spec) throw new Error(`不支持的动作：${kind}`);
  await openTweet(threadPath(href));
  const before = await browser.evaluate(actionProbe(spec, href));
  if (!before.found) throw new Error(before.reason || '页面上找不到那条推文，这次没点赞/转推');
  if (before.pressed) return { ok: true, already: true };
  const clicked = await clickTweetActionLocked(href, kind);
  if (!clicked.ok) throw new Error(clicked.reason || `${spec.label}按钮没点到`);
  await sleep(1500);
  if (kind === 'retweet') {
    const confirmed = await browser.evaluate(String.raw`(() => {
      const b = [...document.querySelectorAll('[data-testid="retweetConfirm"]')];
      if (!b.length) return false;
      b[b.length - 1].click();
      return true;
    })()`);
    if (!confirmed) throw new Error('转推弹层里的确认按钮没找到，这次没转');
    await sleep(1500);
  }
  const after = await browser.evaluate(actionProbe(spec, href));
  if (!after.found) throw new Error('点完之后页面状态读不到了，这次不算做成');
  assertXReactEvidence({ before: true, after: after.pressed, pressed: after.pressed, countDelta: after.count - before.count });
  return { ok: true, already: false, kind, label: after.label };
}

// X 的输入框是 Draft.js，里面会夹零宽占位符、软连字符、方向标记这类看不见的字符。
// 拿 innerText 和原文逐字 !== 比，会把"其实已经打对了"判成没打上，于是再打一遍——
// 实测同一句话出现在输入框里两次，整条作废。
const INVISIBLE = /[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

export function normalizeTyped(text) {
  return String(text || '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

// 说清"差在第几个字"：线上只看到两句前缀相同的话，永远猜不到是中间哪个字符不对。
export function firstDifference(expected, actual) {
  const a = normalizeTyped(expected);
  const b = normalizeTyped(actual);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (i === a.length && i === b.length) return '';
  return `第 ${i + 1} 个字起不一样：期望「${a.slice(i, i + 12)}」实际「${b.slice(i, i + 12)}」`;
}

// 四个动作共用同一段页面脚本（读/粘贴/点发送/标焦点），因为"挑哪个框"只能有一份答案：
// 实测点回复后地址是 https://x.com/compose/post，输入框 tweetTextarea_0 不在任何 [role="dialog"] 里；
// 只认弹层就"找不到输入框"，只认 querySelector 的第一个又会抓到主页顶部的发帖框。
// 规矩：弹层里有就用弹层的，没有就用页面上最后长出来的那一个（新页/新弹层总在后面）。
//
// 输入方式只认粘贴：在真页面上试过四种——真鼠标点 + Input.insertText（空的）、
// execCommand('insertText')（空的）、逐字符键盘事件（空的）、派发 ClipboardEvent('paste')
// 带 DataTransfer（出现了"测试文字甲乙丙"）。X 的编辑器是 Slate，只接粘贴通道。
function composerState(action, text = '') {
  return String.raw`(() => {
    const pickBox = () => {
      const inDialog = document.querySelector('[role="dialog"] div[data-testid="tweetTextarea_0"]');
      if (inDialog) return inDialog;
      const all = [...document.querySelectorAll('div[data-testid="tweetTextarea_0"]')];
      return all.length ? all[all.length - 1] : null;
    };
    const pickButton = () => {
      for (const id of ['tweetButton', 'tweetButtonInline']) {
        const inDialog = document.querySelector('[role="dialog"] button[data-testid="' + id + '"]');
        if (inDialog) return inDialog;
      }
      for (const id of ['tweetButton', 'tweetButtonInline']) {
        const all = [...document.querySelectorAll('button[data-testid="' + id + '"]')];
        if (all.length) return all[all.length - 1];
      }
      return null;
    };
    const clean = (s) => (s || '').replace(/[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    const box = pickBox();
    const btn = pickButton();
    // 把我们真正选中的那两个元素标出来，Node 侧后续动作要用同一个，不能再查一次选择器。
    if (box) box.setAttribute('data-bizhi-target', 'composer');
    if (btn) btn.setAttribute('data-bizhi-target', 'send');
    const did = ${JSON.stringify(action)};
    // 发送这里只标出按钮，真点由 Node 侧用可信鼠标事件做（合成 click() 在这套页面上不生效，
    if (did === 'paste' && box) {
      box.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(String(text || ''))});
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    return {
      text: clean(box?.innerText),
      found: Boolean(box),
      ready: Boolean(btn && !btn.disabled),
      sendLabel: clean(btn?.innerText) || clean(btn?.getAttribute('aria-label')),
      acted: did === 'read' ? true : Boolean(did === 'paste' ? box : btn),
      risky: /限流|频繁|Something went wrong/i.test(clean(document.body.innerText)),
    };
  })()`;
}

const composerRead = () => composerState('read');
const composerPaste = (text) => composerState('paste', text);
const composerSend = () => composerState('send');

// 私信的输入框是另一个 testid，但同样只认粘贴（同一个 Slate 编辑器）。
const composerPasteDm = (text) => String.raw`(() => {
  const box = document.querySelector('div[data-testid="dm-composer-rte-pillbox"], div[role="textbox"][data-testid*="dm"]');
  if (!box) return false;
  box.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', ${JSON.stringify(String(text || ''))});
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return true;
})()`;

// Draft.js 把打进去的字要下一帧才挂到 DOM 上：先等 900ms、再等 4 秒都读到过"空的"，
// 于是代码以为没落字、又打一遍——实测框里成了同一句话两遍。
// 规矩：一句话只打一次，打之前要求那个框是空的，打之后等到出现字为止；对不上就报出差异然后放弃。
async function readComposerUntil(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let read = { text: '', found: false, ready: false, risky: false };
  for (;;) {
    read = await browser.evaluate(composerRead());
    if (normalizeTyped(read.text) || Date.now() >= deadline) return read;
    await sleep(400);
  }
}

// 回复的送达证据：在原推文下面，找"她账号发的、逐字相同的那一条"。
// 值必须在建串时就变成字面量——页面里没有 Node 的变量，写进去就是 ReferenceError。
function replyProof(content, handle) {
  return String.raw`(() => {
    const clean = (s) => (s || '').replace(/[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    const want = ${JSON.stringify(content)};
    const mine = '[data-testid="User-Name"]';
    const cards = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const own = cards.filter((c) => clean(c.querySelector(mine)?.innerText).toLowerCase().includes(${JSON.stringify(`@${handle}`.toLowerCase())}));
    // X 把回复开头的 @对方 也放进正文里；核对时把最前面那串提及去掉，正文本身仍要逐字相同。
    const stripMentions = (s) => s.replace(/^(?:@\w{1,15}\s+)+/, '');
    const texts = own.map((c) => stripMentions(clean(c.querySelector('[data-testid="tweetText"]')?.innerText)));
    return {
      found: texts.includes(want),
      text: texts.find((t) => t === want) || '',
      mineCount: own.length,
      risky: /限流|频繁|Something went wrong|Verify you are human/i.test(clean(document.body.innerText)),
    };
  })()`;
}

async function replyToTweetLocked(href, text) {
  const content = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 260);
  if (!content) throw new Error('回复内容为空');
  assertXAction('reply');
  const gate = assertPublicContent(content, { settings: loadSettings(), hisMessages: recentUserMessages(60) });
  if (!gate.ok) {
    addEvent('x_reply_blocked', '她想发的回复里有不该公开的内容，闸门拦下了', { reason: gate.reason });
    throw new Error(`这条不能公开写：${gate.reason}`);
  }
  const handle = kvGet('x_self_handle') || '';
  if (!handle) throw new Error('还不知道她的 X 用户名（先点「验证登录」），没法核实回复真的发出去了');
  await requireProxy();
  // 每条动作都从"那条推文自己的页面"开始：弹层/整页回复会把标签页带到别处，
  // 下一次再回时间线找卡片就成了"找不到那条推文"（实测连着三条都是这个错）。
  const thread = threadPath(href);
  await openTweet(thread);
  const opened = await clickTweetActionLocked(href, 'reply');
  if (!opened.ok) throw new Error(opened.reason || '回复按钮没点到');
  // 弹层里的输入框是异步挂出来的：实测点完 1.5 秒还没有，硬往下走就变成"回复没有真的填进去"。
  // 只认弹层里那个框（[role=dialog] 下面）——不带范围的那句 querySelector 抓到的是主页发帖框。
  if (!(await browser.waitFor('div[data-testid="tweetTextarea_0"]', 9000))) {
    // 这一条现在是"失败但不说话"：报出页面到底有什么，下一次自动尝试自己就能告诉我们
    // 回复框到底挂在哪儿（弹层几个、页面上有几个输入框、地址是什么），不用再靠人手去点一遍。
    const where = await browser.evaluate(String.raw`(() => ({
      url: location.href,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      boxes: [...document.querySelectorAll('div[role="textbox"][data-testid]')].map((b) => b.getAttribute('data-testid')).slice(0, 6),
    }))()`).catch(() => ({ url: '', dialogs: -1, boxes: [] }));
    throw new Error(`回复弹层里没有长出输入框，这次没回（地址 ${String(where.url).slice(0, 40)}；弹层 ${where.dialogs} 个；页面上的输入框 ${where.boxes.join('、') || '无'}）`);
  }
  const before = await browser.evaluate(composerRead());
  if (!before.found) throw new Error('回复弹层里的输入框找不到了，这次没回');
  if (normalizeTyped(before.text)) throw new Error(`回复的输入框里已经有别的内容，这次没往里打字（${before.text.slice(0, 40)}）`);
  await browser.evaluate(composerPaste(content));
  const readback = await readComposerUntil();
  if (normalizeTyped(readback.text) !== content) throw new Error(`回复没有真的填进去（${firstDifference(content, readback.text)}；读到：${readback.text.slice(0, 40)}）`);
  if (!readback.ready) throw new Error('回复按钮还是灰的，这次没发');
  // 发出去之前确认这一页真的在"回复"：实测点回复后落在 /compose/post，那颗按钮写的是"发帖"。
  // 分不清就把一句心里话发成他账号上的一条独立推文——这种事一次都不能错。
  if (!/回复|reply/i.test(readback.sendLabel || '')) {
    throw new Error(`这一页的发送按钮写的是「${readback.sendLabel || '空'}」，不是回复；她停手了，没把这句话当成新推文发出去`);
  }
  // 发送要用可信鼠标事件：合成 click() 在这页上点了没反应（实测粘贴成功、按钮不灰、点完没有回复）。
  if (!(await browser.evaluate(composerSend()))) throw new Error('没找到回复的发送按钮，这次没发');
  if (!(await browser.clickAt('[data-bizhi-target="send"]'))) throw new Error('发送按钮点不到（可能已被页面挪走了），这次没发');
  await sleep(3000);
  // 弹层一关，新回复不会留在她刚才刷的时间线上——原地数卡片证明不了发出去了
  // （实测今天两次"没核实成功"就是这么来的）。回到那条推文下面，按她的账号逐字核对。
  await browser.navigate(thread);
  let after = { found: false, text: '', mineCount: 0, risky: false };
  for (let i = 0; i < 6 && !after.found; i += 1) {
    after = await browser.evaluate(replyProof(content, handle));
    if (!after.found) await sleep(1500);
  }
  if (!after.found) {
    // 核不到就把"那一下到底点在哪"一起报出来：现在只知道粘贴成功、按钮不灰、标签是"回复"，
    // 但原推文下面还是 0 回复——下一步要分清是点到了别的弹层，还是根本没提交。
    const where = await browser.evaluate(String.raw`(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const btn = document.querySelector('[data-bizhi-target="send"]');
      const r = btn ? btn.getBoundingClientRect() : null;
      const spot = btn ? (btn.getAttribute('data-testid') || '无名') + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' @' + Math.round(r.x) + ',' + Math.round(r.y) : '（没了）';
      return {
        url: location.href,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        button: spot,
        hint: clean(document.body.innerText).slice(0, 60),
      };
    })()`).catch(() => ({ url: '', dialogs: -1, button: '读不到', hint: '' }));
    // 框里还剩什么，用同一份挑框逻辑读，不再自己写一遍选择器（写过一次，挑到的是主页发帖框）
    const left = await browser.evaluate(composerRead()).catch(() => ({ text: '' }));
    throw new DeliveryUnknownError(`回到那条推文下面没读到她的回复（现在在 ${String(where.url).slice(0, 44)}；弹层 ${where.dialogs} 个；框里还剩「${normalizeTyped(left.text).slice(0, 24)}」；发送按钮 ${where.button}；页面开头「${where.hint}」）：这条状态未知，别重复点`);
  }
  assertXReplyEvidence({ ...after, content, handle });
  return { ok: true, verified: true, chars: content.length };
}

// 发推：只填不发。真发必须走 publishFilledXPost（界面上他点一下"发布"）。
async function fillXPostLocked({ text = '' } = {}) {
  const content = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 260);
  if (!content) throw new Error('要发的内容不能为空');
  assertXAction('read');
  const gate = assertPublicContent(content, { settings: loadSettings(), hisMessages: recentUserMessages(60) });
  if (!gate.ok) {
    addEvent('x_post_blocked', '这条她想过，但里面有不该公开的内容', { reason: gate.reason });
    throw new Error(`这条不能公开写：${gate.reason}`);
  }
  await requireProxy();
  await browser.ensure({ visible: false });
  if (!/\/home/.test(await browser.getUrl())) await browser.navigate(`${BASE}/home`);
  await sleep(1800);
  const opened = await browser.evaluate(String.raw`(() => {
    const box = document.querySelector('div[data-testid="tweetTextarea_0"]');
    if (box) { box.click(); return true; }
    const post = document.querySelector('[data-testid="tweetButtonInline"]');
    if (post) { post.click(); return false; }
    return false;
  })()`);
  await sleep(900);
  const box = await browser.evaluate(String.raw`(() => Boolean(document.querySelector('div[data-testid="tweetTextarea_0"]')))`);
  if (!box) throw new Error('找不到 X 的发文输入框（页面可能改版了），这次没填');
  await browser.evaluate(composerPaste(content));
  const readback = await readComposerUntil();
  if (normalizeTyped(readback.text) !== content) throw new Error(`内容没有真的填进去（${firstDifference(content, readback.text)}；读到：${readback.text.slice(0, 40)}）`);
  if (readback.risky) throw new Error('X 页面有限流/报错提示，这次没有填稿');
  const id = hashText(`${kvGet('x_self_handle')}|${content}`);
  kvSetJson('x_last_fill', { id, handle: kvGet('x_self_handle'), text: content, at: nowIso() });
  logger.info('X 稿子已填进输入框（没发）', { chars: content.length, openedBox: Boolean(opened) });
  return { ok: true, filled: true, published: false, fillId: id, chars: content.length, ready: readback.ready, at: nowIso() };
}

async function publishFilledXPostLocked({ fillId = '' } = {}) {
  const fill = kvGetJson('x_last_fill', null);
  if (!fill?.text) throw new Error('没有她刚填好的稿子记录，先填一遍再发');
  if (fillId && fill.id !== fillId) throw new Error('稿子记录与要发的不是同一条，重新填');
  if (Date.now() - new Date(fill.at).getTime() > 15 * 60000) throw new Error('稿子填好超过 15 分钟，重新填一次再发（别把输入框里的旧内容发出去）');
  assertXAction('read');
  const gate = assertPublicContent(fill.text, { settings: loadSettings(), hisMessages: recentUserMessages(60) });
  if (!gate.ok) throw new Error(`这条不能公开写：${gate.reason}`);
  const dayKey = `x_post_day:${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())}`;
  const max = Number(loadSettings().social.xDailyPostMax || 0);
  if (Number(kvGet(dayKey, '0')) >= max) throw new Error(`今天发推次数已到上限（${max} 条）`);
  await requireProxy();
  const actual = await browser.evaluate(composerRead());
  if (normalizeTyped(actual.text) !== normalizeTyped(fill.text)) throw new Error('输入框里的内容和确认要发的不一致，没有发');
  if (!actual.ready) throw new Error('发送按钮还是灰的，没有发');
  if (actual.risky) throw new Error('X 页面提示限流/出错，这次没有发');
  const effectKey = `effect:x:post:${fill.id}`;
  const operation = beginEffect(effectKey);
  if (!operation.started) return { ...operation.receipt, already: true };
  const beforeCount = await browser.evaluate(String.raw`document.querySelectorAll('article[data-testid="tweet"]').length`);
  await browser.evaluate(composerSend());
  await sleep(3500);
  const after = await browser.evaluate(String.raw`(({ text, beforeCount }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const texts = [...document.querySelectorAll('[data-testid="tweetText"]')].map((e) => clean(e.innerText));
    return {
      count: document.querySelectorAll('article[data-testid="tweet"]').length,
      beforeCount,
      outgoing: texts.includes(text),
      text,
      editorEmpty: !clean(document.querySelector('div[data-testid="tweetTextarea_0"]')?.innerText),
      risky: /限流|频繁|Something went wrong/i.test(clean(document.body.innerText)),
    };
  })({ text: ${JSON.stringify(fill.text)}, beforeCount: ${JSON.stringify(beforeCount)} })`);
  try {
    assertXDeliveryEvidence({ beforeCount: after.beforeCount, afterCount: after.count, outgoing: after.outgoing || after.editorEmpty, content: fill.text, text: after.text, state: after });
  } catch (error) {
    // 输入框清空 + 页面上能读到原文，是 X 发成功最常见的证据形态；两者都不满足才算未知
    if (!(after.editorEmpty && !after.risky)) {
      failEffect(effectKey, error);
      throw error;
    }
  }
  kvSet(dayKey, String(Number(kvGet(dayKey, '0')) + 1));
  kvSet('x_last_publish_at', nowIso());
  kvSetJson('x_last_fill', null);
  finishEffect(effectKey, { ok: true, published: true, chars: fill.text.length });
  addEvent('x_post', '她发了一条推特', { chars: fill.text.length, verified: after.outgoing });
  return { ok: true, published: true, at: nowIso(), chars: fill.text.length };
}

// 私信/关注：默认只做到"填好/找到按钮"，不点最后那一下。
async function prepareXDmLocked(handle, text) {
  const content = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!content) throw new Error('私信内容为空');
  assertXAction('dmDraft');
  const gate = assertPublicContent(content, { settings: loadSettings(), hisMessages: recentUserMessages(60) });
  if (!gate.ok) throw new Error(`这条不能公开写：${gate.reason}`);
  await requireProxy();
  await browser.ensure({ visible: false });
  await browser.navigate(`${BASE}/messages/compose?recipient_ids=`);
  await sleep(2000);
  const filled = await browser.evaluate(String.raw`(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const box = document.querySelector('div[data-testid="dm-composer-rte-pillbox"], div[role="textbox"][data-testid*="dm"]');
    if (!box) return { ok: false, reason: '找不到私信输入框' };
    box.focus();
    return { ok: true, before: clean(box.innerText), hasRecipient: Boolean(document.querySelector('[data-testid="dm-composer-recipient"]')) };
  })()`);
  if (!filled.ok) throw new Error(filled.reason || '私信页面没打开');
  await browser.evaluate(composerPasteDm(content));
  await sleep(600);
  const readback = await browser.evaluate(String.raw`(({ content }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const box = document.querySelector('div[data-testid="dm-composer-rte-pillbox"], div[role="textbox"][data-testid*="dm"]');
    return { text: clean(box?.innerText), expected: content };
  })({ content: ${JSON.stringify(content)} })`);
  if (normalizeTyped(readback.text) !== normalizeTyped(readback.expected)) throw new Error('私信内容没有真的填进去');
  addEvent('x_dm_draft', '她写好一条私信草稿，等你点发送', { handle, chars: content.length });
  return { ok: true, drafted: true, sent: false, handle, chars: content.length, hint: '私信只填不发：在登录窗口里确认后自己点发送' };
}

async function locateXFollowLocked(handle) {
  assertXAction('followDraft');
  await requireProxy();
  await browser.ensure({ visible: false });
  await browser.navigate(`${BASE}/${String(handle || '').replace(/^@/, '')}`);
  await sleep(2200);
  const state = await browser.evaluate(String.raw`(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const btn = document.querySelector('[data-testid="FollowButton"], [data-testid="Follow"], button[aria-label^="Follow"]');
    return {
      url: location.href,
      name: '',
      bio: clean(document.querySelector('[data-testid="accountBio"]')?.innerText).slice(0, 140),
      followers: clean((document.body.innerText.match(/[\d,.]+[KM]? Following|[\d,.]+[KM]? Followers/gi) || []).join(' | ')),
      followable: Boolean(btn && !btn.disabled && /Follow/i.test(btn.innerText || btn.getAttribute('aria-label') || '')),
      risky: /Something went wrong|限流/i.test(clean(document.body.innerText)),
    };
  })()`);
  assertXPage(state);
  state.name = (await browser.evaluate(PROFILE_IDENTITY_READ)).name || '';
  return state;
}

// ---- 导出（全部走同一把锁，浏览器动作不许并发） --------------------------------

const wrap = (fn) => (...args) => withXBrowser(() => fn(...args));

export const xStatus = wrap(xStatusLocked);
export const openXLogin = wrap(openXLoginLocked);
export const closeXBrowser = wrap(closeXBrowserLocked);
export const readXTimeline = wrap(readXTimelineLocked);
export const readSelfTweets = wrap(readSelfTweetsLocked);
export const readTweetThread = wrap(readTweetThreadLocked);
export const readXFollowGraph = wrap(readXFollowGraphLocked);
export const reactXTweet = wrap(reactXLocked);
export const replyXTweet = wrap(replyToTweetLocked);
export const fillXPost = wrap(fillXPostLocked);
export const publishFilledXPost = wrap(publishFilledXPostLocked);
export const prepareXDm = wrap(prepareXDmLocked);
export const locateXFollow = wrap(locateXFollowLocked);

export function readCachedXStats() {
  return {
    loggedIn: kvGet('x_logged_in') === '1',
    selfHandle: kvGet('x_self_handle') || '',
    profileUrl: kvGet('x_profile_url') || '',
    lastPublishAt: kvGet('x_last_publish_at') || '',
    cooldownUntil: xCooldownUntil(),
    lastCheckAt,
    lastError,
    proxy: env.xProxy,
    profileDir: path.relative(paths.root, paths.xProfile).split(path.sep).join('/'),
    browserAliveFile: fs.existsSync(paths.xProfile),
  };
}

export function recordXActivity(entry = {}) {
  const item = {
    at: entry.at || nowIso(),
    type: String(entry.type || '').slice(0, 24),
    text: String(entry.text || '').slice(0, 200),
    target: String(entry.target || '').slice(0, 60),
    note: String(entry.note || '').slice(0, 80),
    ok: entry.ok !== false,
  };
  if (!item.type) return item;
  const floor = new Date(Date.now() - 7 * 86400000).toISOString();
  const list = kvGetJson('x_activity', []).filter((x) => x && x.at >= floor);
  list.push(item);
  kvSetJson('x_activity', list.slice(-200));
  return item;
}

export function getRecentXActivity({ hours = 48, limit = 8 } = {}) {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  return kvGetJson('x_activity', [])
    .filter((x) => x && x.at >= cutoff)
    .slice(-limit)
    .reverse();
}

export function newXActivityId() {
  return randomUUID();
}
