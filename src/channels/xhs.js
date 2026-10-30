import { randomUUID } from 'node:crypto';
import { assertXhsAction, isOwnerConversation, assertXhsPage, assertDeliveryEvidence } from './xhs-safety.js';
import { beginEffect, finishEffect, failEffect, DeliveryUnknownError } from '../effects.js';
import fs from 'node:fs';
import path from 'node:path';
import { loadSettings, paths } from '../config.js';
import { addEvent, kvDeletePrefix, kvGet, kvGetJson, kvSet, kvSetJson, recentUserMessages } from '../db.js';
import { logger } from '../logger.js';
import { assertPublicContent } from '../privacy.js';
import { nowIso, sleep, hashText } from '../util.js';
import { CdpBrowser } from '../browser/cdp.js';
import { SerialQueue } from '../serial.js';

const BASE = 'https://www.xiaohongshu.com';
const CREATOR_BASE = 'https://creator.xiaohongshu.com';
const browser = new CdpBrowser({ port: 9333, profileDir: paths.xhsProfile, visible: false });
let lastError = '';
let lastCheckAt = null;
let lastQrValue = '';
let lastQrAt = 0;
let manualWindow = false;

function loggedInCache() {
  return kvGet('xhs_logged_in') === '1';
}

function ownerInfo() {
  const social = loadSettings().social || {};
  return {
    ownerName: String(social.xhsOwnerName || ''),
    ownerUserId: String(social.xhsOwnerUserId || ''),
  };
}

export function xhsLastError() {
  return lastError;
}

async function pageLoginState() {
  await browser.ensure({ visible: false });
  const currentUrl = await browser.getUrl().catch(() => '');
  if (!currentUrl.startsWith(BASE)) await browser.navigate(`${BASE}/explore`);
  const state = await browser.evaluate(`(() => ({
    url: location.href,
    title: document.title,
    body: (document.body.innerText || '').slice(0, 200)
  }))()`, { timeoutMs: 45000 });
  const loggedIn = !String(state.url).includes('/login') && !/登录后|扫码登录|手机号登录/.test(state.body);
  assertXhsPage({ ...state, login: !loggedIn });
  kvSet('xhs_logged_in', loggedIn ? '1' : '0');
  lastCheckAt = nowIso();
  return { ...state, loggedIn };
}

async function xhsBrowserStatusLocked({ verify = false } = {}) {
  const running = await browser.alive();
  if (!verify && !running) {
    return {
      configured: Boolean(ownerInfo().ownerName || loggedInCache()),
      loggedIn: loggedInCache(),
      browserRunning: false,
      ownerName: ownerInfo().ownerName,
      ownerUserId: ownerInfo().ownerUserId,
      selfName: kvGet('xhs_self_name') || '',
      selfUserId: kvGet('xhs_self_user_id') || '',
      profileUrl: kvGet('xhs_profile_url') || '',
      lastCheckAt,
      lastError,
    };
  }
  try {
    await browser.ensure({ visible: false });
    const currentUrl = await browser.getUrl();
    const onLogin = String(currentUrl).includes('/login');
    if (!verify) {
      const definitelyLoggedIn =
        loggedInCache() ||
        /\/notification|\/user\/profile\/|\/chat/.test(String(currentUrl));
      lastCheckAt = nowIso();
      return {
        configured: Boolean(ownerInfo().ownerName || definitelyLoggedIn),
        loggedIn: definitelyLoggedIn,
        browserRunning: true,
        ownerName: ownerInfo().ownerName,
        ownerUserId: ownerInfo().ownerUserId,
        selfName: kvGet('xhs_self_name') || '',
        selfUserId: kvGet('xhs_self_user_id') || '',
        profileUrl: kvGet('xhs_profile_url') || '',
        lastCheckAt,
        lastError: '',
        url: currentUrl,
        pending: onLogin,
      };
    }
    if (onLogin) {
      // 登录页可能正在展示二维码/等待手机确认，绝不能导航走，否则二维码会失效。
      lastCheckAt = nowIso();
      return {
        configured: Boolean(ownerInfo().ownerName || loggedInCache()),
        loggedIn: false,
        browserRunning: true,
        ownerName: ownerInfo().ownerName,
        ownerUserId: ownerInfo().ownerUserId,
        selfName: kvGet('xhs_self_name') || '',
        selfUserId: kvGet('xhs_self_user_id') || '',
        profileUrl: kvGet('xhs_profile_url') || '',
        lastCheckAt,
        lastError: '',
        url: currentUrl,
        pending: true,
      };
    }
    const state = await pageLoginState();
    lastError = '';
    return {
      configured: Boolean(ownerInfo().ownerName || state.loggedIn),
      loggedIn: state.loggedIn,
      browserRunning: true,
      ownerName: ownerInfo().ownerName,
      ownerUserId: ownerInfo().ownerUserId,
      selfName: kvGet('xhs_self_name') || '',
      selfUserId: kvGet('xhs_self_user_id') || '',
      profileUrl: kvGet('xhs_profile_url') || '',
      lastCheckAt,
      lastError,
      url: state.url,
    };
  } catch (error) {
    lastError = error.message;
    logger.warn('小红书登录检查失败', { error: error.message });
    return {
      configured: Boolean(ownerInfo().ownerName || loggedInCache()),
      loggedIn: loggedInCache(),
      browserRunning: await browser.alive(),
      ownerName: ownerInfo().ownerName,
      ownerUserId: ownerInfo().ownerUserId,
      selfName: kvGet('xhs_self_name') || '',
      selfUserId: kvGet('xhs_self_user_id') || '',
      profileUrl: kvGet('xhs_profile_url') || '',
      lastCheckAt,
      lastError,
    };
  }

}

async function openXhsLoginLocked() {
  await browser.relaunch({ visible: true });
  manualWindow = true;
  await browser.navigate(`${BASE}/login`);
  await browser.showWindow();
  await browser.bringToFront();
  await sleep(500);
  lastError = '';
  return xhsBrowserStatus({ verify: true });
}

async function verifyXhsLoginLocked() {
  return xhsBrowserStatus({ verify: true });
}

