import { kvGetJson, kvSetJson } from './db.js';
import { loadSettings } from './config.js';
import { qqProvider } from './qq-provider.js';

export const QQ_ACTIONS = {
  get_login_info: '登录身份', get_status: '账号状态', get_stranger_info: '联系人探活',
  send_private_msg: '私聊发送', send_group_msg: '群聊发送', get_record: '语音转换',
  get_msg: '消息查询', get_cookies: '空间 Cookie 扩展', get_credentials: '空间凭据扩展',
  can_send_image: '图片能力声明', can_send_record: '语音能力声明', get_version_info: '协议端版本',
};
function key() { return `qq_capabilities:${qqProvider}:${loadSettings().qq.botAccount}`; }
export function noteQqCapability(action, state, reason = '') {
  if (!QQ_ACTIONS[action]) return;
  try {
    const value = kvGetJson(key(), {});
    value[action] = { state, at: Date.now(), reason: String(reason).slice(0, 160) };
    kvSetJson(key(), value);
  } catch { /* Optional capability telemetry must not change a confirmed send. */ }
}
export function qqCapabilities() {
  const value = kvGetJson(key(), {});
  return Object.entries(QQ_ACTIONS).map(([action, label]) => ({ action, label, state: 'unverified', ...value[action] }));
}
export function cookieExtensionsUnavailable() {
  const value = kvGetJson(key(), {});
  return ['get_cookies', 'get_credentials'].every(action => value[action]?.state === 'unsupported' && Date.now() - value[action].at < 3600000);
}
