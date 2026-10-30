export function checkBotIdentity({ selfId, ownerId, botAccount } = {}) {
  const self = String(selfId || '').trim();
  const owner = String(ownerId || '').trim();
  const bot = String(botAccount || '').trim();
  if (!/^\d{5,12}$/.test(self)) return { ok: false, reason: '还没拿到 NapCat 当前登录号' };
  if (owner && self === owner) return { ok: false, reason: 'NapCat 挂的是主人号，不能让她用你的身份说话' };
  if (!/^\d{5,12}$/.test(bot)) return { ok: false, reason: '还没有配置机器人 QQ 小号' };
  if (self !== bot) return { ok: false, reason: `NapCat 登录号 ${self} 不是机器人小号 ${bot}` };
  return { ok: true, reason: '' };
}