async function getXhsLoginQrLocked({ force = false } = {}) {
  await browser.ensure({ visible: false });
  if (force) manualWindow = false;
  if (!manualWindow) await browser.hideWindow();
  let url = await browser.getUrl();
  const stale = !lastQrAt || Date.now() - lastQrAt > 110000;
  if (force || stale) {
    await browser.navigate(`${BASE}/login`);
    lastQrValue = '';
    lastQrAt = Date.now();
    url = await browser.getUrl();
  }
  if (!String(url).includes('/login')) {
    const status = await xhsBrowserStatus({ verify: true });
    if (status.loggedIn) {
      lastQrValue = '';
      lastQrAt = 0;
      manualWindow = false;
      return { loggedIn: true };
    }
    await browser.navigate(`${BASE}/login`);
    url = await browser.getUrl();
  }
  if (String(url).includes('/login')) {
    await browser.waitFor('img.qrcode-img', 8000);
  }
  if (!String(url).includes('/login')) {
    await browser.navigate(`${BASE}/explore`);
    try {
      await browser.click('#login-btn');
    } catch {
      // 页面可能已经弹出登录层
    }
    await browser.waitFor('img.qrcode-img', 8000);
  }
  const dataUrl = await browser.evaluate(
    `(document.querySelector('img.qrcode-img')?.src || '')`,
    { timeoutMs: 45000 },
  );
  if (!dataUrl) return { loggedIn: false, dataUrl: '', hint: '登录二维码还没有加载出来' };
  if (!force && dataUrl === lastQrValue && stale) {
    await browser.navigate(`${BASE}/login`);
    await browser.waitFor('img.qrcode-img', 8000);
    const fresh = await browser.evaluate(`(document.querySelector('img.qrcode-img')?.src || '')`, { timeoutMs: 45000 });
    if (fresh) {
      lastQrValue = fresh;
      lastQrAt = Date.now();
      return { loggedIn: false, dataUrl: fresh, url: await browser.getUrl() };
    }
  }
  lastQrValue = dataUrl;
  lastQrAt = Date.now();
  return { loggedIn: false, dataUrl, url: await browser.getUrl() };
}

async function fetchXhsFeedLocked({ limit = 12, keyword = '' } = {}) {
  assertXhsAction('read');
  const login = await pageLoginState();
  if (!login.loggedIn) throw new Error('小红书还没有登录，请先在设置里打开登录窗口扫码');
  const url = keyword
    ? `${BASE}/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`
    : `${BASE}/explore`;
  await browser.navigate(url);
  if (!(await browser.waitFor('section.note-item', 20000))) throw new Error('笔记列表未加载，不能当作空列表');
  for (let i = 0; i < 2; i += 1) {
    await browser.scroll(900);
    await sleep(900);
  }
  const state = await browser.evaluate(`(() => ({
    loginButton: Boolean(document.querySelector('#login-btn, .side-bar .login-btn')),
    cards: [...document.querySelectorAll('section.note-item')].map((card) => {
      const cover = card.querySelector('a.cover');
      const title = card.querySelector('a.title');
      const author = card.querySelector('a.author');
      return {
        noteId: card.getAttribute('data-note-id') || '',
        href: cover?.getAttribute('href') || '',
        title: (title?.innerText || '').trim(),
        author: (card.querySelector('.author .name')?.innerText || '').trim(),
        authorHref: author?.getAttribute('href') || '',
        likes: (card.querySelector('.count')?.innerText || '').trim()
      };
    }).filter((item) => item.noteId && item.href)
  }))()`);
  if (state.loginButton) {
    kvSet('xhs_logged_in', '0');
    throw new Error('小红书还没有登录，请先在设置里打开登录窗口扫码');
  }
  kvSet('xhs_logged_in', '1');
  const seen = new Set();
  return state.cards
    .map((item) => ({ ...item, href: new URL(item.href, BASE).href }))
    .filter((item) => {
      if (seen.has(item.noteId)) return false;
      seen.add(item.noteId);
      return true;
    })
    .slice(0, limit);
}

async function fetchXhsNoteLocked(href) {
  assertXhsAction('read');
  if (!href) throw new Error('缺少笔记地址');
  await browser.navigate(href);
  if (!(await browser.waitFor('#noteContainer', 20000))) throw new Error('笔记详情未加载');
  return browser.evaluate(`(() => {
    const root = document.getElementById('noteContainer');
    const comments = [...(root?.querySelectorAll('.comment-item') || [])].slice(0, 12).map((item, index) => ({
      index,
      id: item.id || '',
      author: (item.querySelector('.author .name')?.innerText || '').trim(),
      authorId: item.querySelector('.author .name')?.getAttribute('data-user-id') || item.querySelector('.avatar a')?.getAttribute('data-user-id') || '',
      content: (item.querySelector('.content .note-text')?.innerText || '').trim(),
      isReply: item.classList.contains('comment-item-sub')
    })).filter((item) => item.content);
    return {
      url: location.href,
      title: (document.getElementById('detail-title')?.innerText || '').trim(),
      desc: (document.getElementById('detail-desc')?.innerText || '').trim(),
      author: (root?.querySelector('.author .name')?.innerText || '').trim(),
      authorId: root?.querySelector('.author .name')?.getAttribute('data-user-id') || '',
      comments,
      text: (root?.innerText || '').slice(0, 4000),
      hasLoginButton: Boolean(document.querySelector('#login-btn, .side-bar .login-btn'))
    };
  })()`);
}

async function postXhsCommentLocked(text) {
  assertXhsAction('comment');
  const content=String(text||'').trim();
  if (!content || content.length > 180) throw new Error('评论需要 1–180 字');
  const gate=assertPublicContent(content,{settings:loadSettings(),hisMessages:recentUserMessages(60)});
  if(!gate.ok)throw new Error('这条不能公开写：'+gate.reason);
  const count=()=>browser.evaluateFunction((text)=>[...document.querySelectorAll('#noteContainer .comment-item')].filter(el=>(el.querySelector('.note-text')?.innerText||'').trim()===text).length,[content]);
  const before=await count();
  const key='effect:xhs:comment:'+hashText((await browser.getUrl())+'|'+content);
  const operation=beginEffect(key);if(!operation.started)return {...operation.receipt,already:true};
  try {
    await browser.type('#content-textarea',content);
    const ready=await browser.evaluateFunction(()=>Boolean(document.querySelector('#noteContainer .btn.submit')&&!document.querySelector('#noteContainer .btn.submit').disabled));
    if(!ready)throw new Error('评论按钮不可用');
    assertXhsAction('comment');
    await browser.click('#noteContainer .btn.submit');
    for(let i=0;i<15;i++){
      await sleep(200);
      const page=await browser.evaluateFunction(()=>({text:document.body.innerText||'',url:location.href}));assertXhsPage(page);
      if(await count()>before){const result={ok:true,verified:true,at:nowIso()};finishEffect(key,result);return result;}
    }
    throw new DeliveryUnknownError('评论发送结果没有核实，未自动重发');
  } catch(error){failEffect(key,error);throw error;}
}

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const NON_PUBLISH_PREFIXES = ['xhs-shot-', 'xhs-draft-', 'voice-'];
const IMAGE_DIRS = [
  path.join(paths.root, 'assets', 'stickers', 'deepseek-whale'),
  path.join(paths.root, 'assets'),
  paths.publicMedia,
];

function publishableImage(base) {
  return !NON_PUBLISH_PREFIXES.some((prefix) => String(base).startsWith(prefix));
}

export function resolveXhsImage(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== String(name || '')) throw new Error('图片名不合法');
  const ext = path.extname(base).toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) throw new Error('小红书只支持 jpg/jpeg/png/webp，不支持 gif');
  if (!publishableImage(base)) throw new Error('草稿截图和语音产物不能当笔记图');
  for (const dir of IMAGE_DIRS) {
    const file = path.join(dir, base);
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file);
      if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(dir)) throw new Error('图片不能指向目录外');
      if (!stat.isFile()) throw new Error('图片不是一个文件');
      if (stat.size > 32 * 1024 * 1024) throw new Error('图片超过 32MB');
      return file;
    }
  }
  throw new Error(`找不到图片：${base}`);
}

