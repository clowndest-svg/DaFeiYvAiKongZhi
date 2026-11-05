// X（推特）通道的判据。全部离线跑：不真起浏览器、不真连 X。
// 这里钉的是"顺序"和"口径"：代理不通必须报代理、闸门不过必须报闸门、界面写的数字必须就是代码里的数字。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { env, loadSettings, paths, saveSettings } from '../src/config.js';
import { closeDb, kvSet } from '../src/db.js';
import { buildXPostPrompt, buildXReplyPrompt } from '../src/prompt.js';
import { DeliveryUnknownError } from '../src/effects.js';
import {
  assertXAction,
  assertXDeliveryEvidence,
  assertXPage,
  assertXReplyEvidence,
  isRiskyXError,
  isXLoginPage,
  triggerXCooldown,
  xCooldownUntil,
} from '../src/channels/x-safety.js';
import { canActX, manualXAct, parseHerAnswer, shouldSkipTweet, xBudgetStatus } from '../src/channels/x-actions.js';
import { readXTimeline, xProxyAlive, normalizeTyped } from '../src/channels/x.js';
import { otherHolders } from '../src/browser/cdp.js';

test.after(closeDb);

const SOCIAL_BASE = { ...(loadSettings().social || {}) };
function setSocial(patch) {
  saveSettings({ social: { ...SOCIAL_BASE, ...(loadSettings().social || {}), ...patch } });
}

test('登录窗口不许带自动化旗子；profile 被占时要说"先关掉那个窗口"', () => {
  const cdp = fs.readFileSync(path.join(paths.root, 'src', 'browser', 'cdp.js'), 'utf8');
  const x = fs.readFileSync(path.join(paths.root, 'src', 'channels', 'x.js'), 'utf8');
  const argsBlock = /const args = \[([\s\S]*?)\];/.exec(cdp);
  assert.ok(argsBlock, '找不到浏览器启动参数块');
  assert.ok(!/--enable-automation/.test(argsBlock[1]), 'CDP 启动又加回了 --enable-automation：Google 会拒绝授权');
  assert.match(argsBlock[1], /--remote-debugging-port/, '登录窗口必须带调试端口，否则登完还要关窗口才能验证');
  assert.match(x, /browser\.relaunch\(\{ visible: true \}\)/, 'X 登录没走带端口的窗口');
  // profile 被别的窗口占住时，报错要说清是谁占着，不能只说"调试端口没有起来"
  assert.match(cdp, /chromeHoldingProfile\(this\.profileDir\)/, '没去查谁占着 profile');
  assert.match(cdp, /还被另一个 Chrome 窗口占着/, '占用冲突的报错没说人话');
  assert.match(cdp, /把那个窗口关掉/, '没告诉他下一步做什么');
  // 查占用者只读进程列表；唯一的"退进程"动作只能落在自己 spawn 的那个 pid 上
  const holderFn = /export function chromeHoldingProfile[\s\S]*?\r?\n}/.exec(cdp);
  assert.ok(holderFn, '找不到占用者查询函数');
  assert.ok(!/kill|taskkill|Stop-Process/i.test(holderFn[0]), '查占用者时居然去动进程了');
  assert.match(holderFn[0], /\$\(\$_\.ParentProcessId\)/, '没读父进程：会把十几个渲染/GPU 子进程一起报出来，pid 8 就是这么来的');
  assert.ok(
    /\[pid, parent\][\s\S]*!pids\.has\(parent\)|filter\(\(\[, parent\]\) => !pids\.has\(parent\)/.test(holderFn[0]),
    '没按"父进程也是浏览器"过滤：报出来的不是窗口主进程',
  );
  const stopFn = /async stopOwnChild\(\)[\s\S]*?\n  }/.exec(cdp);
  assert.ok(stopFn, '调试端口没起来时没收回自己起的那个进程——下次只会多一个占着 profile 的孤儿');
  assert.match(stopFn[0], /this\.child\?\.pid/, '收进程只能收自己 spawn 的那个 pid');
  assert.ok(!/Name='chrome\.exe'/.test(stopFn[0]), '按名字找浏览器去杀：会把用户自己开着的窗口一起干掉');
  assert.match(cdp, /otherHolders\(chromeHoldingProfile\(this\.profileDir\), (?:stopped|again)\)/, '报错前没把自己从占用者名单里摘掉');
});

