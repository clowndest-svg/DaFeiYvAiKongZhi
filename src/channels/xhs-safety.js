import { loadSettings } from '../config.js';
import { kvGet, kvGetJson } from '../db.js';
import { costBlocked } from '../budget.js';
import { DeliveryUnknownError } from '../effects.js';

export function assertXhsAction(kind = 'read') {
 const social = loadSettings().social;
 if (!social.xhsEnabled) throw Object.assign(new Error('小红书互动未开启'), { status: 409 });
 const cooldown = kvGet('xhs_cooldown_until');
 if (Date.parse(cooldown) > Date.now()) throw Object.assign(new Error('小红书风控冷却中，请在登录窗口处理验证'), { status: 409 });
 if (kind !== 'read' && costBlocked('xhsAuto')) throw Object.assign(new Error('省钱模式暂停小红书动作'), { status: 409 });
 const switches = { like: 'xhsAutoLike', collect: 'xhsAutoCollect', dm: 'xhsDmReply', autoPublish: 'xhsAutoPublish' };
 if (switches[kind] && !social[switches[kind]]) throw Object.assign(new Error('对应小红书动作开关已关闭'), { status: 409 });
}

export function isOwnerConversation(item) {
 const binding = kvGetJson('xhs_owner_binding', null);
 const self = kvGet('xhs_self_user_id');
 return Boolean(binding?.convId && self && binding.selfId === self && item?.convId === binding.convId);
}

export function assertXhsPage(state) {
 const text = String(state?.text || state?.body || state?.snippet || '');
 if (/访问频繁|操作频繁|安全验证|滑块|滑动验证|我要申诉|账号.{0,6}限制|300013/.test(text)) throw new Error('小红书要求安全验证或提示账号限制，已停止动作');
 if (state?.login || state?.hasLoginButton || /\/login(?:[/?]|$)/.test(state?.url || '')) throw new Error('小红书登录已失效，请在登录窗口处理');
}

export function assertDeliveryEvidence({ beforeCount, afterCount, outgoing, content, text }) {
 if (!(afterCount > beforeCount && outgoing === true && String(text || '').replace(/\s+/g,' ').trim() === content)) throw new DeliveryUnknownError('未能核实新增的发送消息，请在平台确认，不要重复点击');
}