export function listXhsImages() {
  const out = [];
  for (const dir of [path.join(paths.root, 'assets', 'stickers', 'deepseek-whale'), paths.publicMedia]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!IMAGE_EXTS.includes(path.extname(entry).toLowerCase())) continue;
      if (!publishableImage(entry)) continue;
      out.push({ name: entry, file: path.join(dir, entry), bytes: fs.statSync(path.join(dir, entry)).size });
    }
  }
  return out;
}

async function openPublishEditor(files) {
  await browser.ensure({ visible: false });
  await browser.navigate(`${CREATOR_BASE}/publish/publish?source=official`);
  await sleep(6000);
  const tab = await browser.evaluate(`(() => {
    const el = [...document.querySelectorAll('div,span,li,a,button')].find(e => (e.innerText || '').trim() === '上传图文' && e.children.length <= 1);
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!tab) throw new Error('创作中心没有「上传图文」入口，可能是登录失效了，请重新扫码');
  await sleep(3000);
  await browser.send('DOM.enable');
  const { root } = await browser.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await browser.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input.upload-input[type=file]',
  });
  if (!nodeId) throw new Error('找不到小红书图片上传框');
  await browser.send('DOM.setFileInputFiles', { files, nodeId });
  for (let i = 0; i < 60; i += 1) {
    const ready = await browser.evaluate(
      '(() => Boolean(document.querySelector(\'input[placeholder*="标题"]\') && document.querySelector(\'.tiptap\')))()',
    );
    if (ready) break;
    await sleep(1000);
  }
  const ready = await browser.evaluate(
    `(() => Boolean(document.querySelector('input[placeholder*="标题"]') && document.querySelector('.tiptap')))()`,
  );
  if (!ready) {
    const blocked = await browser.evaluate(`/访问频繁|安全验证|滑块|重新登录/.test(document.body.innerText || '')`);
    throw new Error(blocked ? '小红书要求安全验证或登录，已停止，请在登录窗口里处理' : '图片上传后编辑器没有出来，这次没填成功');
  }
  await browser.evaluate(`(() => {
    const b = [...document.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '我知道了' && e.children.length === 0);
    if (b) b.click();
  })()`);
  await sleep(800);
}

const browserQueue = new SerialQueue({ maxWaiting: 12, waitMs: 45000 });

export function withXhsBrowser(task, options) {
  return browserQueue.run('browser', async () => {
    try { return await task(); }
    catch (error) {
      lastError = error.message;
      if (/频繁|验证|滑块|申诉|账号.{0,6}限制|300013/.test(error.message)) {
        const until = new Date(Date.now() + 6 * 3600000).toISOString();
        kvSet('xhs_cooldown_until', until);
        addEvent('xhs_cooldown', '小红书提示验证或限制，已停止自动动作', { until });
      }
      throw error;
    }
  }, options);
}

export function xhsBrowserBusy() { return browserQueue.busy; }

async function fillXhsNoteLocked({ images = [], title = '', body = '' }) {
  const cleanTitle = String(title || '').trim().slice(0, 20);
  const cleanBody = String(body || '').trim().slice(0, 1000);
  if (!cleanTitle) throw new Error('笔记标题不能为空');
  if (!cleanBody) throw new Error('笔记正文不能为空');
  if (!images.length) throw new Error('小红书图文笔记至少要一张图');
  if (images.length > 18) throw new Error('小红书一条笔记最多 18 张图');
  const gate = assertPublicContent(`${cleanTitle} ${cleanBody}`, { settings: loadSettings(), hisMessages: recentUserMessages(60) });
  if (!gate.ok) {
    addEvent('xhs_note_blocked', '这条她想过，不能公开写', { reason: gate.reason, title: cleanTitle.slice(0, 30) });
    logger.warn('小红书笔记被隐私闸门拦下', { reason: gate.reason });
    throw new Error(`这条不能公开写：${gate.reason}`);
  }
  assertXhsAction('read');
  const files = images.map(resolveXhsImage);

  await openPublishEditor(files);
  await browser.type('input[placeholder*="标题"]', cleanTitle);
  await sleep(400);
  const focused = await browser.evaluate(`(() => { const pm = document.querySelector('.tiptap'); if (!pm) return false; pm.focus(); return true; })()`);
  if (!focused) throw new Error('找不到小红书正文编辑器');
  await browser.send('Input.insertText', { text: cleanBody });
  await sleep(1200);

  const readback = await browser.evaluate(`(() => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const input = document.querySelector('input[placeholder*="标题"]');
    const editor = document.querySelector('.tiptap');
    const page = clean(document.body.innerText);
    const m = page.match(/(\\d+)\\/18/);
    return {
      title: clean(input && input.value).slice(0, 60),
      body: clean(editor && editor.innerText).slice(0, 1200),
      imageCount: m ? Number(m[1]) : 0,
      blocked: /访问频繁|安全验证|滑块/.test(page),
    };
  })()`);
  if (readback.blocked) throw new Error('小红书提示访问频繁/安全验证，已停止，没有发布');
  if (readback.title !== cleanTitle) throw new Error(`标题没有真的填进去（读到：${readback.title || '空'}）`);
  if (readback.body !== cleanBody.replace(/\s+/g, ' ').trim() || readback.imageCount !== files.length) throw new Error('正文没有真的填进编辑器');

  const shotFile = path.join(paths.media, `xhs-shot-${Date.now()}.png`);
  let screenshotUrl = '';
  try {
    await browser.screenshot(shotFile);
    screenshotUrl = `/media/${path.basename(shotFile)}`;
  } catch (error) {
    logger.debug('小红书草稿截图失败', { error: error.message });
  }
  const fillId = hashText(`${kvGet('xhs_self_user_id')}|${cleanTitle}|${cleanBody}|${images.join(',')}`);
  const profileDir = path.join(paths.xhsProfile, 'Default');
  const cookies = await browser.getCookies();
  const accountTag = hashText(cookies.filter(cookie => /^(?:web_session|a1|customerClientId)$/.test(cookie.name)).map(cookie => `${cookie.domain}:${cookie.name}:${cookie.value}`).sort().join('|'));
  kvSetJson('xhs_last_fill', { id: fillId, accountTag, title: cleanTitle, body: cleanBody.replace(/\s+/g, ' ').trim(), images: files.length, selfId: kvGet('xhs_self_user_id'), at: nowIso() });
  lastError = '';
  logger.info('小红书笔记已填进编辑器', { title: cleanTitle, chars: cleanBody.length, images: files.length });
  return { ok: true, filled: true, published: false, fillId, ...readback, screenshotUrl, at: nowIso() };
}

async function clickPublishBarButton(label) {
  return browser.evaluate(`(() => {
    const wanted = ${JSON.stringify(label)};
    const roots = [document, ...[...document.querySelectorAll('xhs-publish-btn')].map((e) => e._sr || e.shadowRoot).filter(Boolean)];
    for (const root of roots) {
      const nodes = [...root.querySelectorAll('button, [class*=btn], [role=button]')].filter((e) => {
        const text = (e.textContent || '').trim();
        const rect = e.getBoundingClientRect();
        return text === wanted && !e.disabled && rect.width > 0 && rect.height > 0;
      });
      if (nodes.length) {
        nodes[nodes.length - 1].click();
        return true;
      }
    }
    return false;
  })()`);
}

async function readXhsDraftCountLocked() {
  await browser.ensure({ visible: false });
  return browser.evaluate(`(() => {
    const m = (document.body.innerText || '').match(/草稿箱\\((\\d+)\\)/);
    return m ? Number(m[1]) : -1;
  })()`);
}

async function stashXhsDraftLocked() {
  const before = await readXhsDraftCount();
  const clicked = await clickPublishBarButton('暂存离开');
  if (!clicked) throw new Error('没找到「暂存离开」按钮，这次没存草稿');
  await sleep(4000);
  await browser.navigate(`${CREATOR_BASE}/publish/publish?source=official`);
  await sleep(6000);
  const after = await readXhsDraftCount();
  if (after > before || (before < 0 && after >= 1)) {
    logger.info('小红书笔记已存进草稿箱', { before, after });
    return { ok: true, stashed: true, before, after, at: nowIso() };
  }
  throw new Error(`点了「暂存离开」，但草稿箱里没看到东西（${before} → ${after}）；去创作中心人工确认，别重复点`);
}

async function publishFilledXhsNoteLocked() {
  const cooldown = kvGet('xhs_cooldown_until');
  if (cooldown && new Date(cooldown).getTime() > Date.now()) {
    throw new Error(`小红书在风控冷却中，到 ${cooldown.slice(11, 16)} 才动手`);
  }
  const fill = kvGetJson('xhs_last_fill', null);
  if (!fill?.title) throw new Error('没有她刚填好的稿子记录，先在编辑器里填一遍再发');
  if (Date.now() - new Date(fill.at).getTime() > 30 * 60000) {
    throw new Error('稿子填好超过半小时，重新填一次再发（避免发掉编辑器里留下的旧内容）');
  }
  const gate = assertPublicContent(`${fill.title} ${fill.body}`, { settings: loadSettings(), hisMessages: recentUserMessages(60) });
  if (!gate.ok) {
    addEvent('xhs_note_blocked', '按发布前最后一道隐私闸，这条没发', { reason: gate.reason });
    throw new Error(`这条不能公开写：${gate.reason}`);
  }
  assertXhsAction('publish');
  if (!fill.id || !fill.selfId || fill.selfId !== kvGet('xhs_self_user_id')) throw new Error('稿件账号尚未核实或已改变，请重新读取账号并填写');
  await browser.ensure({ visible: false });
  const actual = await browser.evaluateFunction(() => ({
    title: (document.querySelector('input[placeholder*="标题"]')?.value || '').replace(/\s+/g,' ').trim(),
    body: (document.querySelector('.tiptap')?.innerText || '').replace(/\s+/g,' ').trim(),
    images: Number((document.body.innerText || '').match(/(\d+)\/18/)?.[1] || 0), url: location.href,
  }));
  if (actual.title !== fill.title || actual.body !== fill.body || actual.images !== fill.images || !String(actual.url || '').startsWith(CREATOR_BASE + '/publish/')) throw new Error('当前编辑器与确认稿件不一致，未发布');
  const cookies = await browser.getCookies();
  const tag = hashText(cookies.filter(cookie => /^(?:web_session|a1|customerClientId)$/.test(cookie.name)).map(cookie => `${cookie.domain}:${cookie.name}:${cookie.value}`).sort().join('|'));
  if (!fill.accountTag || tag !== fill.accountTag) throw new Error('登录账号凭据已改变，请重新核实并填写');
  const dayKey = 'xhs_publish_day:' + new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
  const max = loadSettings().social.xhsPublishPerDay;
  if (Number(kvGet(dayKey,'0')) >= max) throw new Error('今天发布次数已达上限');
  const effectKey = 'effect:xhs:publish:' + fill.id;
  const operation = beginEffect(effectKey);
  if (!operation.started) return { ...operation.receipt, already: true };
  const clicked = await clickPublishBarButton('发布');
  if (!clicked) { failEffect(effectKey, new Error('未找到发布按钮')); throw new Error('没有找到可点的「发布」按钮，这次没发'); }
  for (let i = 0; i < 40; i += 1) {
    await sleep(1500);
    const state = await browser.evaluate(`(() => {
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const text = clean(document.body.innerText).slice(0, 4000);
      return {
        url: location.href,
        success: /发布成功|笔记发布成功/.test(text),
        rejected: /审核|未通过|失败|频繁|安全验证|违规/.test(text),
        snippet: text.slice(0, 200),
      };
    })()`);
    if (state.success && !state.rejected) {
      logger.info('小红书笔记已发布', { url: state.url });
      kvSet(dayKey, Number(kvGet(dayKey,'0')) + 1);
      finishEffect(effectKey, { ok: true, published: true, title: fill.title });
      kvSet('xhs_last_publish_at', nowIso());
      kvSetJson('xhs_last_fill', null);
      return { ok: true, published: true, at: nowIso(), title: fill.title };
    }
    if (state.rejected && /失败|频繁|安全验证|违规|未通过/.test(state.snippet)) {
      throw new Error(`小红书没有发布成功：${state.snippet.slice(0, 80)}`);
    }
  }
  const error = new DeliveryUnknownError('点了发布但没等到确认，请在创作中心核实，不要重复点');
  failEffect(effectKey, error);
  throw error;
}

async function leaveXhsPublishEditorLocked() {
  try {
    await browser.ensure({ visible: false });
    await browser.navigate(`${CREATOR_BASE}/new/home`);
    await sleep(2500);
  } catch {
    // ignore
  }
}

async function fetchXhsCreatorStatsLocked() {
  await browser.ensure({ visible: false });
  await browser.navigate(`${CREATOR_BASE}/new/home`);
  await sleep(6000);
  const parsed = await browser.evaluate(`(() => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const text = clean(document.body.innerText);
    if (/登录后查看|扫码登录|登录账号/.test(text.slice(0, 200))) return { login: false, text: text.slice(0, 120) };
    const tokens = text.split(' ');
    const after = (label) => {
      const i = tokens.indexOf(label);
      return i >= 0 && tokens[i + 1] ? tokens[i + 1] : '';
    };
    const before = (label) => {
      const i = tokens.indexOf(label);
      return i >= 0 && tokens[i - 1] ? tokens[i - 1] : '';
    };
    let periodPair = '';
    if (text.indexOf('统计周期') >= 0) {
      const rest = text.slice(text.indexOf('统计周期') + 4);
      const stop = rest.indexOf('曝光数');
      periodPair = (stop > 0 ? rest.slice(0, stop) : rest.slice(0, 30)).trim();
    }
    return {
      login: true,
      period: periodPair.replace('统计周期', '').trim(),
      views: after('曝光数'),
      reads: after('观看数'),
      coverRate: after('封面点击率'),
      likes: after('点赞数'),
      comments: after('评论数'),
      collects: after('收藏数'),
      shares: after('分享数'),
      netFollowers: after('净涨粉'),
      newFollowers: after('新增关注'),
      lostFollowers: after('取消关注'),
      visitors: after('主页访客'),
      followers: before('粉丝数'),
      following: before('关注数'),
      totalLikes: before('获赞与收藏'),
      blocked: /访问频繁|安全验证|滑块/.test(text),
    };
  })()`);
  if (parsed.blocked) throw new Error('小红书说访问频繁/要验证，这次不读数据了');
  if (!parsed.login) throw new Error('创作中心没登录，先在设置页登录创作中心');
  lastError = '';
  parsed.at = nowIso();
  kvSet('xhs_last_stats', JSON.stringify(parsed));
  logger.info('读到小红书创作中心数据', { period: parsed.period, views: parsed.views, followers: parsed.followers });
  return parsed;
}

export function readCachedXhsStats() {
  const raw = kvGet('xhs_last_stats');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const REACT_SELECTORS = {
  like: '.engage-bar .like-wrapper',
  collect: '.engage-bar .collect-wrapper',
};

async function reactXhsNoteLocked(kind = 'like') {
  const selector = REACT_SELECTORS[kind];
  if (!selector) throw new Error('不认识的动作类型：' + kind);
  const state = (sel) =>
    browser.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return { found: false, active: false };
        return { found: true, active: el.getAttribute('aria-pressed') === 'true' || [...el.classList].some(c => /^(?:like-active|collect-active|collected|active)$/.test(c)) };
      })()`,
    );
  const before = await state(selector);
  if (!before.found) throw new Error('这条笔记上没有可点的' + (kind === 'collect' ? '收藏' : '点赞') + '按钮');
  assertXhsAction(kind);
  if (before.active) return { ok: true, already: true, kind };
  await browser.click(selector);
  await sleep(1800);
  const after = await state(selector);
  if (!after.active) throw new Error('点了但状态没变，' + (kind === 'collect' ? '收藏' : '点赞') + '没生效');
  logger.info('小红书笔记状态已变化', { kind });
  return { ok: true, kind, active: true };
}