// 页面脚本是原样送进浏览器跑的：Node 侧的变量名必须在建串时就变成字面量，
// 写成 (({href}) => …)({href}) 这种"看着像传参"的形式，页面上根本没有这个名字，
// 只会抛 ReferenceError——离线判据看不见，只有真点一次才暴露（实测三次自动回复全废在这个上面）。
// 这里把每段页面脚本塞进一个假 DOM 里跑一遍：自由变量立刻现形。
function runPageScripts(file, label) {
  const node = () => ({
    innerText: '', innerHTML: '', textContent: '', value: '', href: '',
    getAttribute: () => '', setAttribute() {}, style: {}, dataset: {},
    classList: { contains: () => false, add() {}, remove() {} },
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    click() {}, focus() {}, select() {}, dispatchEvent() {}, addEventListener() {},
  });
  const failures = [];
  const src = fs.readFileSync(path.join(paths.root, 'src', 'channels', file), 'utf8');
  const re = /String\.raw`([\s\S]*?)`/g;
  let match;
  let index = 0;
  while ((match = re.exec(src))) {
    index += 1;
    const body = match[1].replace(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '"__probe__"');
    const stub = node();
    const sandbox = {
      document: { body: stub, title: '', activeElement: stub, documentElement: stub, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: node, addEventListener() {} },
      location: { href: 'https://x.com/home', origin: 'https://x.com' },
      navigator: { clipboard: { writeText: async () => {} } },
      setTimeout, clearTimeout, Math, JSON, RegExp, Promise, URL,
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    try {
      vm.runInNewContext(body, sandbox, { timeout: 3000 });
    } catch (error) {
      if (String(error).startsWith('ReferenceError')) {
        const line = src.slice(0, match.index).split(/\r?\n/).length;
        failures.push(`${label} 第 ${index} 段（${file}:${line}）：${error.message}`);
      }
    }
  }
  if (index === 0) failures.push(`${label}：一个页面脚本都没抓到，判据本身失效了`);
  return failures;
}

test('内容没渲染完之前不许判"选择器过期"：先等推文出现再下结论', () => {
  const src = fs.readFileSync(path.join(paths.root, 'src', 'channels', 'x.js'), 'utf8');
  const fn = /async function assertTimelineLoaded[\s\S]*?\r?\n}/.exec(src);
  assert.ok(fn, '找不到 assertTimelineLoaded');
  assert.ok(fn[0].includes('while (state.tweets === 0'), '没等内容出现就判空：慢网会把"还没加载完"报成"选择器过期"（实测她的 2 条主页推文就是这么丢的）');
  assert.ok(fn[0].includes('Date.now() < deadline'), '等待没有上限：卡死的页面会拖死一整轮自动行为');
  assert.ok(fn[0].indexOf('timelineProbe()') < fn[0].indexOf('isXLoginPage(state.url'), '判空必须发生在读页面之后');
});

test('页面脚本必须自带全部变量：把每段塞进假 DOM 跑一遍，不许有 ReferenceError', () => {
  const broken = runPageScripts('x.js', 'X');
  assert.deepEqual(broken, [], `这些页面脚本送进浏览器就会抛：\n${broken.join('\n')}`);
  const brokenXhs = runPageScripts('xhs.js', '小红书');
  assert.deepEqual(brokenXhs, [], `小红书页面脚本送进浏览器就会抛：\n${brokenXhs.join('\n')}`);
});

