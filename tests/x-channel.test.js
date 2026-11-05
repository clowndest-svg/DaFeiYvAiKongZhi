// X（推特）通道的判据。全部离线跑：不真起浏览器、不真连 X。
// 这里钉的是"顺序"和"口径"：代理不通必须报代理、闸门不过必须报闸门、界面写的数字必须就是代码里的数字。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { env, loadSettings, paths, saveSettings } from '../src/config.js';
import { closeDb, kvSet } from '../src/db.js';
import { buildXPostPrompt, buildXReplyPrompt } from '../src/prompt.js';
import { DeliveryUnknownError } from '../src/effects.js';
import {
  assertXAction,
  assertXDeliveryEvidence,
  assertXPage,
  isRiskyXError,
  isXLoginPage,
  triggerXCooldown,
  xCooldownUntil,
} from '../src/channels/x-safety.js';
import { canActX, manualXAct, shouldSkipTweet, xBudgetStatus } from '../src/channels/x-actions.js';
import { readXTimeline, xProxyAlive } from '../src/channels/x.js';

test.after(closeDb);

const SOCIAL_BASE = { ...(loadSettings().social || {}) };
function setSocial(patch) {
  saveSettings({ social: { ...SOCIAL_BASE, ...(loadSettings().social || {}), ...patch } });
}

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

test('该跳过的推文：敏感话题、空正文、转发；正常生活话不许误伤', () => {
  assert.equal(shouldSkipTweet({ text: '' }), '没有正文');
  assert.match(shouldSkipTweet({ text: '某地发生地震已致多人伤亡' }), /敏感/);
  assert.match(shouldSkipTweet({ text: 'RT @a: 转发一句话' }), /转发/);
  assert.equal(shouldSkipTweet({ text: '今天把周报写完了，手有点酸' }), '');
  assert.equal(shouldSkipTweet({ text: '这个咖啡也太好喝了' }), '');
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