async function readXhsNotificationBadgeLocked() {
  await browser.ensure({ visible: false });
  const url = await browser.getUrl().catch(() => '');
  if (!/xiaohongshu/.test(url)) {
    await browser.navigate(`${BASE}/explore`);
    await sleep(5000);
  }
  const badge = await browser.evaluate(`(() => {
    const link = document.querySelector("a[href='/notification']");
    if (!link) return -1;
    const m = (link.innerText || '').match(/([0-9]+)/);
    return m ? Math.min(999, Number(m[1])) : 0;
  })()`);
  if (badge < 0) throw new Error('通知角标没有加载，保留上次数据');
  kvSet('xhs_notification_badge', String(badge));
  kvSet('xhs_notification_checked_at', nowIso());
  return badge;
}

async function readXhsDirectMessagesLocked() {
  assertXhsAction('read');
  await browser.ensure({ visible: false });
  await browser.navigate(`${BASE}/chat`);
  await sleep(7000);
  const items = await browser.evaluate(`(() => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    return [...document.querySelectorAll('.xhs-im-conv-item')].slice(0, 12).map((el) => ({
      convId: el.getAttribute('data-conv-id') || '',
      name: clean(el.querySelector('.xhs-im-conv-item__name')?.innerText) || clean(el.querySelector('img')?.getAttribute('alt')),
      time: clean(el.querySelector('.xhs-im-conv-item__time')?.innerText),
      preview: clean(el.querySelector('.xhs-im-conv-item__bottom')?.innerText || el.innerText.split(String.fromCharCode(10)).slice(-1)[0]),
      unread: clean(el.querySelector('[class*=badge], [class*=unread]')?.innerText),
      href: (el.querySelector('a[href*="/user/profile/"]') || {}).getAttribute ? el.querySelector('a[href*="/user/profile/"]').getAttribute('href') : '',
    })).filter((x) => x.name);
  })()`);
  if (!items.length) {
    const page = await browser.evaluateFunction(() => ({ text: document.body.innerText || '', url: location.href }));
    assertXhsPage(page);
    if (!/暂无私信|暂无会话/.test(page.text)) throw new Error('私信列表未加载，保留上次成功结果');
  }
  for (const item of items) {
    if (isOwnerConversation(item)) {
      const detail = await readXhsConversation(item);
      Object.assign(item, detail);
    }
  }
  const previous = (() => {
    try {
      return JSON.parse(kvGet('xhs_dms_seen', '[]'));
    } catch {
      return [];
    }
  })();
  const ownerName = loadSettings().social?.xhsOwnerName || '';
  for (const item of items) {
    item.isOwner = isOwnerConversation(item);
  }
  const seen = new Set(previous.map((x) => `${x.convId}|${x.preview}`));
  const fresh = items.filter((x) => !seen.has(`${x.convId}|${x.preview}`));
  kvSet('xhs_dms_seen', JSON.stringify(items.map((x) => ({ convId: x.convId, preview: x.preview }))));
  kvSet(
    'xhs_dms_list',
    JSON.stringify(items.map((x) => ({ ...x }))),
  );
  kvSet('xhs_dms_at', nowIso());
  logger.info('读了小红书私信', { conversations: items.length, fresh: fresh.length });
  return { items, fresh, at: nowIso() };
}