test('占用者名单里要摘掉自己刚起的那个，否则锅会甩到用户头上', () => {
  assert.deepEqual(otherHolders(['26328', '8112'], 8112), ['26328']);
  assert.deepEqual(otherHolders(['8112'], 8112), [], '自己也算占用者：用户明明什么都没开');
  assert.deepEqual(otherHolders([], 123), []);
});

test('代理不通时报的是代理，不是"页面打不开"，也不许碰浏览器', async () => {
  const original = env.xProxy;
  setSocial({ xEnabled: true });
  try {
    env.xProxy = 'http://127.0.0.1:1';
    const probe = await xProxyAlive();
    assert.equal(probe.ok, false);
    assert.match(probe.reason, /代理 127\.0\.0\.1:1/);
    assert.match(probe.reason, /X 直连不通|必须先把它起来|X 需要它才出得去/);
    const error = await readXTimeline({ tab: 'home', limit: 3 }).then(() => null, (e) => e);
    assert.ok(error, '代理不通还读成功了');
    assert.match(error.message, /代理/, `报错了但不是代理的问题：${error.message}`);
    assert.ok(!/接管真实浏览器/.test(error.message), '代理检查排在浏览器后面：先碰了浏览器才说代理不通');
    assert.equal(error.code, 'X_PROXY_DOWN');
  } finally {
    env.xProxy = original;
  }
});

test('没配代理地址要说"没配"，不许拿默认值糊过去', async () => {
  const original = env.xProxy;
  try {
    env.xProxy = '';
    const probe = await xProxyAlive();
    assert.equal(probe.ok, false);
    assert.match(probe.reason, /没配 X 代理/);
  } finally {
    env.xProxy = original;
  }
});

test('闸门分得清"没开""在冷却""关注默认关闭"，顺序不能反', () => {
  setSocial({ xEnabled: false, xDailyFollowMax: 0, xCooldown: undefined });
  kvSet('x_cooldown_until', '');
  assert.equal(canActX('reply').reason, 'X（推特）互动未开启');
  setSocial({ xEnabled: true });
  assert.match(canActX('follow').reason, /主动关注默认关闭/);
  const until = new Date(Date.now() + 3600000).toISOString();
  kvSet('x_cooldown_until', until);
  // 冷却排在额度前面：哪怕额度还有，也不能动手
  assert.match(canActX('reply').reason, /风控冷却中/);
  kvSet('x_cooldown_until', '');
  assert.equal(xCooldownUntil(), '');
});

