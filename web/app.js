const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const VOICE_FALLBACK = [{ id: 'zh-CN-XiaoxiaoNeural', label: '小晓 · 温柔大姐姐', note: '最自然，默认' }];

const state = {
  status: null,
  settings: null,
  voiceSetup: null,
  meta: null,
  persona: '',
  messages: [],
  sessionId: null,
  images: [],
  streaming: false,
  abortController: null,
  memoryTab: 'core',
  memory: null,
  posts: [],
  labels: { qzone: 'QQ 空间', xhs: '小红书', douyin: '抖音' },
  events: [],
  ttsAuto: false,
  toastTimer: null,
  pollTimer: null,
  xhsQrTimer: null,
  qqQrTimer: null,
  qqOwnerId: '',
  offline: false,
  dmInbox: null,
  view: 'chat',
  liveBusy: false,
  settingsDirty: false,
  chatEpoch: 0,
  messagesRequest: 0,
  xhsLoggedIn: null,
  eventsRefreshAt: 0,
  socialRefreshAt: 0,
  memoryRefreshAt: 0,
  balanceRefreshAt: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function el(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = text;
  return node;
}

function money(value) {
  return `¥${Number(value || 0).toFixed(3)}`;
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function fmtNum(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function fmtClock(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function dayKey(iso) {
  return new Date(iso).toLocaleDateString('sv-SE');
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date().toLocaleDateString('sv-SE');
  const key = d.toLocaleDateString('sv-SE');
  if (key === today) return '今天';
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
  if (key === yesterday) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
}

function affectionLabel(value) {
  const n = Number(value) || 0;
  if (n >= 85) return '很在乎你';
  if (n >= 65) return '很喜欢你';
  if (n >= 45) return '有点黏你';
  if (n >= 25) return '亲近';
  return '刚熟悉';
}

function toast(message, type = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show ${type === 'error' ? 'error' : ''}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    node.className = 'toast';
  }, 3600);
}

// 旧版把令牌存在 localStorage；现在改用 HttpOnly 会话 cookie，清掉旧值避免污染。
try {
  localStorage.removeItem('bz_token');
} catch {
  // 隐私模式
}

function withToken(path) {
  return path;
}

function showLogin(message = '') {
  const screen = $('#loginScreen');
  if (!screen) return;
  screen.classList.remove('hidden');
  $('.app').inert = true;
  stopQqQrPolling();
  if (state.pollTimer) clearInterval(state.pollTimer);
  const error = $('#loginError');
  if (error) error.textContent = message;
  setTimeout(() => $('#loginPassword')?.focus(), 60);
}

function hideLogin() {
  $('#loginScreen')?.classList.add('hidden');
}

async function submitLogin(password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BiZhi-Request': '1' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '登录失败');
  location.reload();
}

async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { 'X-BiZhi-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const timeout = AbortSignal.timeout(method === 'GET' ? 15000 : 240000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(withToken(path), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: requestSignal,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    if (res.status === 401) {
      state.loginRequired = true;
      showLogin(data.error || '请先登录控制台');
    }
    const error = new Error(data.error || `请求失败（${res.status}）`);
    error.loginRequired = res.status === 401;
    throw error;
  }
  return data;
}

