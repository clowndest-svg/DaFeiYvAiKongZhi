// X/Twitter 动作的前置闸门。这里定的每一条都是"宁可不做，也不能把号做没"：
// 1) 开关、风控冷却、省钱模式、单个动作开关，缺一样就 409，绝不静默跳过；
// 2) 页面上一出现限流/验证/封禁字样，整条通道立刻进冷却，而不是重试到撞墙；
// 3) 公开内容照样过隐私闸门（他的账号、住址、真名不能出现在推文里）；
// 4) 送达证据：只认"页面上真的多了一条/点赞状态真的翻了"，认不到就报 DELIVERY_UNKNOWN，绝不重发。

import { loadSettings } from '../config.js';
import { kvGet, kvSet } from '../db.js';
import { costBlocked } from '../budget.js';
import { DeliveryUnknownError } from '../effects.js';

// X 的封禁/限流话术（中英都收着，界面语言可能跟着账号设置变）
const RISKY_PAGE = /(Something went wrong\.? Try reloading|You.?ve (?:hit|reached) the (?:rate )?limit|Try again later|Rate limit exceeded|Confirm your account|unusual account activity|unusual activity|Verify you are human|Temporarily restricted|This account doesn.?t exist| suspended|请验证|账号已被|操作频繁|访问频繁)/i;
const LOGIN_PAGE = /(\/i\/flow\/login|\/i\/jf\/onboarding|\/account\/access|mode=login)/i;

export function assertXAction(kind = 'read') {
  const social = loadSettings().social || {};
  if (!social.xEnabled) throw Object.assign(new Error('X（推特）互动未开启'), { status: 409 });
  const cooldown = kvGet('x_cooldown_until');
  if (Date.parse(cooldown) > Date.now()) {
    throw Object.assign(new Error(`X 风控冷却中，到 ${String(cooldown).slice(11, 16)} 再动手（要人工处理验证就去登录窗口）`), { status: 409 });
  }
  if (kind !== 'read' && costBlocked('xAuto')) throw Object.assign(new Error('省钱模式暂停 X 动作'), { status: 409 });
  const switches = {
    like: 'xAutoLike',
    retweet: 'xAutoRetweet',
    reply: 'xAutoReply',
    browse: 'xAutoBrowse',
    dmDraft: 'xDmDraft',
    followDraft: 'xFollowDraft',
  };
  const key = switches[kind];
  if (key && !social[key]) throw Object.assign(new Error(`X 的这个动作开关是关的（${key}）`), { status: 409 });
}

export function xCooldownUntil() {
  return kvGet('x_cooldown_until') || '';
}

export function isRiskyXError(error) {
  return RISKY_PAGE.test(String((error && error.message) || error));
}

export function triggerXCooldown(hours = 24, reason = '') {
  const until = new Date(Date.now() + hours * 3600000).toISOString();
  kvSet('x_cooldown_until', until);
  return until;
}

export function assertXPage(state) {
  const text = String(state?.text || state?.body || state?.snippet || '');
  const url = String(state?.url || '');
  if (RISKY_PAGE.test(text)) throw new Error(`X 页面提示限流/验证/封禁，已停止动作：${text.slice(0, 60)}`);
  if (state?.login || LOGIN_PAGE.test(url)) throw new Error('X 登录已失效或还没登录，请在登录窗口里重新登录');
}

export function isXLoginPage(url, text) {
  return LOGIN_PAGE.test(String(url || '')) || /Sign in to X|Log in to X|Create account|登录 X/.test(String(text || ''));
}

// 送达证据：数量必须真的变、状态必须真的翻，文字必须逐字对上。
export function assertXDeliveryEvidence({ beforeCount, afterCount, outgoing, content, text, state }) {
  const same = String(text || '').replace(/\s+/g, ' ').trim() === String(content || '').replace(/\s+/g, ' ').trim();
  if (!(afterCount > beforeCount && outgoing === true && same)) {
    throw new DeliveryUnknownError('没能核实这条真的发出去了，去 X 上确认，不要重复点');
  }
  if (state && state.risky) throw new DeliveryUnknownError('页面出现限流/验证提示，这条状态未知，不要去重复点');
}

export function assertXReactEvidence({ before, after, pressed, countDelta }) {
  if (after !== true || pressed !== true) throw new DeliveryUnknownError('点赞/转推状态没有真的翻过来，这次不算做成');
  if (countDelta < 0) throw new DeliveryUnknownError('按钮状态变了但计数对不上，页面可能没同步');
}