test('手动动作和自动动作用同一个闸门：不通就回来，不许抛异常', async () => {
  setSocial({ xEnabled: false });
  kvSet('x_cooldown_until', '');
  const out = await manualXAct('reply', { href: '/a/status/1', text: '你好' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /未开启/, `闸门原话没带回来：${out.reason}`);
  assert.ok(!/接管真实浏览器/.test(out.reason), '没先过闸门就去碰浏览器了');
  setSocial({ xEnabled: true, xDailyFollowMax: 0, xDailyPostMax: 1 });
  // 'follow' 在闸门那层就被挡（默认 0 次），根本走不到动作分发：这条顺序要钉住
  const gated = await manualXAct('follow', { href: '/a/status/1' });
  assert.equal(gated.ok, false);
  assert.match(gated.reason, /主动关注默认关闭/, );
  // 闸门放行但动作不认识：要说不支持，不许悄悄当成点赞去做
  const bad = await manualXAct('collect', { href: '/a/status/1' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /不支持的动作/);
});

test('限流与封禁字样要触发冷却，普通错误不许触发', () => {
  assert.equal(isRiskyXError(new Error('You’ve hit the rate limit')), true);
  assert.equal(isRiskyXError(new Error('Something went wrong. Try reloading.')), true);
  assert.equal(isRiskyXError(new Error('Verify you are human')), true);
  assert.equal(isRiskyXError(new Error('这条推文被删了')), false);
  assert.equal(isRiskyXError('账号已被限制'), true);
  kvSet('x_cooldown_until', '');
  const before = xCooldownUntil();
  const until = triggerXCooldown(24, '测试触发');
  assert.notEqual(before, until);
  assert.ok(new Date(until).getTime() - Date.now() > 23 * 3600000, 'X 的冷却没按 24 小时');
  assert.match(xCooldownUntil(), /T/);
  kvSet('x_cooldown_until', '');
});

test('页面判读：登录页和限流页要分开报，不能都写成"没内容"', () => {
  assert.equal(isXLoginPage('https://x.com/i/flow/login', ''), true);
  assert.equal(isXLoginPage('https://x.com/i/jf/onboarding/web?mode=login', ''), true);
  assert.equal(isXLoginPage('https://x.com/home', ''), false);
  assert.equal(isXLoginPage('https://x.com/home', 'Sign in to X'), true);
  assert.throws(() => assertXPage({ url: 'https://x.com/home', text: 'Rate limit exceeded' }), /限流|验证|封禁/);
  assert.throws(() => assertXPage({ url: 'https://x.com/i/flow/login', text: '' }), /登录/);
  assert.doesNotThrow(() => assertXPage({ url: 'https://x.com/home', text: '正常时间线' }));
});

test('送达证据：数量没变或文字不一致就不算发出去', () => {
  const good = { beforeCount: 5, afterCount: 6, outgoing: true, content: '今天想说说深夜', text: '今天想说说深夜' };
  assert.doesNotThrow(() => assertXDeliveryEvidence(good));
  assert.throws(() => assertXDeliveryEvidence({ ...good, afterCount: 5 }), DeliveryUnknownError, '数量没变却算成功');
  assert.throws(() => assertXDeliveryEvidence({ ...good, outgoing: false }), DeliveryUnknownError, '页面上找不到原文却算成功');
  assert.throws(() => assertXDeliveryEvidence({ ...good, text: '今天想说说深夜啊' }), DeliveryUnknownError, '文字不一致必须拒绝');
  assert.throws(() => assertXDeliveryEvidence({ ...good, state: { risky: true } }), DeliveryUnknownError, '页面有限流提示还报成功');
});

test('assertXAction：开关、冷却、省钱模式、动作开关各说一件事', () => {
  setSocial({ xEnabled: false });
  assert.throws(() => assertXAction('like'), /未开启/);
  setSocial({ xEnabled: true, xAutoLike: false });
  assert.throws(() => assertXAction('like'), /开关是关的/);
  setSocial({ xEnabled: true, xAutoLike: true });
  assert.doesNotThrow(() => assertXAction('like'));
  const until = new Date(Date.now() + 3600000).toISOString();
  kvSet('x_cooldown_until', until);
  assert.throws(() => assertXAction('like'), /风控冷却中/);
  kvSet('x_cooldown_until', '');
});

test('回复的送达证据：在原推文下面逐字读到才算发出去', () => {
  assert.doesNotThrow(() => assertXReplyEvidence({ found: true, text: '早上好呀', content: '早上好呀', risky: false }));
  // 找不到 / 文字不一致 / 有限流提示：一律"状态未知"，不许报成功，也不许鼓励再点一次
  assert.throws(() => assertXReplyEvidence({ found: false, text: '', content: '早上好呀' }), DeliveryUnknownError);
  assert.throws(() => assertXReplyEvidence({ found: true, text: '早上好呀（改过了）', content: '早上好呀' }), DeliveryUnknownError);
  assert.throws(() => assertXReplyEvidence({ found: true, text: '早上好呀', content: '早上好呀', risky: true }), DeliveryUnknownError);

  // 弹层一关，新回复不留在原来的时间线上——原地数卡片证明不了发出去（实测两次"没核实成功"就是这个）
  const src = fs.readFileSync(path.join(paths.root, 'src', 'channels', 'x.js'), 'utf8');
  const reply = /async function replyToTweetLocked[\s\S]*?\r?\n}/.exec(src);
  assert.ok(reply, '找不到 replyToTweetLocked');
  assert.match(reply[0], /browser\.waitFor\('div\[data-testid="tweetTextarea_0"\]'/, '没等回复输入框长出来就打字');
  assert.ok(reply[0].includes('browser.focus('), 'Draft.js 只认落在真焦点上的输入，页内 focus() 插空过');
  assert.match(reply[0], /assertXReplyEvidence/, '回复没走"回原帖核对"的证据链');
  assert.ok(!/assertXDeliveryEvidence/.test(reply[0]), '回复还在用"当前页数量变多"当证据：弹层关掉后根本看不到');
  assert.ok(!/还没拿到 NapCat|await sleep\(1500\);\r?\n  const typed/.test(reply[0]), '又回到"固定等 1.5 秒然后假定输入框在"');
});

test('比对输入框要忽略零宽字符，重试前必须先清空：实测同一句话在框里出现了两遍', () => {
  assert.equal(normalizeTyped('早​上‎好'), '早上好');
  assert.equal(normalizeTyped('  今天想聊聊  '), '今天想聊聊');
  const src = fs.readFileSync(path.join(paths.root, 'src', 'channels', 'x.js'), 'utf8');
  const reply = /async function replyToTweetLocked[\s\S]*?\r?\n}/.exec(src);
  assert.ok(reply[0].includes('normalizeTyped(readback.text) !== content'), '还在逐字比 innerText：Draft.js 的零宽占位符会把打对的话判成没打上');
  assert.ok(reply[0].indexOf('COMPOSER_CLEAR') < reply[0].lastIndexOf("browser.focus('div[data-testid=\"tweetTextarea_0\"]')"), '重试没先清空：等于在同一句话后面再接一遍');
});

test('模型把 JSON 截断时不许打断整轮逛：能捞就捞，捞不到就闭嘴', () => {
  // 日志里的真实截断（260 token 砍在 text 中间）
  assert.deepEqual(parseHerAnswer('{"reply":true,"text":"早上把窗台擦了'), { reply: true, text: '早上把窗台擦了', salvaged: true });
  assert.deepEqual(parseHerAnswer('{"reply":true,"text":"她说\\\"早\\\"，今天想多聊'), { reply: true, text: '她说"早"，今天想多聊', salvaged: true });
  assert.deepEqual(parseHerAnswer('不是 JSON'), {}, '解不出就该当没想好，别抛出去');
  assert.deepEqual(parseHerAnswer('{"reply":false,"text":"","reason":"不想说话"}'), { reply: false, text: '', reason: '不想说话' });
});

test('该跳过的推文：敏感话题、空正文、转发；正常生活话不许误伤', () => {
  assert.equal(shouldSkipTweet({ text: '' }), '没有正文');
  assert.match(shouldSkipTweet({ text: '某地发生地震已致多人伤亡' }), /敏感/);
  assert.match(shouldSkipTweet({ text: 'RT @a: 转发一句话' }), /转发/);
  assert.equal(shouldSkipTweet({ text: '今天把周报写完了，手有点酸' }), '');
  assert.equal(shouldSkipTweet({ text: '这个咖啡也太好喝了' }), '');
});

// 下面这些不是编的：2026-11-05 从他自己账号的真实时间线里读到的原话（/api/x/read mode=timeline）。
// 只靠原先那份名单，这些全会被当成"可以回一句"，回出去被截图挂的是他的号。
test('真实时间线里量到的粗口、色情招嫖、政治牢骚必须闭嘴', () => {
  const real = [
    ['想吃20厘米的牛子~~有没有', /色情/],
    ['不懂就问：为什么自己撸射就叫伤身体，跟女人做爱射出来就不伤身', /色情/],
    ['兄弟们，刚约的，这个质量怎么样？', /色情/],
    ['有主人要进来吗？', /色情/],
    ['全中国，最不民主，最不自由的地方，是这里。', /政治/],
    ['我操尼玛啊！ 社保真tm是旁氏骗局啊！', /难听|政治/],
    ['举报她的真不是人！', /难听/],
  ];
  for (const [text, expect] of real) {
    const reason = shouldSkipTweet({ text });
    assert.match(reason || '（没跳过）', expect, `这条本该闭嘴：${text}`);
  }
  // 反过来：普通生活话不许被误伤，不然她整天不说话
  for (const ok of [
    '早上把窗台擦了一遍，顺手给多肉翻了翻土',
    '今天通勤路上听到一首老歌，突然想起高中晚自习',
    '这家面的汤头很浓，下次带朋友来',
    '刚跑完五公里，膝盖有点酸但还是爽',
    'DeepSeek 的余额快见底了，主人记得充一下',
  ]) {
    assert.equal(shouldSkipTweet({ text: ok }), '', `正常生活话被误伤了：${ok}`);
  }
});

test('提示词：语言跟着对方走，公开边界写死，草稿不许自己发', () => {
  const zh = buildXReplyPrompt({ settings: { companion: { name: '鲸鲸' } }, mood: { label: '平静', valence: 0, energy: 0.5 }, tweet: { handle: 'a', text: '上海地铁又限流了' } });
  const en = buildXReplyPrompt({ settings: { companion: { name: '鲸鲸' } }, mood: { label: '平静', valence: 0, energy: 0.5 }, tweet: { handle: 'b', text: 'Long day shipping today' } });
  assert.match(zh, /用中文回复/);
  assert.match(en, /用English回复/);
  for (const prompt of [zh, en]) {
    assert.match(prompt, /不许出现「主人/);
    assert.match(prompt, /不冒充当事人、不编造事实/);
    assert.match(prompt, /不要加话题标签/);
  }
  const post = buildXPostPrompt({ settings: { companion: { name: '鲸鲸' } }, mood: { label: '平静', valence: 0, energy: 0.5 }, topic: '深夜写代码' });
  assert.match(post, /不会自动发出去/);
  assert.match(post, /用中文写/);
});

test('预算读数与设置同一个口径：界面显示的额度就是代码里生效的额度', () => {
  setSocial({ xEnabled: true, xDailyReplyMax: 5, xDailyLikeMax: 10, xDailyRetweetMax: 3, xDailyPostMax: 1, xHourlyActionMax: 2, xDailyActionMax: 10 });
  const b = xBudgetStatus();
  assert.equal(b.dailyReplyMax, 5);
  assert.equal(b.dailyLikeMax, 10);
  assert.equal(b.dailyRetweetMax, 3);
  assert.equal(b.dailyPostMax, 1);
  assert.equal(b.hourlyActionMax, 2);
  assert.equal(b.dailyActionMax, 10);
  assert.equal(typeof b.repliesToday, 'number');
});

test('界面写的数字必须就是代码里的数字（写死在 HTML 里的数 JS 永远不碰）', () => {
  const html = fs.readFileSync(path.join(paths.root, 'web', 'index.html'), 'utf8');
  const actions = fs.readFileSync(path.join(paths.root, 'src', 'channels', 'x.js'), 'utf8');
  const safety = fs.readFileSync(path.join(paths.root, 'src', 'channels', 'x-safety.js'), 'utf8');
  const settings = fs.readFileSync(path.join(paths.root, 'config', 'default-settings.json'), 'utf8');
  assert.match(html, /停 24 小时/);
  assert.match(actions + safety, /triggerXCooldown\(24/, '代码里的冷却时长和界面写的 24 小时不是一个数');
  assert.match(html, /主动关注默认 0 次/);
  assert.match(settings, /"xDailyFollowMax": 0/);
  assert.match(html, /X_PROXY_URL/);
  assert.match(html, /data\/x-profile/);
  assert.match(html, /填稿超过 15 分钟/);
  assert.match(fs.readFileSync(path.join(paths.root, 'src', 'channels', 'x.js'), 'utf8'), /15 \* 60000/);
});