async function withBusy(button, fn) {
  if (!button) return fn();
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '稍等…';
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* ---------------- navigation ---------------- */

function switchView(name) {
  const previousView = state.view;
  state.view = name;
  $$('.rail-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === name));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  if (name === 'settings') {
    loadXhsStatus().catch(() => {});
    loadVoiceSetup().catch(() => {});
  } else {
    stopXhsQrPolling();
    stopQqQrPolling();
  }
  const targetView = document.querySelector(`#view-${name}`);
  if (targetView && previousView !== name) targetView.scrollTop = 0;
  if (name === 'chat') scrollMessages(true);
  if (name === 'memory') loadMemory().catch((error) => toast(error.message, 'error'));
  if (name === 'social') {
    loadPosts().catch((error) => toast(error.message, 'error'));
    loadQzoneFeed().catch(() => {});
    loadXhsNoteImages().catch(() => {});
    loadStickerStatus().catch(() => {});
    loadXhsDms().catch(() => {});
  }
  if (name === 'settings') {
    loadSettings().catch((error) => toast(error.message, 'error'));
    loadEvents().catch(() => {});
    loadBalance().catch(() => {});
    loadQqSetup().catch(() => {});
    loadStickerStatus().catch(() => {});
    loadQzoneStatus().catch(() => {});
  }
}

function bindNavigation() {
  $$('[data-view]').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  $('#openSettings').addEventListener('click', () => switchView('settings'));
  $('#moodChip').addEventListener('click', () => {
    if (!state.status) return;
    const mood = state.status.mood;
    toast(`她现在：${mood.label}${mood.reason ? ` · ${mood.reason}` : ''}`);
  });
  const setChatSide = (open) => {
    $('#chatSide').classList.toggle('open', open);
    $('#openChatSide').setAttribute('aria-expanded', String(open));
  };
  $('#openChatSide').addEventListener('click', () => setChatSide(!$('#chatSide').classList.contains('open')));
  $('#closeChatSide').addEventListener('click', () => setChatSide(false));
}

/* ---------------- status ---------------- */

async function loadStatus() {
  const previous = state.status;
  const status = await api('/api/status');
  state.status = status;
  state.offline = false;
  renderStatus();
  if (previous && previous.qq?.connected !== status.qq?.connected) {
    if (status.qq?.connected) toast('QQ 已连接，她可以在 QQ 里说话了。');
    else toast('QQ 断开了，正在等她自愈；不行就要重新扫码。', 'error');
    loadQqSetup().catch(() => {});
  }
  if (previous?.qq?.identityOk !== status.qq?.identityOk && status.qq?.connected && status.qq?.identityOk === false) {
    toast(`QQ 连上了，但登录号不对：${status.qq.identityError || '不是机器人小号'}`, 'error');
  }
  if (status.qq?.candidate && !previous?.qq?.candidate) {
    toast('有一个新私聊，去「设置 → QQ」确认是不是主人。');
    loadQqSetup().catch(() => {});
  }
  if (status.session?.id) {
    if (state.sessionId && state.sessionId !== status.session.id) {
      state.sessionId = status.session.id;
      toast('她翻开了新的一页，交接信已经写好了。');
      if (!state.streaming) await loadMessages();
    } else if (!state.sessionId) {
      state.sessionId = status.session.id;
    } else if (
      !state.streaming &&
      previous?.session?.messageCount != null &&
      status.session.messageCount !== previous.session.messageCount
    ) {
      await loadMessages();
    }
  }
}

function renderStatus() {
  const status = state.status;
  if (!status) return;
  const companion = status.companion || {};
  const mood = status.mood || {};
  const qq = status.qq || {};

  $('#topName').textContent = companion.name || '小知';
  $('#sideName').textContent = companion.name || '小知';
  $('#sideIntro').textContent = companion.intro || '';
  $('#topStatusText').textContent = status.mock
    ? '模拟模式 · 本地测试'
    : status.keyConfigured
    ? `${qq.connected ? '在线 · QQ 已连接' : '在线 · 本地'}${mood.label ? ` · ${mood.label}` : ''}`
    : '未配置 API Key';
  $('#topStatus .dot').style.background = status.keyConfigured ? 'var(--ok)' : 'var(--danger)';
  $('#railQqDot').classList.toggle('on', Boolean(qq.connected));

  $('#moodChip').textContent = `${mood.label || '正在感受'} · ${affectionLabel(mood.affection)}`;
  $('#sideMood').textContent = mood.label || '正在感受…';
  $('#affectionText').textContent = `亲密度 ${Math.round(Number(mood.affection) || 0)}`;
  $('#moodReason').textContent = mood.reason ? `因为：${mood.reason}` : '';
  $('#barValence').style.width = `${Math.round(((Number(mood.valence) || 0) + 1) / 2 * 100)}%`;
  $('#barEnergy').style.width = `${Math.round((Number(mood.energy) || 0) * 100)}%`;
  $('#barAffection').style.width = `${Math.min(100, Math.round(Number(mood.affection) || 0))}%`;

  const costs = status.costs || {};
  $('#todayCost').textContent = money(costs.todayCostCny);
  $('#todayTokens').textContent = fmtNum(costs.todayTokens);
  $('#weekCost').textContent = money(costs.costCny);
  $('#weekCost2').textContent = money(costs.costCny);
  $('#sessionTokens').textContent = status.session?.contextTokens
    ? `${fmtNum(status.session.contextTokens)} tokens（模型实测）`
    : `${fmtNum(status.session?.token_used || 0)} tokens（本地估算）`;
  const selfId = String(qq.selfId || '');
  const maskedSelf = selfId.length > 6 ? `${selfId.slice(0, 3)}****${selfId.slice(-3)}` : selfId;
  const identityTag = qq.identityOk === false ? '不是小号' : qq.identityOk ? '机器人' : '';
  const sendIssue = qq.connected && qq.lastError ? ' · 发送异常' : '';
  $('#qqState').textContent = qq.connected
    ? `已连接${maskedSelf ? ` · ${maskedSelf}` : ''}${identityTag ? `（${identityTag}）` : ''}${sendIssue}`
    : '未连接';

  const counts = status.memoryCounts;
  if (counts) {
    $('#countCore').textContent = counts.core || 0;
    $('#countMid').textContent = counts.mid || 0;
    $('#countLong').textContent = counts.long || 0;
  }
  const intentionLine = $('#intentionLine');
  if (intentionLine) {
    const list = status.intentions || [];
    intentionLine.textContent = list.length
      ? `她正惦记着：${list.map((i) => i.text).join('；')}。`
      : '她目前没有自己惦记着要办的事。';
  }
  const dreamLine = $('#dreamLine');
  if (dreamLine) {
    const dream = status.scheduler && status.scheduler.lastDream;
    dreamLine.textContent = dream
      ? `她在 ${new Date(dream.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} 睡前想过：${dream.dream}${dream.used ? '' : '（还没跟你说）'}`
      : '她还没有睡前一个人想过事。';
  }
  const hint = $('#proactiveHint');
  if (hint) {
    const sc = status.scheduler || {};
    if (!sc.proactiveEnabled) hint.textContent = '主动找你：已关闭。';
    else if (Number(sc.proactiveUnanswered || 0) >= Number(sc.proactiveMaxUnanswered || 99)) {
      hint.textContent = `她已经主动找了 ${sc.proactiveUnanswered} 次你没回，先不打扰了——你随便发一句她就回来。`;
    } else if (sc.nextProactiveAt) {
      hint.textContent =
        `她下一次主动找你的时间点：${new Date(sc.nextProactiveAt).toLocaleString('zh-CN', { hour12: false })}（今天已经主动 ${sc.todayProactive || 0} 次；你一发消息她就重新算）。`;
    } else {
      hint.textContent = '她在等你们这轮对话安静下来。';
    }
  }
  renderHealth(status.health || []);
  const costState = status.cost || null;
  const costLine = $('#costStateLine');
  if (costLine) {
    if (!costState || costState.level === 'unknown') {
      costLine.textContent = '还没读到余额：她先按原样跑，读到以后自动接管。';
    } else if (costState.level === 'normal') {
      costLine.textContent = `闸门待命：余额 ${Number(costState.balanceCny).toFixed(2)} 元，今天已花 ${Number(costState.todayCostCny || 0).toFixed(2)} 元（低于 ${costState.low} 元开始省，低于 ${costState.stop} 元全停）。`;
    } else {
      costLine.textContent = `${costState.level === 'stop' ? '已经全停' : '正在省'}：${(costState.reasons || []).join('；')}（余额 ${Number(costState.balanceCny).toFixed(2)} 元 / 今天 ${Number(costState.todayCostCny || 0).toFixed(2)} 元）`;
    }
  }
  document.title = `${companion.name || '小知'} · 在呢`;
}

function renderHealth(list) {
  const box = $('#healthBanner');
  if (!box) return;
  box.textContent = '';
  box.classList.toggle('hidden', !list.length);
  box.hidden = !list.length;
  for (const item of list) {
    const line = document.createElement('span');
    line.className = `health-item health-${item.level || 'info'}`;
    line.textContent = item.text || '';
    if (item.key === 'legacy-post' && item.postId) {
      const ack = document.createElement('button');
      ack.type = 'button';
      ack.className = 'icon-btn';
      ack.textContent = '我已删掉';
      ack.addEventListener('click', async () => {
        try {
          await api(`/api/posts/${item.postId}`, { method: 'DELETE' });
          toast('已把这条旧说说从控制台记录里移除');
          await loadStatus();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
      line.appendChild(document.createTextNode(' '));
      line.appendChild(ack);
    }
    box.appendChild(line);
  }
}

async function pollStatus() {
  if (state.loginRequired) return;
  try {
    await loadStatus();
  } catch (error) {
    if (!state.offline && !state.loginRequired) toast(`控制台连接断了：${error.message}`, 'error');
    state.offline = true;
    $('#topStatusText').textContent = '离线 · 正在重试';
    $('#topStatus .dot').style.background = 'var(--danger)';
  }
}

async function liveRefresh() {
  if (state.loginRequired || state.liveBusy || document.hidden) return;
  state.liveBusy = true;
  try {
    await loadStatus();
    const now = Date.now();
    if (state.view === 'settings') {
      await Promise.allSettled([loadQqSetup(), loadXhsStatus(), loadQzoneStatus()]);
      if (now - state.eventsRefreshAt > 10000) {
        state.eventsRefreshAt = now;
        await loadEvents();
      }
      if (now - state.balanceRefreshAt > 60000) {
        state.balanceRefreshAt = now;
        loadBalance().catch(() => {});
      }
    } else if (state.view === 'social') {
      if (now - state.socialRefreshAt > 10000) {
        state.socialRefreshAt = now;
        await Promise.allSettled([loadPosts(), loadEvents(), loadXhsDms()]);
      }
    } else if (state.view === 'memory') {
      if (now - state.memoryRefreshAt > 15000) {
        state.memoryRefreshAt = now;
        await loadMemory();
      }
    }
  } catch (error) {
    if (!state.loginRequired && !state.offline) toast(`实时刷新失败：${error.message}`, 'error');
    state.offline = true;
    $('#topStatusText').textContent = state.loginRequired ? '需要登录' : '离线 · 正在重试';
  } finally {
    state.liveBusy = false;
  }
}

async function loadBalance(force = false) {
  try {
    const balance = await api('/api/balance');
    $('#balanceBtn').textContent = `余额 ¥${Number(balance.total || 0).toFixed(2)}`;
    $('#balanceValue').textContent = `¥${Number(balance.total || 0).toFixed(2)} ${balance.currency || 'CNY'}`;
  } catch (error) {
    $('#balanceBtn').textContent = '余额 --';
    if (force) toast(error.message, 'error');
  }
}

/* ---------------- messages / chat ---------------- */

async function loadMessages() {
  if (state.streaming) return;
  const epoch = state.chatEpoch;
  const request = ++state.messagesRequest;
  const data = await api('/api/messages?limit=120');
  if (state.streaming || epoch !== state.chatEpoch || request !== state.messagesRequest) return;
  state.sessionId = data.session.id;
  state.messages = data.messages || [];
  renderMessages();
}

function isNearBottom() {
  const box = $('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 180;
}

function scrollMessages(force = false) {
  const box = $('#messages');
  if (force || isNearBottom()) box.scrollTop = box.scrollHeight;
}

function renderMessages() {
  const box = $('#messages');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 180;
  const previousTop = box.scrollTop;
  box.innerHTML = '';
  if (!state.messages.length) {
    renderWelcome();
    return;
  }
  let lastDay = '';
  for (const message of state.messages) {
    const key = dayKey(message.created_at);
    if (key !== lastDay) {
      box.appendChild(el('div', 'day-chip', dayLabel(message.created_at)));
      lastDay = key;
    }
    appendMessage(message);
  }
  box.scrollTop = stick ? box.scrollHeight : previousTop;
}

function renderWelcome() {
  const box = $('#messages');
  box.innerHTML = '';
  const welcome = el('div', 'welcome');
  const avatar = el('img');
  avatar.src = '/assets/avatar.png';
  avatar.alt = '小知';
  welcome.appendChild(avatar);
  welcome.appendChild(el('h2', '', '我在。'));
  welcome.appendChild(el('p', '', '不用想好开场白。今天怎么样，想先说哪一件？'));
  const suggestions = el('div', 'suggestions');
  for (const text of ['今天有点累', '陪我聊会儿', '夸夸我', '我回来了']) {
    const btn = el('button', 'suggestion', text);
    suggestions.appendChild(btn);
  }
  welcome.appendChild(suggestions);
  box.appendChild(welcome);
}

function clearWelcome() {
  const welcome = $('.welcome', $('#messages'));
  if (welcome) welcome.remove();
}

function appendMessage(message, { images = [] } = {}) {
  const box = $('#messages');
  const node = el('div', `msg ${message.role === 'assistant' ? 'assistant' : 'user'}`);
  if (message.meta?.error) node.classList.add('error');
  if (message.id) node.dataset.messageId = message.id;

  if (message.role === 'assistant') {
    const avatar = el('img', 'msg-avatar');
    avatar.src = '/assets/avatar.png';
    avatar.alt = '小知';
    node.appendChild(avatar);
  } else {
    node.appendChild(el('div', 'msg-avatar', '你'));
  }

  const wrap = el('div', 'bubble-wrap');
  const bubble = el('div', 'bubble', message.content || '');
  if (images.length) {
    for (const src of images) {
      const img = el('img');
      img.src = src;
      img.alt = '图片';
      bubble.appendChild(img);
    }
  }
  wrap.appendChild(bubble);

  const meta = el('div', 'msg-meta');
  if (message.meta?.proactive) meta.appendChild(el('span', 'badge', '她主动找你'));
  meta.appendChild(el('span', '', fmtClock(message.created_at)));
  if (message.role === 'assistant' && message.content) {
    const speakBtn = el('button', 'speak', '朗读');
    meta.appendChild(speakBtn);
    if (message.meta?.innerThought && state.settings?.ui?.showInnerThought !== false) {
      const toggle = el('button', 'thought-toggle', '心里话');
      meta.appendChild(toggle);
    }
  }
  wrap.appendChild(meta);

  if (message.meta?.innerThought && state.settings?.ui?.showInnerThought !== false) {
    wrap.appendChild(el('div', 'thought hidden', `她的心里话：${message.meta.innerThought}`));
  }

  node.appendChild(wrap);
  box.appendChild(node);
  scrollMessages(false);
  return bubble;
}

function appendStreamingBubble() {
  const box = $('#messages');
  const node = el('div', 'msg assistant');
  const avatar = el('img', 'msg-avatar');
  avatar.src = '/assets/avatar.png';
  avatar.alt = '小知';
  node.appendChild(avatar);
  const wrap = el('div', 'bubble-wrap');
  const bubble = el('div', 'bubble streaming');
  wrap.appendChild(bubble);
  node.appendChild(wrap);
  box.appendChild(node);
  scrollMessages(false);
  return bubble;
}

function appendErrorMessage(text) {
  const node = el('div', 'msg assistant error');
  const avatar = el('img', 'msg-avatar');
  avatar.src = '/assets/avatar.png';
  avatar.alt = '小知';
  node.appendChild(avatar);
  const wrap = el('div', 'bubble-wrap');
  wrap.appendChild(el('div', 'bubble', `（刚刚卡住了：${text}）`));
  wrap.appendChild(el('div', 'msg-meta', fmtClock(new Date().toISOString())));
  node.appendChild(wrap);
  $('#messages').appendChild(node);
  scrollMessages(false);
}

async function refreshMessageMeta(id) {
  if (!id) return;
  if (state.settings?.ui?.showInnerThought === false) return;
  const data = await api(`/api/messages/${id}`);
  const message = data.message;
  if (!message?.meta?.innerThought) return;
  const node = $(`.msg[data-message-id="${id}"]`);
  const wrap = node?.querySelector('.bubble-wrap');
  const meta = wrap?.querySelector('.msg-meta');
  if (!wrap || !meta) return;
  let thought = wrap.querySelector('.thought');
  if (!thought) {
    thought = el('div', 'thought hidden', `她的心里话：${message.meta.innerThought}`);
    wrap.appendChild(thought);
  } else {
    thought.textContent = `她的心里话：${message.meta.innerThought}`;
  }
  if (!meta.querySelector('.thought-toggle')) {
    meta.appendChild(el('button', 'thought-toggle', '心里话'));
  }
}

function showTyping(text = '小知正在输入…') {
  $('#typingText').textContent = text;
  $('#typing').classList.remove('hidden');
  scrollMessages(false);
}

function hideTyping() {
  $('#typing').classList.add('hidden');
}

function setStreaming(value) {
  state.streaming = value;
  const sendBtn = $('#sendBtn');
  sendBtn.textContent = value ? '停止' : '发送';
  sendBtn.classList.toggle('warn', value);
  $('#chatInput').disabled = value;
  $('#imageBtn').disabled = value;
  if (!value) $('#chatInput').focus();
}

async function sendMessage() {
  if (state.streaming) {
    state.abortController?.abort();
    return;
  }
  const input = $('#chatInput');
  const text = input.value.trim();
  const images = state.images.slice();
  if (!text && !images.length) return;

  state.chatEpoch += 1;
  clearWelcome();
  appendMessage(
    {
      role: 'user',
      content: text || '（发来了一张图片）',
      created_at: new Date().toISOString(),
      meta: { hasImage: images.length > 0 },
    },
    { images },
  );
  input.value = '';
  autoResize(input);
  clearImages();
  showTyping();
  setStreaming(true);

  const controller = new AbortController();
  state.abortController = controller;
  let streamingBubble = null;
  let finished = false;

  try {
    const res = await fetch(withToken('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-BiZhi-Request': '1' },
      body: JSON.stringify({ text, images }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let message = `请求失败（${res.status}）`;
      try {
        const data = await res.json();
        message = data.error || message;
      } catch {
        // ignore
      }
      throw new Error(message);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf('\n\n');
        const line = chunk.split('\n').find((l) => l.trim().startsWith('data:'));
        if (!line) continue;
        const payload = line.replace(/^data:\s*/, '').trim();
        if (!payload || payload === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event.type === 'delta') {
          hideTyping();
          if (!streamingBubble) streamingBubble = appendStreamingBubble();
          streamingBubble.dataset.text = (streamingBubble.dataset.text || '') + event.delta;
          streamingBubble.textContent = streamingBubble.dataset.text;
          scrollMessages(false);
        } else if (event.type === 'thinking') {
          if (!streamingBubble) showTyping('她正在想…');
        } else if (event.type === 'done') {
          finished = true;
          hideTyping();
          if (streamingBubble) {
            streamingBubble.closest('.msg')?.remove();
            streamingBubble = null;
          }
          appendMessage(event.message);
          if (state.ttsAuto) speak(event.message.content);
          loadStatus().catch(() => {});
          setTimeout(() => loadMemory().catch(() => {}), 3200);
          for (const delay of [4500, 9000]) {
            setTimeout(() => {
              refreshMessageMeta(event.message.id).catch(() => {});
              loadStatus().catch(() => {});
            }, delay);
          }
        } else if (event.type === 'error') {
          throw new Error(event.message || '生成失败');
        }
      }
    }
    if (!finished) {
      hideTyping();
      if (streamingBubble) {
        streamingBubble.closest('.msg')?.remove();
        streamingBubble = null;
      }
      await sleep(500);
      await loadMessages();
    }
  } catch (error) {
    hideTyping();
    if (streamingBubble) {
      streamingBubble.closest('.msg')?.remove();
      streamingBubble = null;
    }
    if (error.name === 'AbortError') {
      toast('已经让她停下了。');
      setTimeout(() => loadMessages().catch(() => {}), 800);
    } else {
      appendErrorMessage(error.message);
      toast(error.message, 'error');
      setTimeout(() => loadMessages().catch(() => {}), 1200);
    }
  } finally {
    setStreaming(false);
    state.abortController = null;
    loadMessages().catch(() => {});
  }
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(180, textarea.scrollHeight)}px`;
}

/* ---------------- images ---------------- */

async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const max = 1280;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0f1a';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  let quality = 0.86;
  let data = canvas.toDataURL('image/jpeg', quality);
  while (data.length > 5 * 1024 * 1024 && quality > 0.5) {
    quality -= 0.08;
    data = canvas.toDataURL('image/jpeg', quality);
  }
  if (data.length > 8 * 1024 * 1024) throw new Error('图片太大，压不下去');
  return data;
}

async function addImages(files) {
  for (const file of [...files]) {
    if (state.images.length >= 4) {
      toast('最多 4 张图。');
      break;
    }
    if (!file.type.startsWith('image/')) continue;
    try {
      const data = await compressImage(file);
      state.images.push(data);
    } catch {
      toast('这张图读不出来，换一张试试。', 'error');
    }
  }
  renderImagePreview();
}

function renderImagePreview() {
  const box = $('#imagePreview');
  box.innerHTML = '';
  state.images.forEach((src, index) => {
    const chip = el('div', 'image-chip');
    const img = el('img');
    img.src = src;
    img.alt = '待发送图片';
    chip.appendChild(img);
    const remove = el('button', '', '×');
    remove.title = '移除';
    remove.addEventListener('click', () => {
      state.images.splice(index, 1);
      renderImagePreview();
    });
    chip.appendChild(remove);
    box.appendChild(chip);
  });
}

function clearImages() {
  state.images = [];
  renderImagePreview();
}

/* ---------------- speech ---------------- */

function speak(text) {
  if (!('speechSynthesis' in window)) {
    toast('这个浏览器不支持朗读。', 'error');
    return;
  }
  if (!text) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(String(text).slice(0, 500));
  utterance.lang = 'zh-CN';
  utterance.rate = 1.03;
  utterance.pitch = 1.12;
  const voices = synth.getVoices();
  const zh = voices.filter((v) => /zh|chinese/i.test(`${v.lang} ${v.name}`));
  const preferred =
    zh.find((v) => /xiaoxiao|huihui|yaoyao|tingting|female|女/i.test(v.name)) || zh[0];
  if (preferred) utterance.voice = preferred;
  synth.speak(utterance);
}

function updateVoiceButton() {
  const btn = $('#voiceBtn');
  if (!btn) return;
  btn.textContent = `自动朗读：${state.ttsAuto ? '开' : '关'}`;
  btn.classList.toggle('active', state.ttsAuto);
}

/* ---------------- memory ---------------- */

async function loadMemory() {
  const data = await api('/api/memory/overview');
  state.memory = data;
  $('#countCore').textContent = (data.core || []).length;
  $('#countMid').textContent = (data.mid || []).length;
  $('#countLong').textContent = (data.long || []).length;
  $('#countLetters').textContent = (data.letters || []).length;
  renderMemory();
  renderMemoryPeek();
}

function memoryItems() {
  if (!state.memory) return [];
  if (state.memoryTab === 'letters') return state.memory.letters || [];
  return state.memory[state.memoryTab] || [];
}

function renderMemory() {
  const box = $('#memoryContent');
  box.innerHTML = '';
  const items = memoryItems();
  if (!items.length) {
    const messages = {
      core: '还没有核心档案。写点你希望她永远记得的事。',
      mid: '还没有重点记忆。多聊几句，她会自己整理。',
      long: '还没有周记。周末晚上她会长篇写一次，也可以现在让她写。',
      letters: '还没有信。她会把告别和惦记都写下来。',
    };
    box.appendChild(el('div', 'empty', messages[state.memoryTab] || '还没有内容。'));
    return;
  }

  if (state.memoryTab === 'letters') {
    for (const letter of items) {
      const row = el('div', 'letter-row');
      const main = el('div');
      main.appendChild(el('h4', '', `${letter.kind} · ${letter.name.replace(/\.md$/, '')}`));
      main.appendChild(el('p', '', `${new Date(letter.mtime).toLocaleString('zh-CN')} · ${Math.ceil(letter.size / 1024)} KB`));
      row.appendChild(main);
      row.appendChild(el('span', '', '读一读'));
      row.addEventListener('click', () => openLetter(letter.name));
      box.appendChild(row);
    }
    return;
  }

  for (const item of items) {
    const card = el('div', 'mem-card');
    const main = el('div', 'mem-main');
    main.appendChild(el('p', '', item.content));
    const meta = el('div', 'mem-meta');
    meta.appendChild(el('span', 'stars', '★'.repeat(item.importance) + '☆'.repeat(5 - item.importance)));
    for (const tag of item.tags || []) meta.appendChild(el('span', 'tag', tag));
    meta.appendChild(el('span', '', `${fmtDate(item.updated_at)} · 想起 ${item.use_count || 0} 次`));
    if (item.reasoning) meta.appendChild(el('span', '', item.reasoning));
    main.appendChild(meta);
    card.appendChild(main);
    const del = el('button', 'del', '删除');
    del.addEventListener('click', async () => {
      if (!confirm('删掉这条记忆？删掉之后她就不记得了。')) return;
      try {
        await api(`/api/memories/${item.id}`, { method: 'DELETE' });
        toast('已经忘掉这条了。');
        await loadMemory();
        await loadStatus();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    card.appendChild(del);
    box.appendChild(card);
  }
}

function renderMemoryPeek() {
  const box = $('#memoryPeek');
  box.innerHTML = '';
  const items = state.memory ? state.memory.mid.slice(0, 3) : [];
  if (!items.length && state.memory) {
    for (const item of state.memory.core.slice(0, 3)) items.push(item);
  }
  if (!items.length) {
    box.appendChild(el('div', 'peek-item', '还没有。聊着聊着就有了。'));
    return;
  }
  for (const item of items) {
    box.appendChild(el('div', 'peek-item', item.content.length > 52 ? `${item.content.slice(0, 52)}…` : item.content));
  }
}

function setMemoryTab(tab) {
  state.memoryTab = tab;
  $$('#memoryTabs button').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  renderMemory();
}

async function addMemory() {
  const content = $('#memoryContentInput').value.trim();
  if (!content) {
    toast('写点什么再让她记。', 'error');
    return;
  }
  const importance = Number($('#memoryImportance').value) || 5;
  try {
    await api('/api/memories', { method: 'POST', body: { layer: 'core', content, importance, tags: ['核心档案', '手动'] } });
    $('#memoryContentInput').value = '';
    toast('她记住了。');
    await loadMemory();
    await loadStatus();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function openLetter(name) {
  try {
    const data = await api(`/api/letters/${encodeURIComponent(name)}`);
    $('#letterTitle').textContent = name.replace(/\.md$/, '');
    $('#letterBody').textContent = data.content;
    $('#letterModal').hidden = false;
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ---------------- social ---------------- */

async function loadPosts() {
  const data = await api('/api/posts');
  state.posts = data.posts || [];
  state.labels = data.labels || state.labels;
  renderPosts();
}

async function loadQzoneFeed(refresh = false) {
  const box = $('#qzoneFeed');
  if (!box) return;
  try {
    const data = await api(`/api/qzone/feed${refresh ? '?refresh=1' : ''}`);
    renderQzoneFeed(data);
  } catch (error) {
    box.innerHTML = '';
    box.appendChild(el('div', 'empty', `空间没读出来：${error.message}`));
    if (error.message.includes('Cookie')) {
      box.appendChild(el('p', 'muted small', '先到「设置 → 社交」保存完整 Cookie，点「验证 Cookie」通过后再刷新。'));
    }
  }
}

function renderQzoneFeed(feed) {
  const box = $('#qzoneFeed');
  box.innerHTML = '';
  const posts = feed?.posts || [];
  if (!posts.length) {
    box.appendChild(el('div', 'empty', '还没读到说说。先确认空间 Cookie 验证通过，再点「刷新空间」。'));
    return;
  }
  for (const post of posts) {
    const card = el('div', 'qzone-post');
    const head = el('div', 'qzone-post-head');
    head.appendChild(el('span', '', post.createdAt ? new Date(post.createdAt).toLocaleString('zh-CN') : ''));
    const likeText = post.likeCount == null ? '赞未提供' : `赞 ${post.likeCount}`;
    head.appendChild(el('span', '', `${likeText} · 评论 ${post.commentCount || 0}`));
    card.appendChild(head);
    card.appendChild(el('div', 'qzone-post-body', post.content || '（空说说）'));
    if (post.likes?.length) {
      card.appendChild(el('div', 'qzone-likes', `点赞：${post.likes.map((x) => x.nickname || x.uin).filter(Boolean).join('、')}`));
    } else if (post.likeCount) {
      card.appendChild(el('div', 'qzone-likes', `点赞 ${post.likeCount} 个（Qzone 没给名单）`));
    }
    const comments = el('div', 'qzone-comments');
    for (const comment of post.comments || []) {
      const row = el('div', 'qzone-comment');
      const main = el('div', 'qzone-comment-main');
      const who = el('b', '', `${comment.nickname || comment.uin || '有人'}：`);
      main.appendChild(who);
      main.appendChild(el('span', '', comment.content || ''));
      row.appendChild(main);
      const reply = el('button', '', '让她回');
      reply.addEventListener('click', () => openCommentDraft(post, comment, row, feed.uin));
      row.appendChild(reply);
      comments.appendChild(row);
      for (const child of comment.replies || []) {
        const replyRow = el('div', 'qzone-comment qzone-reply');
        const replyMain = el('div', 'qzone-comment-main');
        replyMain.appendChild(el('b', '', `↳ ${child.nickname || child.uin || '有人'}：`));
        replyMain.appendChild(el('span', '', child.content || ''));
        replyRow.appendChild(replyMain);
        comments.appendChild(replyRow);
      }
    }
    if (!(post.comments || []).length) {
      comments.appendChild(el('div', 'muted small', '这条说说还没有评论。'));
    }
    card.appendChild(comments);
    box.appendChild(card);
  }
}

function openCommentDraft(post, comment, row, postUin) {
  if (row.querySelector('.reply-editor')) return;
  const editor = el('div', 'reply-editor');
  const area = el('textarea');
  area.rows = 2;
  area.placeholder = '正在想怎么回…';
  area.disabled = true;
  editor.appendChild(area);
  const buttons = el('div', 'btn-row');
  const send = el('button', 'primary-btn', '发送回复');
  send.disabled = true;
  const cancel = el('button', '', '取消');
  cancel.addEventListener('click', () => editor.remove());
  buttons.appendChild(send);
  buttons.appendChild(cancel);
  editor.appendChild(buttons);
  row.appendChild(editor);

  api('/api/qzone/comments/draft', {
    method: 'POST',
    body: { postContent: post.content, comment: { nickname: comment.nickname, content: comment.content } },
  })
    .then((data) => {
      area.disabled = false;
      area.value = data.text || '';
      send.disabled = !area.value;
      area.focus();
    })
    .catch((error) => {
      area.disabled = false;
      area.value = `（没想出来：${error.message}）`;
    });

  send.addEventListener('click', () => withBusy(send, async () => {
    try {
      await api('/api/qzone/comments/reply', {
        method: 'POST',
        body: {
          tid: post.tid,
          content: area.value.trim(),
          commentId: comment.id,
          replyUin: comment.uin,
          postUin,
        },
      });
      toast('评论回复发出去了。');
      await loadQzoneFeed(true);
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
}

function postText(post) {
  const parts = [];
  if (post.title) parts.push(post.title);
  if (post.meta?.hook) parts.push(post.meta.hook);
  parts.push(post.content);
  if (post.tags?.length) parts.push(post.tags.map((t) => `#${t}`).join(' '));
  return parts.filter(Boolean).join('\n\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('复制好了。');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast('复制好了。');
  }
}

function renderPosts() {
  const box = $('#postList');
  box.innerHTML = '';
  if (!state.posts.length) {
    box.appendChild(el('div', 'empty', '还没有草稿。让她写一条，看看她今天想说什么。'));
    return;
  }
  for (const post of state.posts) {
    const card = el('div', 'card post-card');
    const head = el('div', 'post-head');
    head.appendChild(el('span', `platform-chip ${post.kind}`, state.labels[post.kind] || post.kind));
    const statusMap = { draft: '草稿', approved: '已批准', posted: '已发布' };
    head.appendChild(el('span', `status-chip ${post.status}`, statusMap[post.status] || post.status));
    card.appendChild(head);
    if (post.title) card.appendChild(el('h4', '', post.title));
    if (post.meta?.hook) card.appendChild(el('p', 'muted small', `钩子：${post.meta.hook}`));
    card.appendChild(el('div', 'post-body', post.content));
    if (post.tags?.length) {
      const tags = el('div', 'post-tags');
      for (const tag of post.tags) tags.appendChild(el('span', 'tag', `#${tag}`));
      card.appendChild(tags);
    }
    card.appendChild(el('p', 'muted small', `${new Date(post.created_at).toLocaleString('zh-CN')} · AI 生成，发布前请确认`));
    if (post.error) card.appendChild(el('p', 'small', `上次失败：${post.error}`));

    const actions = el('div', 'post-actions');
    if (post.status === 'draft') {
      const approve = el('button', '', '批准');
      approve.addEventListener('click', () => withBusy(approve, async () => {
        try {
          await api(`/api/posts/${post.id}/approve`, { method: 'POST' });
          toast('批准了。');
          await loadPosts();
        } catch (error) {
          toast(error.message, 'error');
        }
      }));
      actions.appendChild(approve);
    }
    const copy = el('button', '', '复制文案');
    copy.addEventListener('click', () => copyText(postText(post)));
    actions.appendChild(copy);
    if (post.status === 'approved') {
      const published = el('button', '', '标记已发');
      published.addEventListener('click', async () => {
        try {
          await api(`/api/posts/${post.id}/posted`, { method: 'POST', body: { note: '手动发布' } });
          toast('标记成已发布了。');
          await loadPosts();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
      actions.appendChild(published);
      if (post.kind === 'qzone') {
        const auto = el('button', '', '尝试自动发布');
        auto.addEventListener('click', () => withBusy(auto, async () => {
          try {
            const result = await api(`/api/posts/${post.id}/publish`, { method: 'POST' });
            if (result.ok) {
              toast('发布成功了。');
              await loadPosts();
            } else {
              toast(result.reason || '没有发出去', 'error');
            }
          } catch (error) {
            toast(error.message, 'error');
          }
        }));
        actions.appendChild(auto);
      }
    }
    const externalUrl = safeExternalUrl(post.external_url);
    if (externalUrl) {
      const link = el('a', '', '打开');
      link.href = externalUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.className = 'link-btn';
      actions.appendChild(link);
    }
    const del = el('button', 'del', '删除');
    del.addEventListener('click', async () => {
      if (!confirm('删掉这条草稿？')) return;
      try {
        await api(`/api/posts/${post.id}`, { method: 'DELETE' });
        await loadPosts();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    actions.appendChild(del);
    card.appendChild(actions);
    box.appendChild(card);
  }
}

async function generatePost(kind) {
  try {
    await api('/api/posts/generate', { method: 'POST', body: { kind } });
    toast('草稿写好了，你看看。');
    await loadPosts();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function generateComments() {
  const context = $('#commentContext').value.trim();
  if (!context) {
    toast('先把视频或笔记的内容贴进来。', 'error');
    return;
  }
  const button = $('#genCommentsBtn');
  await withBusy(button, async () => {
    try {
      const data = await api('/api/social/comments', {
        method: 'POST',
        body: { context, platform: $('#commentPlatform').value },
      });
      const box = $('#commentResults');
      box.innerHTML = '';
      for (const comment of data.comments || []) {
        const row = el('div', 'comment-item');
        row.appendChild(el('span', '', comment));
        const copy = el('button', '', '复制');
        copy.addEventListener('click', () => copyText(comment));
        row.appendChild(copy);
        box.appendChild(row);
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

/* ---------------- 表情库找图 ---------------- */

async function loadStickerStatus() {
  const line = $('#stickerFindResult');
  if (!line) return;
  try {
    const data = await api('/api/stickers/status');
    line.textContent = `表情库里 ${data.total} 张；她今天自己收了 ${data.adoptedToday}/${data.dailyMax} 张。`;
  } catch (error) {
    line.textContent = `读取表情库失败：${error.message}`;
  }
}

async function stickerFind() {
  await withBusy($('#stickerFindBtn'), async () => {
    const line = $('#stickerFindResult');
    try {
      line.textContent = '她正在搜图、挑能收的…';
      const data = await api('/api/stickers/find', {
        method: 'POST',
        body: { query: $('#stickerQuery').value.trim() || '蓝鲸鱼 表情包', limit: 3 },
      });
      line.textContent = data.adopted?.length
        ? `收了 ${data.adopted.length} 张：${data.adopted.map((a) => a.file).join('、')}。库里现在 ${data.total} 张。`
        : `一张都没收进来${data.skipped ? `（${data.skipped}）` : ''}${data.failed?.length ? `：${data.failed.join('；')}` : ''}`;
      toast(data.adopted?.length ? '她找到图了。' : '这次没找到能收的图。', data.adopted?.length ? 'ok' : 'error');
    } catch (error) {
      line.textContent = `找图失败：${error.message}`;
      toast(error.message, 'error');
    }
  });
}

async function stickerMemes() {
  await withBusy($('#stickerMemeBtn'), async () => {
    const line = $('#stickerFindResult');
    try {
      line.textContent = '在拉现成梗图模板…';
      const data = await api('/api/stickers/memes', { method: 'POST', body: { limit: 3 } });
      line.textContent = `收了 ${data.adopted.length} 张梗图模板，库里现在 ${data.total} 张。`;
      toast('梗图模板收好了。');
    } catch (error) {
      line.textContent = `没收成：${error.message}`;
      toast(error.message, 'error');
    }
  });
}

/* ---------------- 小红书图文笔记 ---------------- */

async function loadXhsNoteImages() {
  const sel = $('#xhsNoteImages');
  if (!sel) return;
  try {
    const data = await api('/api/xhs/images');
    const images = data.images || [];
    sel.innerHTML = '';
    for (const image of images) {
      const option = document.createElement('option');
      option.value = image.name;
      option.textContent = `${image.name}（${Math.round((image.bytes || 0) / 1024)}KB）`;
      sel.appendChild(option);
    }
    $('#xhsNoteResult').textContent = images.length
      ? `本机有 ${images.length} 张可选图片，按住 Ctrl 可以多选。`
      : '本机没有可选图片，先把公开素材放进 data/public-media 再刷新。';
  } catch (error) {
    $('#xhsNoteResult').textContent = `读取可选图片失败：${error.message}`;
  }
}

function pickedXhsImages() {
  return [...$('#xhsNoteImages').selectedOptions].map((option) => option.value).slice(0, 18);
}

function showXhsNoteResult(data, prefix = '') {
  $('#xhsNoteResult').textContent =
    `${prefix}标题「${data.title || ''}」，正文 ${(data.body || '').length} 字，编辑器里显示 ${data.imageCount || 0} 张图。` +
    '这一步只填了编辑器，没有发布。';
  const shot = $('#xhsNoteShot');
  if (data.screenshotUrl) {
    shot.src = `${data.screenshotUrl}?t=${Date.now()}`;
    shot.hidden = false;
  } else {
    shot.hidden = true;
  }
}

async function fillXhsNoteEditor() {
  return api('/api/xhs/note/preview', {
    method: 'POST',
    body: { title: $('#xhsNoteTitle').value, body: $('#xhsNoteBody').value, images: pickedXhsImages() },
  });
}

async function xhsNoteFill() {
  await withBusy($('#xhsNoteFill'), async () => {
    try {
      $('#xhsNoteResult').textContent = '正在上传图片并填写，别关页面…';
      const data = await fillXhsNoteEditor();
      showXhsNoteResult(data, '已填进创作中心。');
      toast('已经填进创作中心，还没发布。');
    } catch (error) {
      $('#xhsNoteResult').textContent = `填写失败：${error.message}`;
      toast(error.message, 'error');
    }
  });
}

async function xhsNotePublish() {
  if (!$('#xhsNoteConfirm').checked) {
    toast('先勾选「我确认这条要真的发出去」。', 'error');
    return;
  }
  if (!confirm('真的要把这条笔记公开到小红书吗？发出去所有人都能看到。')) return;
  await withBusy($('#xhsNotePublish'), async () => {
    try {
      $('#xhsNoteResult').textContent = '正在填编辑器…';
      const filled = await fillXhsNoteEditor();
      showXhsNoteResult(filled, '填好了，正在点发布…');
      const data = await api('/api/xhs/note/publish', { method: 'POST', body: { confirm: true } });
      $('#xhsNoteResult').textContent = data.published
        ? `已发布（${new Date(data.at).toLocaleString('zh-CN')}）。`
        : '没有确认发布成功，去创作中心「笔记管理」看一眼，别重复点。';
      toast(data.published ? '小红书笔记已发布。' : '发布结果没确认，请人工看一眼。', data.published ? 'ok' : 'error');
    } catch (error) {
      $('#xhsNoteResult').textContent = `发布失败：${error.message}`;
      toast(error.message, 'error');
    }
  });
}

async function xhsNoteStash() {
  await withBusy($('#xhsNoteStash'), async () => {
    try {
      $('#xhsNoteResult').textContent = '正在填编辑器…';
      const filled = await fillXhsNoteEditor();
      showXhsNoteResult(filled, '填好了，正在存草稿…');
      const data = await api('/api/xhs/note/stash', { method: 'POST' });
      $('#xhsNoteResult').textContent = `已存进小红书草稿箱（${data.before} → ${data.after} 条）。`;
      toast('笔记已存进草稿箱。');
    } catch (error) {
      $('#xhsNoteResult').textContent = `存草稿失败：${error.message}`;
      toast(error.message, 'error');
    }
  });
}

async function xhsNoteLeave() {
  await withBusy($('#xhsNoteLeave'), async () => {
    try {
      await api('/api/xhs/note/leave', { method: 'POST' });
      $('#xhsNoteResult').textContent = '已离开填写页；没点发布也没存草稿的话，小红书不会留这条。';
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

async function loadLatestXhsDraft() {
  try {
    const data = await api('/api/posts');
    const draft = (data.posts || []).find((post) => post.kind === 'xhs');
    if (!draft) {
      toast('还没有小红书草稿，先点「让她写一条 → 小红书笔记」。', 'error');
      return;
    }
    $('#xhsNoteTitle').value = draft.title || '';
    $('#xhsNoteBody').value = draft.content || '';
    toast('已把最近一条小红书草稿填进表单。');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ---------------- settings ---------------- */

function fillVoiceSelect(selected) {
  const sel = $('#setVoiceName');
  if (!sel) return;
  const list = (state.voiceSetup?.voices?.length ? state.voiceSetup.voices : VOICE_FALLBACK).filter(Boolean);
  sel.innerHTML = list
    .map((item) => `<option value="${item.id}">${item.label}${item.note ? `（${item.note}）` : ''}</option>`)
    .join('');
  if (selected) sel.value = selected;
}

function renderVoiceLine() {
  const line = $('#voiceStatusLine');
  if (!line) return;
  const setup = state.voiceSetup;
  if (!setup) {
    line.textContent = '正在读取音色与识别状态…';
    return;
  }
  const engines = setup.engines || {};
  const say = engines.edge ? '微软自然声（在线，可选 12 个音色）' : engines.piper ? '本地 piper（离线）' : '本机语音（Huihui）';
  const asr = setup.asr || {};
  const hear = asr.ready
    ? `SenseVoice 已装好（${asr.modelMb}MB，${asr.warm ? '已加载' : '第一次听时加载'}）`
    : `本地识别没就绪：${asr.error || '模型不在 asr/model'}`;
  const voice = state.status?.qq?.voice || {};
  const sent = voice.enabled
    ? `今天发了 ${voice.today ?? 0}/${voice.maxPerDay ?? 0} 条语音、听懂 ${voice.heardToday ?? 0} 条`
    : '发语音已关闭';
  const listen = voice.listen === false ? '（听语音开关是关的）' : '';
  line.textContent = `发声：${say}；听懂：${hear}；${sent}${listen}。`;
}

async function loadVoiceSetup() {
  const data = await api('/api/voice/setup');
  const previous = $('#setVoiceName')?.value || state.settings?.tts?.voice;
  state.voiceSetup = data;
  fillVoiceSelect(previous);
  renderVoiceLine();
}

async function previewVoice(button) {
  await withBusy(button, async () => {
    const player = $('#voicePreviewPlayer');
    try {
      const data = await api('/api/voice/preview', {
        method: 'POST',
        body: {
          voice: $('#setVoiceName').value,
          rate: String($('#setVoiceRate').value || '').trim(),
          pitch: String($('#setVoicePitch').value || '').trim(),
        },
      });
      player.src = withToken(data.url);
      player.classList.remove('hidden');
      await player.play();
      toast(`刚用的是 ${data.voice || data.engine}。`);
    } catch (error) {
      toast(`试听失败：${error.message}`, 'error');
    }
    renderVoiceLine();
  });
}

async function loadSettings() {
  const data = await api('/api/settings');
  if (state.settingsDirty) return;
  state.settings = data.settings;
  state.meta = data.meta;
  state.persona = data.persona;
  state.ttsAuto = Boolean(data.settings?.ui?.autoSpeak);
  updateVoiceButton();
  fillSettings();
  $('#keyMasked').textContent = data.meta?.keyMasked || '未配置';
  $('#dataDir').textContent = data.meta?.dataDir || '--';
}

function fillSettings() {
  const settings = state.settings;
  if (!settings) return;
  $('#setName').value = settings.companion?.name || '';
  $('#setUserName').value = settings.companion?.userName || '';
  $('#setNickname').value = settings.companion?.nickname || '';
  $('#setIntro').value = settings.companion?.intro || '';
  $('#setModel').value = settings.model?.name || 'deepseek-flash';
  $('#setTemperature').value = settings.model?.temperature ?? 0.95;
  $('#setChatMaxTokens').value = settings.model?.chatMaxTokens ?? 1400;
  $('#setEffort').value = settings.model?.reasoningEffort || 'low';
  $('#setCompactTokens').value = settings.memory?.compactTokens ?? 24000;
  $('#setHandoverTokens').value = settings.memory?.handoverTokens ?? 48000;
  $('#setShortTurns').value = settings.memory?.shortTurns ?? 24;
  $('#setRetrieveCount').value = settings.memory?.retrieveCount ?? 10;
  $('#setReflectMaxTokens').value = settings.model?.reflectMaxTokens ?? 450;
  $('#setReflectEvery').value = settings.model?.reflectEvery ?? 2;
  $('#setMaxContextTokens').value = settings.memory?.maxContextTokens ?? 64000;
  $('#setMaxPromptTokens').value = settings.memory?.maxPromptTokens ?? 6000;
  $('#setRetrieveBudget').value = settings.memory?.retrieveBudgetTokens ?? 2200;
  $('#setDreamEnabled').checked = settings.proactive?.dreamEnabled !== false;
  $('#setDreamHour').value = settings.proactive?.dreamHour ?? 23;
  $('#setProactiveEnabled').checked = Boolean(settings.proactive?.enabled);
  $('#setIdleMin').value = settings.proactive?.idleMinutesMin ?? 25;
  $('#setIdleMax').value = settings.proactive?.idleMinutesMax ?? 120;
  $('#setMaxUnanswered').value = settings.proactive?.maxUnanswered ?? 2;
  $('#setQuietStart').value = settings.proactive?.quietStart || '00:30';
  $('#setQuietEnd').value = settings.proactive?.quietEnd || '08:30';
  $('#setMaxPerDay').value = settings.proactive?.maxPerDay ?? 3;
  $('#setQqEnabled').checked = Boolean(settings.qq?.enabled);
  $('#setAllowAllPrivate').checked = Boolean(settings.qq?.allowAllPrivate);
  $('#setVoiceEnabled').checked = settings.tts?.enabled !== false;
  $('#setVoiceListen').checked = settings.tts?.listen !== false;
  $('#setVoiceMax').value = settings.tts?.maxPerDay ?? 8;
  $('#setVoiceChance').value = settings.tts?.chance ?? 0.18;
  fillVoiceSelect(settings.tts?.voice || 'zh-CN-XiaoxiaoNeural');
  $('#setVoiceRate').value = settings.tts?.rate || '+8%';
  $('#setVoicePitch').value = settings.tts?.pitch || '+2Hz';
  $('#setVoiceMaxChars').value = settings.tts?.maxChars ?? 120;
  $('#setSleepyMode').checked = settings.qq?.sleepyMode !== false;
  renderVoiceLine();
  $('#setQqAutoBind').checked = settings.qq?.autoBindWhitelist !== false;
  $('#setQqBotAccount').value = settings.qq?.botAccount || '';
  $('#setQqAutoRecover').checked = settings.qq?.autoRecover !== false;
  $('#setGroupAtOnly').checked = settings.qq?.groupAtOnly !== false;
  $('#setWhitelist').value = (settings.qq?.whitelist || []).join(', ');
  $('#setGroupWhitelist').value = (settings.qq?.groupWhitelist || []).join(', ');
  $('#setMaxReplies').value = settings.qq?.maxRepliesPerHour ?? 40;
  $('#setSendStickers').checked = settings.qq?.sendStickers !== false;
  $('#setLearnImages').checked = settings.qq?.learnImages !== false;
  $('#setStickerChance').value = settings.qq?.stickerChance ?? 0.2;
  $('#setSelfFollowUp').checked = settings.qq?.selfFollowUp !== false;
  $('#setFollowChance').value = settings.qq?.selfFollowUpChance ?? 0.25;
  $('#setFollowDelay').value = settings.qq?.selfFollowUpDelaySeconds ?? 25;
  $('#setFollowHour').value = settings.qq?.selfFollowUpMaxPerHour ?? 2;
  $('#setFollowDay').value = settings.qq?.selfFollowUpMaxPerDay ?? 6;
  $('#setSocialEnabled').checked = Boolean(settings.social?.enabled);
  $('#setDailyPostMax').value = settings.social?.dailyPostMax ?? 2;
  $('#setPostStart').value = settings.social?.activeStart || '09:30';
  $('#setPostEnd').value = settings.social?.activeEnd || '22:30';
  $('#setQzoneAuto').checked = Boolean(settings.social?.qzoneAutoPost);
  $('#setQzoneAutoReply').checked = settings.social?.qzoneAutoReply !== false;
  $('#setQzoneAutoReplyHourly').value = settings.social?.qzoneAutoReplyMaxPerHour ?? 3;
  $('#setQzoneAutoReplyDaily').value = settings.social?.qzoneAutoReplyMaxPerDay ?? 10;
  $('#setQzoneAutoReplyAge').value = settings.social?.qzoneAutoReplyMaxAgeHours ?? 48;
  $('#setDouyinAuto').checked = Boolean(settings.social?.douyinAutoPost);
  $('#setXhsEnabled').checked = Boolean(settings.social?.xhsEnabled);
  $('#setXhsAutoBrowse').checked = Boolean(settings.social?.xhsAutoBrowse);
  $('#setXhsAutoReply').checked = settings.social?.xhsAutoReply !== false;
  $('#setXhsAutoLike').checked = settings.social?.xhsAutoLike === true;
  $('#setXhsLikeMax').value = settings.social?.xhsDailyLikeMax ?? 5;
  $('#setXhsAutoCollect').checked = settings.social?.xhsAutoCollect === true;
  $('#setXhsCollectMax').value = settings.social?.xhsDailyCollectMax ?? 2;
  $('#setXhsAutoPublish').checked = settings.social?.xhsAutoPublish === true;
  $('#setXhsPublishPerDay').value = settings.social?.xhsPublishPerDay ?? 1;
  $('#setXhsActionMax').value = settings.social?.xhsDailyActionMax ?? 12;
  $('#setXhsPollMin').value = settings.social?.xhsPollHoursMin ?? 2;
  $('#setXhsPollMax').value = settings.social?.xhsPollHoursMax ?? 3.5;
  $('#setXhsOwnerName').value = settings.social?.xhsOwnerName || '';
  $('#setXhsOwnerUserId').value = settings.social?.xhsOwnerUserId || '';
  $('#setXhsSearchKeywords').value = settings.social?.xhsSearchKeywords || '';
  $('#setXhsDailyComment').value = settings.social?.xhsDailyCommentMax ?? 6;
  $('#setXhsDailyReply').value = settings.social?.xhsDailyReplyMax ?? 15;
  $('#setXhsHourly').value = settings.social?.xhsHourlyActionMax ?? 3;
  $('#setXhsDmReply').checked = settings.social?.xhsDmReply === true;
  $('#setXhsDmAutoOwner').checked = settings.social?.xhsDmAutoOwner !== false;
  $('#setXhsDmMaxPerDay').value = settings.social?.xhsDmMaxPerDay ?? 3;
  $('#setXhsDmMaxPerTarget').value = settings.social?.xhsDmMaxPerTarget ?? 1;
  $('#setLowBalanceCny').value = settings.cost?.lowBalanceCny ?? 5;
  $('#setStopBalanceCny').value = settings.cost?.stopBalanceCny ?? 1.5;
  $('#setMaxDailyCostCny').value = settings.cost?.maxDailyCostCny ?? 3;
  $('#setAutoSpeak').checked = Boolean(settings.ui?.autoSpeak);
  $('#setShowThought').checked = settings.ui?.showInnerThought !== false;
  $('#setPersona').value = state.persona || '';
}

function splitList(value) {
  return String(value || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 0 是合法值（= 关掉这一层），所以不能写成 Number(x) || 默认值 */
function numField(input, fallback) {
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}

function collectSettings() {
  const prev = state.settings || {};
  return {
    companion: {
      ...(prev.companion || {}),
      name: $('#setName').value.trim(),
      userName: $('#setUserName').value.trim(),
      nickname: $('#setNickname').value.trim(),
      intro: $('#setIntro').value.trim(),
    },
    model: {
      ...(prev.model || {}),
      name: $('#setModel').value,
      temperature: Number($('#setTemperature').value) || 0.95,
      chatMaxTokens: Number($('#setChatMaxTokens').value) || 1400,
      reasoningEffort: $('#setEffort').value,
      reflectMaxTokens: Number($('#setReflectMaxTokens').value) || 450,
      reflectEvery: Number($('#setReflectEvery').value) || 2,
    },
    memory: {
      ...(prev.memory || {}),
      compactTokens: Number($('#setCompactTokens').value) || 24000,
      handoverTokens: Number($('#setHandoverTokens').value) || 48000,
      shortTurns: Number($('#setShortTurns').value) || 24,
      retrieveCount: Number($('#setRetrieveCount').value) || 10,
      maxContextTokens: Number($('#setMaxContextTokens').value) || 64000,
      maxPromptTokens: Number($('#setMaxPromptTokens').value) || 6000,
      retrieveBudgetTokens: Number($('#setRetrieveBudget').value) || 2200,
    },
    proactive: {
      ...(prev.proactive || {}),
      enabled: $('#setProactiveEnabled').checked,
      idleMinutesMin: Math.max(1, Number($('#setIdleMin').value) || 25),
      idleMinutesMax: Math.max(1, Number($('#setIdleMax').value) || 120),
      maxUnanswered: Math.max(1, Number($('#setMaxUnanswered').value) || 2),
      quietStart: $('#setQuietStart').value || '00:30',
      quietEnd: $('#setQuietEnd').value || '08:30',
      maxPerDay: Number($('#setMaxPerDay').value) || 0,
      dreamEnabled: $('#setDreamEnabled').checked,
      dreamHour: Number($('#setDreamHour').value) || 0,
    },
    qq: {
      ...(prev.qq || {}),
      enabled: $('#setQqEnabled').checked,
      allowAllPrivate: $('#setAllowAllPrivate').checked,
      autoBindWhitelist: $('#setQqAutoBind').checked,
      botAccount: String($('#setQqBotAccount').value || '').trim(),
      autoRecover: $('#setQqAutoRecover').checked,
      groupAtOnly: $('#setGroupAtOnly').checked,
      whitelist: splitList($('#setWhitelist').value),
      groupWhitelist: splitList($('#setGroupWhitelist').value),
      maxRepliesPerHour: Number($('#setMaxReplies').value) || 40,
      sendStickers: $('#setSendStickers').checked,
      stickerChance: Number($('#setStickerChance').value) || 0,
      learnImages: $('#setLearnImages').checked,
      selfFollowUp: $('#setSelfFollowUp').checked,
      selfFollowUpChance: Number($('#setFollowChance').value) || 0,
      selfFollowUpDelaySeconds: Number($('#setFollowDelay').value) || 25,
      selfFollowUpMaxPerHour: Number($('#setFollowHour').value) || 0,
      selfFollowUpMaxPerDay: Number($('#setFollowDay').value) || 0,
      sleepyMode: $('#setSleepyMode').checked,
    },
    tts: {
      ...(prev.tts || {}),
      enabled: $('#setVoiceEnabled').checked,
      listen: $('#setVoiceListen').checked,
      maxPerDay: Number($('#setVoiceMax').value) || 0,
      chance: Number($('#setVoiceChance').value) || 0,
      voice: $('#setVoiceName').value,
      rate: String($('#setVoiceRate').value || '').trim() || '+8%',
      pitch: String($('#setVoicePitch').value || '').trim() || '+2Hz',
      maxChars: Number($('#setVoiceMaxChars').value) || prev.tts?.maxChars || 120,
    },
    social: {
      ...(prev.social || {}),
      enabled: $('#setSocialEnabled').checked,
      dailyPostMax: Number($('#setDailyPostMax').value) || 0,
      activeStart: $('#setPostStart').value || '09:30',
      activeEnd: $('#setPostEnd').value || '22:30',
      qzoneAutoPost: $('#setQzoneAuto').checked,
      qzoneAutoReply: $('#setQzoneAutoReply').checked,
      qzoneAutoReplyMaxPerHour: Number($('#setQzoneAutoReplyHourly').value) || 3,
      qzoneAutoReplyMaxPerDay: Number($('#setQzoneAutoReplyDaily').value) || 10,
      qzoneAutoReplyMaxAgeHours: Number($('#setQzoneAutoReplyAge').value) || 48,
      douyinAutoPost: $('#setDouyinAuto').checked,
      xhsEnabled: $('#setXhsEnabled').checked,
      xhsAutoBrowse: $('#setXhsAutoBrowse').checked,
      xhsAutoReply: $('#setXhsAutoReply').checked,
      xhsAutoLike: $('#setXhsAutoLike').checked,
      xhsDailyLikeMax: Number($('#setXhsLikeMax').value) || 0,
      xhsAutoCollect: $('#setXhsAutoCollect').checked,
      xhsDailyCollectMax: Number($('#setXhsCollectMax') ? $('#setXhsCollectMax').value : 0) || 0,
      xhsAutoPublish: $('#setXhsAutoPublish').checked,
      xhsPublishPerDay: Number($('#setXhsPublishPerDay').value) || 0,
      xhsDailyActionMax: Number($('#setXhsActionMax').value) || 0,
      xhsPollHoursMin: Number($('#setXhsPollMin').value) || 2,
      xhsPollHoursMax: Number($('#setXhsPollMax').value) || 3.5,
      xhsOwnerName: $('#setXhsOwnerName').value.trim(),
      xhsOwnerUserId: $('#setXhsOwnerUserId').value.trim(),
      xhsSearchKeywords: $('#setXhsSearchKeywords').value.trim(),
      xhsDailyCommentMax: Number($('#setXhsDailyComment').value) || 0,
      xhsDailyReplyMax: Number($('#setXhsDailyReply').value) || 0,
      xhsHourlyActionMax: Number($('#setXhsHourly').value) || 3,
      xhsDmReply: $('#setXhsDmReply').checked,
      xhsDmAutoOwner: $('#setXhsDmAutoOwner').checked,
      xhsDmMaxPerDay: Number($('#setXhsDmMaxPerDay').value) || 0,
      xhsDmMaxPerTarget: Number($('#setXhsDmMaxPerTarget').value) || 1,
    },
    cost: {
      ...(prev.cost || {}),
      lowBalanceCny: numField($('#setLowBalanceCny'), 5),
      stopBalanceCny: numField($('#setStopBalanceCny'), 1.5),
      maxDailyCostCny: numField($('#setMaxDailyCostCny'), 3),
    },
    ui: {
      ...(prev.ui || {}),
      autoSpeak: $('#setAutoSpeak').checked,
      showInnerThought: $('#setShowThought').checked,
    },
  };
}

async function saveSettings() {
  try {
    const data = await api('/api/settings', { method: 'PUT', body: collectSettings() });
    state.settingsDirty = false;
    state.settings = data.settings;
    state.ttsAuto = Boolean(data.settings.ui?.autoSpeak);
    updateVoiceButton();
    fillSettings();
    const hint = $('#saveHint');
    if (hint) {
      hint.textContent = '已保存';
      hint.classList.remove('dirty');
      hint.classList.add('saved');
    }
    toast('设置保存好了。');
    await loadStatus();
    if (state.messages.length) renderMessages();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function savePersona() {
  const persona = $('#setPersona').value.trim();
  if (!persona) {
    toast('人设不能为空。', 'error');
    return;
  }
  try {
    await api('/api/persona', { method: 'PUT', body: { persona } });
    state.persona = persona;
    toast('人设保存好了，下一句话就生效。');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function stopQqQrPolling() {
  if (state.qqQrTimer) clearInterval(state.qqQrTimer);
  state.qqQrTimer = null;
}

function startQqQrPolling() {
  const img = $('#qqQrImg');
  if (!img) return;
  if (state.qqQrTimer) {
    return;
  }
  const refresh = () => {
    img.src = withToken(`/api/qq/qr?t=${Date.now()}`);
  };
  refresh();
  state.qqQrTimer = setInterval(refresh, 4000);
}

async function loadQqSetup() {
  const data = await api('/api/qq/setup');
  $('#qqWs').textContent = data.wsUrl;
  $('#qqToken').textContent = data.token || '（未设置令牌）';
  const qq = data.status || {};
  const lines = [];
  const selfLabel = qq.identityOk === false ? '（不是小号）' : qq.identityOk ? '（机器人）' : '';
  lines.push(qq.connected ? `已连接${qq.selfId ? ` · ${qq.selfId}${selfLabel}` : ''}` : '未连接');
  if (data.settings?.enabled === false) lines.push('QQ 通道现在是停用的：扫码后也不会连上，点「用机器人小号重新登录」会自动启用');
  else if (!qq.connected) lines.push('通道已启用，正在等 QQ 登录');
  if (data.ownerId) lines.push(`主人 QQ：${data.ownerId}`);
  state.qqOwnerId = data.ownerId || '';
  const ownerInput = $('#qqOwnerInput');
  if (ownerInput && document.activeElement !== ownerInput && !ownerInput.dataset.dirty) ownerInput.value = data.ownerId || '';
  if (qq.lastError) lines.push(`最近错误：${String(qq.lastError).replace(/\s+/g, ' ').slice(0, 100)}`);
  lines.push(data.installed ? `NapCat 目录：${data.dir}` : 'NapCat 还没下载到 napcat/ 目录');
  lines.push(`已学会 ${data.learnedImages || 0} 张图片表情 / ${data.learnedMfaces || 0} 个QQ表情包`);
  if (qq.downMinutes >= 5) lines.push(`QQ 已断开 ${qq.downMinutes} 分钟${qq.autoRecover ? '（她正在试着自己恢复）' : ''}`);
  if (qq.followUp) {
    lines.push(
      qq.followUp.enabled
        ? `自己接话：今天补了 ${qq.followUp.today}/${qq.followUp.dayMax} 句（概率 ${Math.round((qq.followUp.chance || 0) * 100)}%）`
        : '自己接话：已关闭',
    );
  }
  $('#qqStatusText').textContent = lines.join('\n');
  const warn = $('#qqAccountWarn');
  if (warn) {
    const selfId = String(qq.selfId || '');
    const owner = String(data.ownerId || '');
    const dangerous = Boolean(selfId && owner && selfId === owner);
    const protocolBad = Boolean(qq.connected && qq.lastError);
    const mismatch = qq.connected && qq.identityOk === false;
    warn.hidden = !(dangerous || protocolBad || mismatch);
    warn.classList.toggle('hidden', !(dangerous || protocolBad || mismatch));
    if (dangerous) {
      warn.textContent = `危险：现在挂着的就是你本人的 QQ 号 ${selfId}，她说出口的每一句都是以"你"的身份发的。`
        + '先点「立刻停用 QQ 通道」（会退出这个 QQ），再点「用机器人小号重新登录」，换登录小号的设备扫码。';
    } else if (mismatch) {
      warn.textContent = `当前账号不是配置的机器人号，所有发送已拦下：${qq.identityError || ''}`;
    } else if (protocolBad) {
      warn.textContent = `QQ 登录信息还在，但账号发不出消息：${String(qq.lastError).replace(/\s+/g, ' ').slice(0, 100)}。`
        + '多半是电脑上同时开着你的主号 QQ，两个号共用同一份登录数据；先关掉主号 QQ 窗口，再点「立刻停用 QQ 通道」→「用机器人小号重新登录」。';
    }
  }
  const qrBox = $('#qqQrBox');
  if (qrBox) {
    const showQr = !qq.connected && data.qrAvailable;
    qrBox.hidden = !showQr;
    if (showQr) {
      const bot = data.settings?.botAccount || '机器人小号';
      const at = data.qrUpdatedAt ? new Date(data.qrUpdatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      const ageMs = data.qrUpdatedAt ? Date.now() - new Date(data.qrUpdatedAt).getTime() : 0;
      const stale = ageMs > 3 * 60000;
      const img = $('#qqQrImg');
      if (img) img.hidden = stale;
      const hint = $('#qqQrHint');
      if (hint) {
        hint.textContent = stale
          ? `二维码已过期（${at || '时间未知'} 生成），别再扫了，点下面「重新生成」。扫码手机必须先登录小号 ${bot}；用主号手机扫会失败或登成主号。`
          : `机器人小号 ${bot}${at ? ` · ${at} 生成` : ''}。必须用已经登录这个小号的手机扫；用主号手机扫会失败或登成主号。扫码成功后这里会自动变成已连接。`;
      }
      startQqQrPolling();
    } else {
      stopQqQrPolling();
      if (qq.connected) {
        const hint = $('#qqQrHint');
        if (hint) hint.textContent = '已经连上了，不需要再扫码。';
      }
    }
  }
  const candidate = data.candidate;
  $('#qqCandidateBox').hidden = !candidate;
  if (candidate) {
    $('#qqCandidateText').textContent = `${candidate.nickname || '未知'}（${candidate.userId}）`;
    $('#qqBindOwner').dataset.userId = candidate.userId;
  }
}

function stopXhsQrPolling() {
  if (state.xhsQrTimer) clearInterval(state.xhsQrTimer);
  state.xhsQrTimer = null;
}

async function refreshXhsQr(force = false) {
  const img = $('#xhsQrImg');
  const hint = $('#xhsQrHint');
  if (!img || !hint) return;
  try {
    const data = await api(`/api/xhs/qr${force ? '?refresh=1' : ''}`);
    if (data.loggedIn) {
      stopXhsQrPolling();
      img.hidden = true;
      hint.textContent = '小红书已登录。';
      await loadXhsStatus();
      return;
    }
    if (data.dataUrl) {
      img.src = data.dataUrl;
      img.hidden = false;
      hint.textContent = '用手机小红书扫码登录；二维码会自动刷新。';
    } else {
      img.hidden = true;
      hint.textContent = data.hint || '正在准备二维码…';
    }
  } catch (error) {
    img.hidden = true;
    hint.textContent = `二维码读取失败：${error.message}`;
  }
}

function startXhsQrPolling() {
  stopXhsQrPolling();
  refreshXhsQr();
  state.xhsQrTimer = setInterval(refreshXhsQr, 3000);
}

async function loadXhsStatus(verify = false) {
  try {
    const data = await api(`/api/xhs/status${verify ? '?verify=1' : ''}`);
    const previous = state.xhsLoggedIn;
    state.xhsLoggedIn = Boolean(data.loggedIn);
    if (previous === false && data.loggedIn) toast('小红书已登录。');
    if (previous === true && !data.loggedIn) toast('小红书登录失效了，需要重新扫码。', 'error');
    const box = $('#xhsStatusText');
    if (!box) return;
    const bits = [];
    bits.push(data.browserRunning ? '浏览器已启动' : '浏览器未启动');
    bits.push(data.loggedIn ? '已登录' : '未登录');
    if (data.ownerName) bits.push(`主人：${data.ownerName}`);
    if (data.ownerUserId) bits.push(`ID：${data.ownerUserId}`);
    if (data.lastError) bits.push(`最近错误：${data.lastError}`);
    box.textContent = bits.join(' · ');
    const line = $('#xhsAccountLine');
    if (line) {
      line.textContent = data.loggedIn
        ? `当前登录的小红书账号：${data.selfName || '还没读到昵称'}${data.selfUserId ? ` · ${data.selfUserId}` : ''}（要换号就点「退出登录（换号）」再扫码）`
        : '当前登录的小红书账号：未登录';
    }
  } catch (error) {
    const box = $('#xhsStatusText');
    if (box) box.textContent = `读取失败：${error.message}`;
  }
}

async function loadQzoneStatus() {
  const data = await api('/api/qzone/status');
  const box = $('#qzoneStatus');
  if (!box) return;
  if (!data.configured) {
    box.textContent = data.corrupt
      ? 'Cookie 文件损坏或格式不对：请重新导入/粘贴一次。'
      : '未配置：自动发说说不会生效，草稿仍可复制手动发。';
    return;
  }
  const time = data.updatedAt ? new Date(data.updatedAt).toLocaleString('zh-CN') : '';
  box.textContent = `已配置 · QQ ${data.uin}${time ? ` · ${time}` : ''}${data.hasPskey ? '' : ' · 缺少 p_skey，可能无法发布'}`;
}

async function saveQzoneCookie() {
  const cookie = $('#qzoneCookie').value.trim();
  if (!cookie) {
    toast('先把空间 Cookie 贴进来。', 'error');
    return;
  }
  try {
    await api('/api/qzone/cookie', { method: 'POST', body: { cookie } });
    $('#qzoneCookie').value = '';
    toast('QQ 空间 Cookie 存好了，正在验证…');
    await loadQzoneStatus();
    const verify = await api('/api/qzone/verify');
    toast(verify.ok ? '验证通过：空间已登录。' : `验证没通过：${verify.reason}`, verify.ok ? '' : 'error');
    await loadQzoneStatus();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function verifyQzone() {
  try {
    const data = await api('/api/qzone/verify');
    toast(data.ok ? '验证通过：空间已登录。' : `验证没通过：${data.reason}`, data.ok ? '' : 'error');
    await loadQzoneStatus();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function importQzoneFromNapcat() {
  try {
    const data = await api('/api/qzone/import-napcat', { method: 'POST' });
    toast(`已从 NapCat 导入 QQ ${data.uin} 的空间 Cookie。`);
    await loadQzoneStatus();
    const verify = await api('/api/qzone/verify');
    toast(verify.ok ? '验证通过：空间已登录。' : `验证没通过：${verify.reason}`, verify.ok ? '' : 'error');
    await loadQzoneStatus();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function clearQzoneCookie() {
  if (!confirm('清除空间 Cookie？之后自动发说说会失效。')) return;
  try {
    await api('/api/qzone/cookie', { method: 'DELETE' });
    toast('已清除。');
    await loadQzoneStatus();
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ---------------- 小红书私信 ---------------- */

function renderDmList(items = [], perTargetUsed = {}) {
  const box = $('#xhsDmList');
  if (!box) return;
  box.textContent = '';
  if (!items.length) {
    box.textContent = '还没读到过私信。她每隔一阵会自己看一次，也可以点「刷新私信」马上看。';
    return;
  }
  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `dm-row${item.isOwner ? ' dm-owner' : ''}`;
    const used = Number(perTargetUsed[item.name] || 0);
    row.textContent =
      `${item.name || '有人'}${item.isOwner ? '（你）' : ''}：${item.preview || '（看不到内容）'}` +
      `${item.time ? ` · ${item.time}` : ''}${used ? ` · 今天已回 ${used} 条` : ''}`;
    row.addEventListener('click', () => {
      state.dmInbox = { target: item.name || '', message: item.preview || '', convId: item.convId || '' };
      $('#xhsDmTarget').value = item.name || '';
      $('#xhsDmResult').textContent = `要回的是「${item.name || '有人'}」，她那条写的是：${item.preview || '（看不到内容）'}`;
    });
    box.appendChild(row);
  }
}

async function loadXhsDms() {
  const status = await api('/api/xhs/status');
  const items = status.directMessages || [];
  renderDmList(items, status.dmStatus?.perTargetUsed || {});
  const d = status.dmStatus || {};
  const line = $('#xhsDmResult');
  if (line && !state.dmInbox) {
    line.textContent = d.enabled
      ? `回私信开着：今天已回 ${d.todayTotal || 0}/${d.dailyMax || 0} 条，同一个人每天最多 ${d.perTargetMax || 1} 条。` +
        `${status.dmsAt ? ` 私信读于 ${new Date(status.dmsAt).toLocaleString('zh-CN', { hour12: false })}。` : ''}`
      : '「允许她回私信」现在是关的：设置 → 小红书 里打开以后，这里才发得出去。';
  }
  for (const item of items) {
    if (state.dmInbox && item.name === state.dmInbox.target && item.preview !== state.dmInbox.message) {
      state.dmInbox.message = item.preview;
    }
  }
}

async function xhsDmDraft() {
  const target = $('#xhsDmTarget').value.trim();
  if (!target) {
    toast('先点上面要回的那一行，或者填上对方昵称。', 'error');
    return;
  }
  const message = String(state.dmInbox?.message || '').trim();
  if (!message) {
    toast('没读到对方那条内容，你把想回的话自己写在框里就行。', 'error');
    return;
  }
  await withBusy($('#xhsDmDraft'), async () => {
    try {
      const data = await api('/api/xhs/dm/draft', { method: 'POST', body: { target, message } });
      $('#xhsDmText').value = data.text;
      $('#xhsDmResult').textContent = `她想好了这句，你先看一眼，确认了再发。`;
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

async function xhsDmSend() {
  const target = $('#xhsDmTarget').value.trim();
  const text = $('#xhsDmText').value.trim();
  if (state.dmInbox && state.dmInbox.target !== target) { toast('昵称已改变，请重新选择正确的私信会话。', 'error'); return; }
  if (!target || !text) {
    toast('要给谁、说什么，都得填上。', 'error');
    return;
  }
  if (!$('#xhsDmConfirm').checked) {
    toast('要勾上「我确认真的把这条发出去」。', 'error');
    return;
  }
  if (!confirm(`真的把这句发出去？\n发给「${target}」：${text}`)) return;
  await withBusy($('#xhsDmSend'), async () => {
    try {
      const data = await api('/api/xhs/dm/send', {
        method: 'POST',
        body: { target, text, convId: state.dmInbox?.convId || '', confirm: true },
      });
      $('#xhsDmText').value = '';
      $('#xhsDmConfirm').checked = false;
      toast(data.verified ? `发出去了，也在聊天窗口核对上了。` : '发出去了，但最后一条气泡没核对上——你去小红书看一眼。');
      await loadXhsDms().catch(() => {});
    } catch (error) {
      toast(error.message, 'error');
      await loadXhsDms().catch(() => {});
    }
  });
}

/* ---------------- actions / events ---------------- */

async function runAction(kind, button) {
  if (kind === 'handover') {
    const ok = confirm('这会把当前会话归档，让她写一封交接信，然后开始新会话。继续吗？');
    if (!ok) return;
  }
  await withBusy(button, async () => {
    try {
      const data = await api(`/api/actions/${kind}`, { method: 'POST' });
      if (data.ok === false) {
        toast(data.reason || '这次没做成。', 'error');
        return;
      }
      if (kind === 'proactive') toast(data.sent ? '她发到你 QQ 了。' : '她的话放在聊天里了。');
      if (kind === 'weekly') toast('周记写好了，去「记忆 → 信」看看。');
      if (kind === 'daily') toast('今天的日记写好了，去「记忆 → 信」看看。');
      if (kind === 'compact') toast('记忆压缩好了。');
      if (kind === 'handover') toast('交接信写好了，新会话已经开始。');
      if (kind === 'reset-schedule') toast('主动日程重置了。');
      await loadStatus();
      await loadMemory();
      await loadMessages();
      if (kind === 'weekly' || kind === 'daily' || kind === 'handover') {
        switchView('memory');
        setMemoryTab('letters');
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

async function loadEvents() {
  const data = await api('/api/events');
  state.events = data.events || [];
  const box = $('#eventList');
  box.innerHTML = '';
  if (!state.events.length) {
    box.appendChild(el('div', 'empty', '还没有事件。'));
    return;
  }
  for (const item of state.events) {
    const row = el('div', 'event-item');
    row.appendChild(el('time', '', new Date(item.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
    row.appendChild(el('span', '', item.message || item.type));
    box.appendChild(row);
  }
}

/* ---------------- bindings ---------------- */

function bindChat() {
  const input = $('#chatInput');
  const form = $('#chatForm');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', () => autoResize(input));
  input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      event.preventDefault();
      addImages(files);
    }
  });
  $('#imageBtn').addEventListener('click', () => $('#imageInput').click());
  $('#imageInput').addEventListener('change', (event) => {
    addImages(event.target.files || []);
    event.target.value = '';
  });
  $('#voiceBtn').addEventListener('click', () => {
    state.ttsAuto = !state.ttsAuto;
    updateVoiceButton();
    if (state.settings?.ui) state.settings.ui.autoSpeak = state.ttsAuto;
    const checkbox = $('#setAutoSpeak');
    if (checkbox) checkbox.checked = state.ttsAuto;
    toast(state.ttsAuto ? '收到回复会自动朗读。' : '不自动朗读了。');
  });

  $('#messages').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.classList.contains('speak')) {
      const bubble = button.closest('.msg')?.querySelector('.bubble');
      if (bubble) speak(bubble.textContent);
    } else if (button.classList.contains('thought-toggle')) {
      const wrap = button.closest('.bubble-wrap');
      const thought = wrap?.querySelector('.thought');
      thought?.classList.toggle('hidden');
      button.textContent = thought?.classList.contains('hidden') ? '心里话' : '收起';
    } else if (button.classList.contains('suggestion')) {
      const inputBox = $('#chatInput');
      inputBox.value = button.textContent;
      sendMessage();
    }
  });
}

function bindMemory() {
  $('#memoryTabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (button) setMemoryTab(button.dataset.tab);
  });
  $('#refreshMemory').addEventListener('click', () => loadMemory().catch((error) => toast(error.message, 'error')));
  $('#addMemoryBtn').addEventListener('click', addMemory);
  $('#memoryImportance').addEventListener('input', (event) => {
    $('#memoryImportanceValue').textContent = event.target.value;
  });
}

function bindSocial() {
  $$('[data-post-kind]').forEach((button) => {
    button.addEventListener('click', () => withBusy(button, () => generatePost(button.dataset.postKind)));
  });
  $('#genCommentsBtn').addEventListener('click', generateComments);
  $('#stickerFindBtn').addEventListener('click', stickerFind);
  $('#stickerMemeBtn').addEventListener('click', stickerMemes);
  $('#runDreamBtn').addEventListener('click', () => withBusy($('#runDreamBtn'), async () => {
    try {
      const data = await api('/api/actions/dream', { method: 'POST' });
      if (data.skipped) {
        toast(data.skipped);
        return;
      }
      $('#dreamLine').textContent = `她刚刚想了一遍：${data.dream}`;
      toast('她睡前想完了，明天可能主动找你。');
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#xhsNoteFill').addEventListener('click', xhsNoteFill);
  $('#xhsNotePublish').addEventListener('click', xhsNotePublish);
  $('#xhsDmRefresh').addEventListener('click', () =>
    withBusy($('#xhsDmRefresh'), async () => {
      try {
        const data = await api('/api/xhs/dm/read', { method: 'POST' });
        toast(data.auto ? `读到 ${data.items.length} 个私信会话；已自动回主人一条。` : `读到 ${data.items.length} 个私信会话。`);
        await loadXhsDms();
      } catch (error) {
        toast(`私信没读到：${error.message}`, 'error');
      }
    }),
  );
  $('#xhsDmDraft').addEventListener('click', xhsDmDraft);
  $('#xhsDmBindOwner').addEventListener('click', async () => {
    const inbox = state.dmInbox;
    if (!inbox?.convId || !confirm('确认这个私信会话就是你本人？自动回复将只对这个稳定会话生效。')) return;
    try { await api('/api/xhs/dm/bind-owner', { method:'POST', body:{target:inbox.target,convId:inbox.convId,confirm:true} }); toast('主人私信会话已绑定'); await loadXhsDms(); }
    catch (error) { toast(error.message,'error'); }
  });
  $('#xhsDmSend').addEventListener('click', xhsDmSend);
  $('#xhsNoteStash').addEventListener('click', xhsNoteStash);
  $('#xhsNoteLeave').addEventListener('click', xhsNoteLeave);
  $('#xhsLoadDraft').addEventListener('click', loadLatestXhsDraft);
  $('#refreshQzoneFeed').addEventListener('click', () => withBusy($('#refreshQzoneFeed'), async () => {
    await loadQzoneFeed(true);
  }));
  $('#runQzoneAutoReply').addEventListener('click', () => withBusy($('#runQzoneAutoReply'), async () => {
    try {
      const data = await api('/api/qzone/auto-reply/run', { method: 'POST' });
      if (data.replied?.length) toast(`自动回复了 ${data.replied.length} 条空间评论。`);
      else toast(data.skipped || '这次没有需要回复的评论。');
      await loadQzoneFeed(true);
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
}

function bindSettings() {
  const settingsView = $('#view-settings');
  if (settingsView) {
    const markDirty = (event) => {
      if (!event.target?.id?.startsWith('set')) return;
      state.settingsDirty = true;
      const hint = $('#saveHint');
      if (hint) {
        hint.textContent = '有未保存的修改';
        hint.classList.add('dirty');
        hint.classList.remove('saved');
      }
    };
    settingsView.addEventListener('input', markDirty);
    settingsView.addEventListener('change', markDirty);
  }
  $('#saveSettingsBtn').addEventListener('click', saveSettings);
  $('#voicePreviewBtn').addEventListener('click', () => previewVoice($('#voicePreviewBtn')));
  $('#voiceQqBtn').addEventListener('click', () => withBusy($('#voiceQqBtn'), async () => {
    try {
      const data = await api('/api/qq/test-voice', {
        method: 'POST',
        body: { voice: $('#setVoiceName').value, rate: String($('#setVoiceRate').value || '').trim(), pitch: String($('#setVoicePitch').value || '').trim() },
      });
      toast(data.ok ? `已经发到你 QQ 了（${data.voice || data.engine}），手机上放来听听。` : data.reason || '没发出去', data.ok ? '' : 'error');
    } catch (error) {
      toast(error.message, 'error');
    }
    renderVoiceLine();
  }));
  $('#voiceEchoBtn').addEventListener('click', () => withBusy($('#voiceEchoBtn'), async () => {
    try {
      const data = await api('/api/voice/echo', { method: 'POST', body: {} });
      if (data.ok) toast(`链路是通的：她说「${data.said}」，听回来「${data.heard}」。`);
      else toast(`链路停在 ${data.step}：${data.reason || '没说明原因'}`, 'error');
    } catch (error) {
      toast(error.message, 'error');
    }
    renderVoiceLine();
  }));
  $('#savePersonaBtn').addEventListener('click', savePersona);
  $('#refreshBalance').addEventListener('click', () => loadBalance(true));
  $('#balanceBtn').addEventListener('click', () => loadBalance(true));
  $('#copyWs').addEventListener('click', () => copyText($('#qqWs').textContent));
  $('#qqStopChannel')?.addEventListener('click', () => withBusy($('#qqStopChannel'), async () => {
    if (!confirm('停用会断开并退出 NapCat 当前挂着的 QQ。如果它误占了你的主号，主号窗口也会跟着退出，之后可以单独重新打开主号。继续？')) return;
    try {
      const data = await api('/api/qq/stop', { method: 'POST' });
      toast(data.ok ? 'QQ 通道已停用，NapCat 挂着的 QQ 已退出；如果它占的是主号，主号窗口也会关闭，稍后重新打开主号即可。' : '没停成。', data.ok ? '' : 'error');
      await loadSettings().catch(() => {});
      loadQqSetup().catch(() => {});
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#qqHealthBtn')?.addEventListener('click', () => withBusy($('#qqHealthBtn'), async () => {
    try {
      const health = await api('/api/qq/health');
      if (!health.ok) {
        toast(`QQ 登录信息就读不到：${health.error || '未知错误'}`, 'error');
        return;
      }
      try {
        const test = await api('/api/qq/test', { method: 'POST' });
        if (!test.ok) throw new Error(test.reason || '测试消息没发出去');
        toast(`QQ 账号 ${health.selfId || ''} 出站测试成功；入站是否正常请从主号发一条消息验证。`);
      } catch (error) {
        toast(`登录信息读到了（${health.selfId || ''}），但发不出消息：${error.message}。先关掉电脑上的主号 QQ，再停用→重新登录小号。`, 'error');
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#qqReloginBot')?.addEventListener('click', () => withBusy($('#qqReloginBot'), async () => {
    if (!confirm('重新登录会先退出 NapCat 当前挂着的 QQ（可能是你的主号），再用设置中的机器人小号启动。继续？')) return;
    try {
      const data = await api('/api/qq/qr/restart', { method: 'POST' });
      toast(data.ok ? '正在用小号重新登录；二维码出来会自动刷新。扫码手机必须先登录设置中的机器人小号，不要用主号手机扫。' : data.reason || '没启动起来', data.ok ? '' : 'error');
      setTimeout(() => loadQqSetup().catch(() => {}), 3000);
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#xhsLogoutBtn')?.addEventListener('click', () => withBusy($('#xhsLogoutBtn'), async () => {
    if (!confirm('退出小红书登录会清掉这个浏览器里的登录态（要重新扫码），确定吗？')) return;
    try {
      const data = await api('/api/xhs/logout', { method: 'POST' });
      toast(data.ok ? '已退出小红书登录，可以重新扫码换号了。' : `没清干净：${(data.failed || []).join('；')}`, data.ok ? '' : 'error');
      loadXhsStatus().catch(() => {});
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#copyToken').addEventListener('click', async () => {
    try {
      const data = await api('/api/qq/token/reveal', { method: 'POST' });
      if (!data.ok) {
        toast(data.reason || '没有可复制的令牌', 'error');
        return;
      }
      $('#qqToken').textContent = data.token;
      await copyText(data.token);
      toast('令牌已复制（页面上一分钟后刷新会重新变成掩码）。');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#qqTest').addEventListener('click', () => withBusy($('#qqTest'), async () => {
    try {
      const data = await api('/api/qq/test', { method: 'POST' });
      toast(data.ok ? '测试消息发出去了。' : data.reason || '没发出去', data.ok ? '' : 'error');
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#qqStickerTest').addEventListener('click', () => withBusy($('#qqStickerTest'), async () => {
    try {
      const data = await api('/api/qq/test-sticker', { method: 'POST' });
      toast(data.ok ? '表情包发出去了，去 QQ 看看。' : data.reason || '没发出去', data.ok ? '' : 'error');
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#qqFaceTest').addEventListener('click', () => withBusy($('#qqFaceTest'), async () => {
    try {
      const data = await api('/api/qq/test-face', { method: 'POST' });
      toast(data.ok ? 'QQ 小黄脸发出去了。' : data.reason || '没发出去', data.ok ? '' : 'error');
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#qqMfaceTest').addEventListener('click', () => withBusy($('#qqMfaceTest'), async () => {
    try {
      const data = await api('/api/qq/test-mface', { method: 'POST' });
      toast(data.ok ? 'QQ 表情包发出去了，去 QQ 看看。' : data.reason || '没发出去', data.ok ? '' : 'error');
      await loadQqSetup();
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#qqLearnedImageTest').addEventListener('click', () => withBusy($('#qqLearnedImageTest'), async () => {
    try {
      const data = await api('/api/qq/test-learned-image', { method: 'POST' });
      toast(data.ok ? '学到的图片表情发出去了。' : data.reason || '没发出去', data.ok ? '' : 'error');
      await loadQqSetup();
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#qqClearLearned').addEventListener('click', async () => {
    if (!confirm('清空所有学到的图片表情？')) return;
    try {
      await api('/api/qq/learned-images', { method: 'DELETE' });
      toast('已经清空。');
      await loadQqSetup();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#qqBindOwner').addEventListener('click', async () => {
    const userId = $('#qqBindOwner').dataset.userId || '';
    if (!userId) return;
    try {
      await api('/api/qq/bind-owner', { method: 'POST', body: { userId } });
      toast('已经确认主人了。');
      await Promise.all([loadQqSetup(), loadStatus()]);
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#qqOwnerInput').addEventListener('input', () => { $('#qqOwnerInput').dataset.dirty = '1'; });
  $('#qqSaveOwner').addEventListener('click', async () => {
    const userId = $('#qqOwnerInput').value.replace(/\D/g, '').trim();
    if (!/^\d{5,12}$/.test(userId)) {
      toast('请输入 5-12 位主人 QQ 号。', 'error');
      return;
    }
    const current = state.qqOwnerId || '';
    if (current && current !== userId && !confirm(`把主人从 ${current} 改成 ${userId}？`)) return;
    try {
      await api('/api/qq/bind-owner', { method: 'POST', body: { userId, manual: true } });
      delete $('#qqOwnerInput').dataset.dirty;
      toast('主人 QQ 已绑定。');
      await Promise.all([loadQqSetup(), loadStatus()]);
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#qqReset').addEventListener('click', async () => {
    if (!confirm('解绑之后，新的私聊需要在控制台确认主人。继续？')) return;
    try {
      await api('/api/qq/reset-owner', { method: 'POST' });
      toast('解绑了。');
      await loadQqSetup();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#saveQzoneCookie').addEventListener('click', saveQzoneCookie);
  $('#verifyQzoneCookie').addEventListener('click', verifyQzone);
  $('#importQzoneCookie').addEventListener('click', importQzoneFromNapcat);
  $('#clearQzoneCookie').addEventListener('click', clearQzoneCookie);
  $('#qqNewQr').addEventListener('click', () => withBusy($('#qqNewQr'), async () => {
    try {
      const data = await api('/api/qq/qr/restart', { method: 'POST' });
      toast(data.reason || '正在重新生成二维码…');
      const hint = document.querySelector('#qqQrHint');
      if (hint) hint.textContent = '正在重启 QQ 登录；二维码出来会自动刷新，扫完这里会自动变成已连接。';
      await loadQqSetup().catch(() => {});
      const started = Date.now();
      const check = async () => {
        try {
          const setup = await api('/api/qq/setup');
          await loadQqSetup();
          if (setup.status?.connected) {
            toast('QQ 已经连接上了。');
            return;
          }
        } catch {
          // 页面正在切走或登录失效时忽略
        }
        if (Date.now() - started < 20000) setTimeout(check, 2000);
      };
      setTimeout(check, 1500);
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#xhsLoginBtn').addEventListener('click', () => withBusy($('#xhsLoginBtn'), async () => {
    try {
      stopXhsQrPolling();
      await api('/api/xhs/login', { method: 'POST' });
      toast('登录窗口已打开，在 Chrome 里扫码或用手机号验证码登录。');
      await loadXhsStatus();
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#xhsVerifyBtn').addEventListener('click', () => withBusy($('#xhsVerifyBtn'), async () => {
    try {
      const data = await api('/api/xhs/verify', { method: 'POST' });
      toast(data.loggedIn ? '小红书登录有效。' : '还没有登录，请点「打开登录窗口」。', data.loggedIn ? '' : 'error');
      await loadXhsStatus();
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#xhsCloseBtn').addEventListener('click', async () => {
    try {
      await api('/api/xhs/close', { method: 'POST' });
      toast('小红书浏览器连接已关闭。');
      await loadXhsStatus();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#xhsProfileReadBtn').addEventListener('click', () => withBusy($('#xhsProfileReadBtn'), async () => {
    const box = $('#xhsProfileBox');
    try {
      box.textContent = '正在读她的小红书主页…';
      const data = await api('/api/xhs/profile');
      const p2 = data.profile || {};
      box.textContent = `主页上现在写着：昵称「${p2.name || '（空）'}」，简介「${p2.desc || '（空）'}」。`;
    } catch (error) {
      box.textContent = `没读到：${error.message}`;
      toast(error.message, 'error');
    }
  }));
  $('#xhsProfileBtn').addEventListener('click', () => withBusy($('#xhsProfileBtn'), async () => {
    const box = $('#xhsProfileBox');
    try {
      box.textContent = '她正在看自己现在叫什么，然后想名字…';
      const data = await api('/api/xhs/profile/draft', { method: 'POST' });
      box.innerHTML = '';
      box.appendChild(el('p', 'small', `现在：${data.current?.name || '（没读到）'}／简介 ${data.current?.desc || '（空）'}`));
      for (const name of data.names || []) box.appendChild(el('p', 'small', `昵称候选：${name}`));
      if (data.bio) box.appendChild(el('p', 'small', `简介：${data.bio}`));
      if (data.why) box.appendChild(el('p', 'small', `为什么这么取：${data.why}`));
      for (const step of data.steps || []) box.appendChild(el('p', 'small', `步骤：${step}`));
      toast('她写好候选了，去 App 里贴。');
    } catch (error) {
      box.textContent = `没想出来：${error.message}`;
      toast(error.message, 'error');
    }
  }));
  $('#xhsReportBtn').addEventListener('click', () => withBusy($('#xhsReportBtn'), async () => {
    const box = $('#xhsReportBox');
    try {
      box.textContent = '正在读创作中心数据并让她写…';
      const data = await api('/api/xhs/report', { method: 'POST' });
      const st = data.stats || {};
      box.innerHTML = '';
      const head = el('p', 'small', `统计周期 ${st.period || '近 7 日'}：曝光 ${st.views || '-'}｜观看 ${st.reads || '-'}｜赞 ${st.likes || '-'}｜评 ${st.comments || '-'}｜藏 ${st.collects || '-'}｜粉丝 ${st.followers || '-'}。已存 ${data.file}`);
      box.appendChild(head);
      const p2 = el('p', 'small', data.report);
      box.appendChild(p2);
      for (const topic of data.topics || []) {
        box.appendChild(el('p', 'small', `选题：${topic.title}（${topic.why}｜要准备：${topic.need}）`));
      }
      toast('周报写好了。');
    } catch (error) {
      box.textContent = `周报没写成：${error.message}`;
      toast(error.message, 'error');
    }
  }));
  $('#xhsRunBrowse').addEventListener('click', () => withBusy($('#xhsRunBrowse'), async () => {
    try {
      const data = await api('/api/xhs/run/browse', { method: 'POST' });
      const n = data.actions?.length || 0;
      toast(n ? `小红书评论了 ${n} 条。` : data.reason || '这次没有合适的笔记。', n ? '' : 'error');
      await loadXhsStatus();
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
  $('#xhsRunReply').addEventListener('click', () => withBusy($('#xhsRunReply'), async () => {
    try {
      const data = await api('/api/xhs/run/reply', { method: 'POST' });
      const n = data.actions?.length || 0;
      toast(n ? `小红书回复了 ${n} 条评论。` : data.reason || '这次没有需要回复的评论。', n ? '' : 'error');
      await loadXhsStatus();
    } catch (error) {
      toast(error.message, 'error');
    }
  }));

  $$('[data-action]').forEach((button) => {
    button.addEventListener('click', () => runAction(button.dataset.action, button));
  });
  const actionMap = {
    actionProactive: 'proactive',
    actionWeekly: 'weekly',
    actionDaily: 'daily',
    actionCompact: 'compact',
    actionHandover: 'handover',
    actionResetSchedule: 'reset-schedule',
  };
  for (const [id, kind] of Object.entries(actionMap)) {
    const button = $(`#${id}`);
    if (button) button.addEventListener('click', () => runAction(kind, button));
  }
}

function bindModal() {
  const modal = $('#letterModal');
  $('#closeLetter').addEventListener('click', () => {
    modal.hidden = true;
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal) modal.hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') modal.hidden = true;
  });
}

function bindLogin() {
  const form = $('#loginForm');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#loginPassword');
    const button = $('#loginSubmit');
    const error = $('#loginError');
    button.disabled = true;
    error.textContent = '';
    try {
      await submitLogin(input.value);
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
      input.select();
    }
  });
  $('#logoutBtn')?.addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST', headers: { 'X-BiZhi-Request': '1' } });
    } finally {
      location.reload();
    }
  });
}

/* ---------------- init ---------------- */

async function init() {
  bindLogin();
  bindNavigation();
  bindChat();
  bindMemory();
  bindSocial();
  bindSettings();
  bindModal();
  try {
    await loadSettings();
    await Promise.all([
      loadStatus(),
      loadMessages(),
      loadMemory(),
      loadPosts(),
      loadEvents(),
    ]);
    loadBalance().catch(() => {});
    loadQqSetup().catch(() => {});
    loadQzoneStatus().catch(() => {});
    loadXhsStatus().catch(() => {});
    if (state.status && !state.status.keyConfigured) {
      toast('还没有配置 DeepSeek API Key：编辑 .env 里的 DEEPSEEK_API_KEY，然后重启。', 'error');
    }
    const params = new URLSearchParams(location.search);
    const initialView = params.get('view') || String(location.hash || '').replace(/^#/, '');
    if (['chat', 'memory', 'social', 'settings'].includes(initialView)) switchView(initialView);
  } catch (error) {
    if (!state.loginRequired) toast(error.message, 'error');
  }
  if (state.loginRequired) return;
  state.pollTimer = setInterval(liveRefresh, 4000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) liveRefresh();
  });
}

init();