const DM_EDITOR = 'div.xhs-im-input-bar-editor[contenteditable="true"]';

/**
 * 回一条小红书私信。这一步是「你在控制台点了确认」之后才走到这里的：
 * 发出去要能证明真发出去了（输入框清空 + 最后一条气泡是这句），不然就报失败。
 */
async function sendXhsDirectMessageLocked({ target = '', convId = '', text = '', privateToOwner = false, expectedMessageId = '' } = {}) {
  const content = String(text || '').replace(/\s+/g, ' ').trim();
  if (!content) throw new Error('要回的私信是空的');
  if (content.length > 200) throw new Error('私信别写这么长（200 字以内）');
  privateToOwner = privateToOwner && isOwnerConversation({ convId });
  if (!privateToOwner) {
    const gate = assertPublicContent(content, { settings: loadSettings(), hisMessages: recentUserMessages(60) });
    if (!gate.ok) {
      addEvent('xhs_dm_gate', '这条小红书私信被她自己拦下了', { reason: gate.reason || gate.kind, target: String(target || '').slice(0, 30) });
      throw new Error(`这句话不能发出去（${gate.reason || gate.kind}）`);
    }
  }
  assertXhsAction('dm');
  const { canSendXhsDm, noteXhsDmSent } = await import('./xhs-actions.js');
  const budget = canSendXhsDm(target);
  if (!budget.ok) throw new Error(budget.reason);
  if (expectedMessageId) {
    const current = await readXhsConversation({ convId, name: target });
    if (current.messageId !== expectedMessageId || !current.inbound) throw new Error('私信已更新，取消旧回复');
  }
  const key = 'effect:xhs:dm:' + hashText(`${kvGet('xhs_self_user_id')}|${convId}|${expectedMessageId || content}`);
  const effect = beginEffect(key);
  if (!effect.started) return { ...effect.receipt, already: true };
  await browser.ensure({ visible: false });
  await browser.navigate(`${BASE}/chat`);
  await sleep(6000);

  const opened = await browser.evaluate(`(() => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const wantConv = ${JSON.stringify(String(convId || ''))};
    const wantName = clean(${JSON.stringify(String(target || ''))});
    const items = [...document.querySelectorAll('.xhs-im-conv-item')];
    const nameOf = (el) => clean(el.querySelector('.xhs-im-conv-item__name')?.innerText) || clean(el.innerText).slice(0, 20);
    let hit = wantConv ? items.find((el) => (el.getAttribute('data-conv-id') || '') === wantConv) : null;
    if (hit && nameOf(hit) !== wantName) return { ok: false, reason: '昵称与会话 ID 不一致' };
    if (!hit && !wantConv && wantName) { const matches = items.filter((el) => nameOf(el) === wantName); if (matches.length === 1) hit = matches[0]; }
    if (!hit) return { ok: false, reason: '私信列表里没找到这个人', names: items.slice(0, 12).map(nameOf).filter(Boolean) };
    const before = location.pathname;
    hit.click();
    return { ok: true, picked: nameOf(hit), before };
  })()`);
  if (!opened?.ok) {
    const known = (opened?.names || []).join('、');
    throw new Error(`找不到要回的那个人${known ? `（列表里是：${known}）` : ''}`);
  }
  await sleep(2500);
  const url = String((await browser.getUrl()) || '');
  if (!/\/chat\//.test(url)) throw new Error(`点进去以后地址没变成 /chat/…（现在在 ${url.slice(0, 60)}）`);

  await browser.waitFor(DM_EDITOR, 12000).catch(() => {});
  const before = await browser.evaluateFunction(() => ({ bubbleCount: document.querySelectorAll('.xhs-im-msg-list > *').length }));
  await browser.type(DM_EDITOR, content);
  const typed = await browser.evaluate(`(() => {
    const ed = document.querySelector(${JSON.stringify(DM_EDITOR)});
    return { shown: (ed?.innerText || ed?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240) };
  })()`);
  if (!typed?.shown || !typed.shown.includes(content.slice(0, 12))) {
    throw new Error(`字没进私信输入框（框里是：${typed?.shown || '空'}）`);
  }

  // 小红书私信页没有发送按钮，Vue 监听的是编辑器上的 Enter keydown；
  // 直接发 CDP 键盘事件不会触发它，必须先派发页面内的 KeyboardEvent。
  const keyed = await browser.evaluate(`(() => {
    const ed = document.querySelector(${JSON.stringify(DM_EDITOR)});
    if (!ed) return false;
    ed.focus();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    ed.dispatchEvent(new KeyboardEvent('keydown', opts));
    ed.dispatchEvent(new KeyboardEvent('keypress', opts));
    ed.dispatchEvent(new KeyboardEvent('keyup', opts));
    return true;
  })()`);
  if (keyed) await sleep(2500);
  const editorAfterKey = await browser.evaluate(`(() => {
    const ed = document.querySelector(${JSON.stringify(DM_EDITOR)});
    return !(ed?.innerText || ed?.textContent || '').trim();
  })()`);
  if (!editorAfterKey) {
    const keyBase = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await browser.send('Input.dispatchKeyEvent', { ...keyBase, type: 'keyDown', text: '\r', unmodifiedText: '\r' });
    await browser.send('Input.dispatchKeyEvent', { ...keyBase, type: 'keyUp' });
    await sleep(2500);
  }
  await sleep(2500);

  const after = await browser.evaluate(`(() => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const ed = document.querySelector(${JSON.stringify(DM_EDITOR)});
    const bubbles = [...document.querySelectorAll('.xhs-im-msg-list > *')];
    const last = bubbles.length ? clean(bubbles[bubbles.length - 1].innerText) : '';
    const body = clean(document.body.innerText).slice(0, 4000);
    return {
      editorEmpty: !(ed?.innerText || ed?.textContent || '').trim(),
      last,
      bubbleCount: bubbles.length,
      captcha: /访问频繁|操作频繁|安全验证|滑动验证|请在手机验证/.test(body),
    };
  })()`);
  if (after?.captcha) throw new Error('小红书提示访问频繁/安全验证，已停下没再发');
  const landed = String(after?.last || '') === content && after.bubbleCount > before.bubbleCount;
  if (!landed || !after?.editorEmpty) {
    const error = new DeliveryUnknownError('这条私信没有核实新增的完整消息，请在平台确认，不要重复发送');
    failEffect(key, error); throw error;
  }
  const sentReceipt = { ok: true, verified: true, to: opened.picked, text: content };
  finishEffect(key, sentReceipt);
  noteXhsDmSent(target, budget.keys);
  kvSetJson('xhs_dm_sent_last', {
    target: opened.picked || target,
    text: content,
    at: nowIso(),
  });
  return {
    ok: true,
    verified: landed,
    to: opened.picked,
    text: content,
    last: String(after?.last || '').slice(0, 120),
  };
}

export function readCachedXhsDms() {
  const list = kvGetJson('xhs_dms_list', []);
  return Array.isArray(list) ? list : [];
}


async function readXhsFollowGraphLocked(profileUrl) {
  assertXhsAction('read');
  await browser.ensure({ visible: false });
  if (profileUrl) {
    await browser.navigate(profileUrl);
    await sleep(7000);
  }
  const readSide = async (label) => {
    const opened = await browser.evaluate(`(() => {
      const wanted = ${JSON.stringify(label)};
      const nodes = [...document.querySelectorAll('*')].filter((e) => {
        const t = (e.innerText || '').replace(/\\s+/g, '');
        return new RegExp('^[0-9,]*' + wanted + '$').test(t) && e.children.length <= 2;
      });
      if (!nodes.length) return false;
      nodes[nodes.length - 1].click();
      return true;
    })()`);
    if (!opened) return { label, count: 0, names: [], opened: false };
    await sleep(3500);
    const data = await browser.evaluate(`(() => {
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const modal = document.querySelector('.reds-modal, [class*=reds-modal]');
      if (!modal) return { names: [], count: 0, opened: false };
      const tab = [...modal.querySelectorAll('*')].find((e) => (e.innerText || '').trim() === ${JSON.stringify(label)} && e.children.length === 0);
      if (tab) tab.click();
      return { names: [], count: 0, opened: true, clickedTab: Boolean(tab) };
    })()`);
    await sleep(2500);
    const listed = await browser.evaluate(`(() => {
      const modal = document.querySelector('.reds-modal, [class*=reds-modal]');
      if (!modal) return [];
      const skip = /^(关注|粉丝|笔记.*|全部|加载中|互相关注|已关注|关注|发私信|综合排序|最近联系|聊天|\s*)$/;
      return [...modal.querySelectorAll('*')]
        .filter((e) => e.children.length === 0 && !skip.test((e.innerText || '').trim()))
        .map((e) => (e.innerText || '').trim())
        .filter((t) => t.length > 0 && t.length <= 24 && !/[0-9]/.test(t));
    })()`);
    const uniq = [...new Set(listed)];
    await browser.evaluate(`(() => {
      const close = document.querySelector('[class*=close], .reds-dialog-close');
      if (close) close.click();
    })()`);
    await sleep(1200);
    const links = await browser.evaluate(`(() => {
      const modal = document.querySelector('.reds-modal, [class*=reds-modal]');
      if (!modal) return [];
      return [...modal.querySelectorAll('a[href*="/user/profile/"]')]
        .map((a) => ({ href: a.getAttribute('href') || '', name: (a.innerText || '').trim() }))
        .filter((x) => x.href.includes('/user/profile/'));
    })()`);
    if (!data.opened) return { label, opened: false, count: null, names: [], links: [] };
    kvSet(`xhs_graph_links_${label}`, JSON.stringify(links.slice(0, 20)));
    return { label, opened: true, count: uniq.length, names: uniq.slice(0, 20), links: links.slice(0, 20) };
  };
  const fans = await readSide('粉丝');
  const following = await readSide('关注');
  const graph = { fans, following, at: nowIso(), ok: Boolean(fans.opened && following.opened) };
  if (!graph.ok) throw new Error('关注或粉丝名单读取失败，保留上一次成功结果');
  if (!graph.ok) graph.reason = '个人主页上点不开粉丝/关注名单（可能没登录或页面换了）';
  kvSet('xhs_follow_graph', JSON.stringify(graph));
  logger.info('读了小红书关注关系', { fans: fans.count, following: following.count });
  return graph;
}

export function readCachedXhsFollowGraph() {
  try {
    return JSON.parse(kvGet('xhs_follow_graph', 'null'));
  } catch {
    return null;
  }
}

async function readXhsOwnerProfileLocked() {
  const settings = loadSettings();
  const ownerName = settings.social?.xhsOwnerName || '';
  let href = settings.social?.xhsOwnerUserId && /^[0-9a-f]{24}$/.test(settings.social.xhsOwnerUserId)
    ? `${BASE}/user/profile/${settings.social.xhsOwnerUserId}`
    : kvGet('xhs_owner_profile_url') || '';
  if (!href) {
    const pool = [];
    for (const label of ['粉丝', '关注']) {
      try {
        pool.push(...JSON.parse(kvGet(`xhs_graph_links_${label}`, '[]')));
      } catch {
        // 忽略坏数据
      }
    }
    const mine = pool.find((x) => ownerName && (x.name || '').includes(ownerName));
    if (mine) href = mine.href;

    if (!href) return null;
  }
  await browser.ensure({ visible: false });
  await browser.navigate(href.startsWith('http') ? href : `${BASE}${href}`);
  await sleep(6000);
  const info = await browser.evaluate(`(() => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const text = clean(document.body.innerText);
    const idMatch = location.href.match(/profile[/]([0-9a-f]{24})/);
    const numberMatch = text.match(/小红书号[：:]?s*([0-9A-Za-z-]{4,24})/);
    const ipMatch = text.match(/IP属地[：:]?s*([^ ]{2,12})/);
    return {
      userId: idMatch ? idMatch[1] : '',
      number: numberMatch ? numberMatch[1] : '',
      ipLocation: ipMatch ? ipMatch[1] : '',
      name: clean(document.querySelector('.user-nickname, .user-name')?.innerText),
      desc: clean(document.querySelector('.user-desc')?.innerText),
      url: location.href,
    };
  })()`);
  if (info.userId) kvSet('xhs_owner_profile_url', `${BASE}/user/profile/${info.userId}`);
  kvSet('xhs_owner_profile', JSON.stringify(info));
  logger.info('读了主人的小红书主页', { userId: info.userId, number: info.number, name: info.name });
  return info;
}

export function readCachedXhsOwnerProfile() {
  try {
    return JSON.parse(kvGet('xhs_owner_profile', 'null'));
  } catch {
    return null;
  }
}

async function closeXhsBrowserLocked({ locked = false } = {}) {
  if (!locked) return withXhsBrowser(() => closeXhsBrowser({ locked: true }));
  manualWindow = false;
  await browser.shutdown();
  return { ok: true };
}

const PROFILE_LOGOUT_PATHS = [
  path.join('Default', 'Network', 'Cookies'),
  path.join('Default', 'Network', 'Cookies-journal'),
  path.join('Default', 'Cookies'),
  path.join('Default', 'Cookies-journal'),
  path.join('Default', 'Local Storage'),
  path.join('Default', 'Session Storage'),
  path.join('Default', 'WebStorage'),
];

const LOGOUT_KV_KEYS = [
  'xhs_logged_in',
  'xhs_self_name',
  'xhs_self_user_id',
  'xhs_profile_url',
  'xhs_last_stats',
  'xhs_follow_graph',
  'xhs_owner_profile',
  'xhs_notification_badge',
  'xhs_notification_checked_at',
  'xhs_dms_seen',
  'xhs_dms_at',
  'xhs_fans_count',
  'xhs_graph_day',
  'xhs_last_fill',
];

async function xhsLogoutLocked({ locked = false } = {}) {
  if (!locked) return withXhsBrowser(() => xhsLogout({ locked: true }));
  manualWindow = false;
  try {
    await browser.shutdown();
  } catch (error) { throw new Error('浏览器没有安全退出，未删除登录文件：' + error.message); }
  const removed = [];
  const failed = [];
  for (const rel of PROFILE_LOGOUT_PATHS) {
    const target = path.join(paths.xhsProfile, rel);
    if (!fs.existsSync(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(rel);
    } catch (error) {
      failed.push(`${rel}：${error.message}`);
    }
  }
  for (const key of LOGOUT_KV_KEYS) kvSet(key, '');
  const cleared = kvDeletePrefix('xhs_') + kvDeletePrefix('next_xhs_at');
  kvSet('next_xhs_at', new Date(Date.now() + 2 * 3600000).toISOString());
  const ok = failed.length === 0;
  addEvent(
    'xhs_logout',
    ok ? `已退出小红书登录并清掉这个号的 ${cleared} 项缓存，可以换号扫码了` : '退出小红书登录没做干净，需要手动删 data/xhs-profile',
    { removed, failed, cleared },
  );
  logger.info('退出小红书登录', { removed: removed.length, failed: failed.length, cleared });
  return { ok, removed, failed, cleared };
}

export function xhsBrowser() {
  return browser;
}


async function ensurePhoneLoginPage() {
  await browser.ensure({ visible: false });
  if (!manualWindow) await browser.hideWindow();
  let url = await browser.getUrl();
  if (!String(url).includes('/login')) {
    await browser.navigate(`${BASE}/login`);
  }
  await browser.waitFor('input[name="xhs-pc-web-phone"]', 10000);
}

async function requestXhsSmsCodeLocked(phone) {
  const value = String(phone || '').replace(/\s+/g, '');
  if (!/^1\d{10}$/.test(value)) throw new Error('请输入 11 位手机号');
  await ensurePhoneLoginPage();
  await browser.type('input[name="xhs-pc-web-phone"]', value);
  await browser.click('.right .code-button');
  await sleep(1800);
  const state = await browser.evaluate(`(() => ({
    err: (document.querySelector('.right .err-msg')?.innerText || '').trim(),
    button: (document.querySelector('.right .code-button')?.innerText || '').trim(),
    captcha: /验证|滑动|安全验证/.test(document.querySelector('.right')?.innerText || '')
  }))()`, { timeoutMs: 45000 });
  if (state.captcha) throw new Error('小红书要求人机验证，请点「在窗口里登录」完成验证');
  if (state.err) throw new Error(state.err);
  if (!/秒|重新|获取/.test(state.button)) throw new Error('验证码没有发出，请稍后再试');
  logger.info('小红书验证码请求已提交', { phone: `***${value.slice(-4)}` });
  return { ok: true, countdown: state.button };
}

async function loginXhsWithSmsLocked(phone, code) {
  const phoneValue = String(phone || '').replace(/\s+/g, '');
  const codeValue = String(code || '').replace(/\s+/g, '');
  if (!/^1\d{10}$/.test(phoneValue)) throw new Error('请输入 11 位手机号');
  if (!/^\d{4,8}$/.test(codeValue)) throw new Error('请输入短信验证码');
  await ensurePhoneLoginPage();
  await browser.type('input[name="xhs-pc-web-phone"]', phoneValue);
  await browser.type('input[placeholder="输入验证码"]', codeValue);
  await sleep(300);
  await browser.click('.right button.submit');
  await sleep(4500);
  const state = await browser.evaluate(`(() => ({
    url: location.href,
    err: (document.querySelector('.right .err-msg')?.innerText || '').trim(),
    body: (document.body.innerText || '').slice(0, 300)
  }))()`, { timeoutMs: 45000 });
  if (String(state.url).includes('/login')) {
    throw new Error(state.err || '登录没有成功，请检查手机号/验证码');
  }
  kvSet('xhs_logged_in', '1');
  manualWindow = false;
  lastCheckAt = nowIso();
  lastError = '';
  await browser.hideWindow();
  logger.info('小红书手机号登录成功');
  return { ok: true, url: state.url };
}

async function readXhsConversationLocked(item) {
  assertXhsAction('read');
  if (!item?.convId) throw new Error('私信缺少稳定会话 ID');
  await browser.navigate(BASE + '/chat');
  if (!(await browser.waitFor('.xhs-im-conv-item', 12000))) throw new Error('私信列表未加载');
  const opened = await browser.evaluateFunction((id, name) => {
    const items = [...document.querySelectorAll('.xhs-im-conv-item')];
    const hit = items.find(el => el.getAttribute('data-conv-id') === id);
    const actual = (hit?.querySelector('.xhs-im-conv-item__name')?.innerText || '').trim();
    if (!hit || actual !== name) return false;
    hit.click(); return true;
  }, [item.convId, item.name]);
  if (!opened) throw new Error('私信收件人与会话 ID 不匹配');
  await sleep(1500);
  return browser.evaluateFunction(() => {
    const nodes = [...document.querySelectorAll('.xhs-im-msg-list > *')];
    const last = nodes.at(-1);
    if (!last) return { inbound:false };
    const id=last.getAttribute('data-message-id') || last.getAttribute('data-msg-id') || last.id;
    const sent=/outgoing|self|right|sent|own/.test(last.className || '');
    const received=/incoming|left|received|other/.test(last.className || '');
    const preview=(last.querySelector('[class*=content], [class*=text]')?.innerText || last.innerText || '').replace(/\s+/g,' ').trim();
    return { messageId:id || '', inbound: received && !sent, preview, messages:nodes.slice(-6).map(el=>(el.innerText || '').trim()).filter(Boolean) };
  });
}

export async function xhsBrowserStatus(...args) { return withXhsBrowser(() => xhsBrowserStatusLocked(...args)); }
export async function openXhsLogin(...args) { return withXhsBrowser(() => openXhsLoginLocked(...args)); }
export async function verifyXhsLogin(...args) { return withXhsBrowser(() => verifyXhsLoginLocked(...args)); }
export async function getXhsLoginQr(...args) { return withXhsBrowser(() => getXhsLoginQrLocked(...args)); }
export async function fetchXhsFeed(...args) { return withXhsBrowser(() => fetchXhsFeedLocked(...args)); }
export async function fetchXhsNote(...args) { return withXhsBrowser(() => fetchXhsNoteLocked(...args)); }
export async function postXhsComment(...args) { return withXhsBrowser(() => postXhsCommentLocked(...args)); }
export async function fillXhsNote(...args) { return withXhsBrowser(() => fillXhsNoteLocked(...args)); }
export async function readXhsDraftCount(...args) { return withXhsBrowser(() => readXhsDraftCountLocked(...args)); }
export async function stashXhsDraft(...args) { return withXhsBrowser(() => stashXhsDraftLocked(...args)); }
export async function publishFilledXhsNote(...args) { return withXhsBrowser(() => publishFilledXhsNoteLocked(...args)); }
export async function leaveXhsPublishEditor(...args) { return withXhsBrowser(() => leaveXhsPublishEditorLocked(...args)); }
export async function fetchXhsCreatorStats(...args) { return withXhsBrowser(() => fetchXhsCreatorStatsLocked(...args)); }
export async function reactXhsNote(...args) { return withXhsBrowser(() => reactXhsNoteLocked(...args)); }
export async function readXhsNotificationBadge(...args) { return withXhsBrowser(() => readXhsNotificationBadgeLocked(...args)); }
export async function readXhsDirectMessages(...args) { return withXhsBrowser(() => readXhsDirectMessagesLocked(...args)); }
export async function sendXhsDirectMessage(...args) { return withXhsBrowser(() => sendXhsDirectMessageLocked(...args)); }
export async function readXhsFollowGraph(...args) { return withXhsBrowser(() => readXhsFollowGraphLocked(...args)); }
export async function readXhsOwnerProfile(...args) { return withXhsBrowser(() => readXhsOwnerProfileLocked(...args)); }
export async function closeXhsBrowser(...args) { return withXhsBrowser(() => closeXhsBrowserLocked(...args)); }
export async function xhsLogout(...args) { return withXhsBrowser(() => xhsLogoutLocked(...args)); }
export async function requestXhsSmsCode(...args) { return withXhsBrowser(() => requestXhsSmsCodeLocked(...args)); }
export async function loginXhsWithSms(...args) { return withXhsBrowser(() => loginXhsWithSmsLocked(...args)); }
export async function readXhsConversation(...args) { return withXhsBrowser(() => readXhsConversationLocked(...args)); }
