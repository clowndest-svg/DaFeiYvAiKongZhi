import fs from 'node:fs';
import path from 'node:path';
import { env, paths } from './config.js';

// Provider is fixed for the lifetime of the server. Switching requires a cold
// restart, so a settings save cannot route an in-flight reply to another client.
export const qqProvider = process.env.BIZHI_QQ_PROVIDER || 'napcat';
if (!['napcat', 'snowluma'].includes(qqProvider)) throw new Error('BIZHI_QQ_PROVIDER 只能是 napcat 或 snowluma');
export function providerInfo() {
  const snow = qqProvider === 'snowluma';
  const dir = path.join(paths.root, qqProvider);
  let webuiPort = snow ? 5099 : 6099;
  if (snow) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'runtime.json'), 'utf8')).webuiPort;
      if (Number.isInteger(value) && value > 0 && value <= 65535) webuiPort = value;
    } catch { /* The documented default remains usable before installation. */ }
  }
  return {
    id: qqProvider,
    name: snow ? 'SnowLuma' : 'NapCat',
    webUiUrl: `http://127.0.0.1:${webuiPort}/`,
    processesUrl: snow ? `http://127.0.0.1:${webuiPort}/processes` : null,
    dir,
    installed: fs.existsSync(path.join(dir, snow ? 'index.mjs' : 'napcat.mjs')),
    wsPath: snow ? '/onebot/snowluma' : '/onebot',
    wsUrl: `ws://127.0.0.1:${env.port}${snow ? '/onebot/snowluma' : '/onebot'}`,
    qrMode: snow ? 'desktop' : 'cache',
    loginHint: snow
      ? '在桌面 QQ 中扫码登录机器人小号，再在 SnowLuma 本机管理页手动接入该进程；不要启用自动注入。'
      : '用手机 QQ 扫描控制台中的二维码登录机器人小号。',
  };
}

export function snowLumaConfig({ account, token, port = env.port } = {}) {
  if (!/^\d{5,12}$/.test(String(account || ''))) throw new Error('请先配置机器人 QQ 小号');
  if (!token) throw new Error('ONEBOT_TOKEN 未配置');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口不合法');
  const closed = { networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] } };
  return {
    // Global defaults never connect other accounts. Only the bot has a client.
    global: closed,
    account: { networks: { ...closed.networks, wsClients: [{
      name: 'bizhi', enabled: true, url: `ws://127.0.0.1:${port}/onebot/snowluma`,
      role: 'Universal', accessToken: token, messageFormat: 'array',
      reportSelfMessage: false, reconnectIntervalMs: 3000,
    }] } },
    runtime: { webuiPort: 5099, webuiHost: '127.0.0.1', hookAutoLoad: false },
  };
}
