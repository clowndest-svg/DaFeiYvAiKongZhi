import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Derived from the official v2.4.0 full Windows archive after digest verification.
export const SNOWLUMA_RELEASE = Object.freeze({
  tag: 'v2.4.0', bytes: 43339979,
  sha256: '93096cb6d4cf576999094e9f7d1c9fb08e22f6b41c879182f015e639dc437613',
  files: {
    'index.mjs': '2af79d5759b65a15a97a1f6d600b4ce895b54d2b2fc475b8aa566f57035c2e93',
    'node.exe': 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5',
    'package.json': '3e3d59782c9bea1f88c2964719d8ac6b6ed925eb4f3d743ca38a2859b0f8e8ea',
    'native/snowluma-win32-x64.dll': 'e467f2f6a2eef400d21f0eddd8fe241c40daf9fbce00808a937d19e5d8593dbc',
    'native/snowluma-win32-x64.node': '0a6896f75261fe951f4e7117790f3850be070f76959049a8c8c0f8f19ef710af',
    'native/websocket-win32-x64.node': '6e71a14b1d28a6259bc1fb52dea2bdf13f100b326c04b14132f7a53b64fe9383',
    'native/ffmpeg/ffmpegAddon.win32.x64.node': '80a4dfbb170f093f4a64fe241b8583fb630c58219100cad7a3cad798f71864db',
    'native/sqlite/prebuilds/win32-x64/@appthreat+sqlite3.node': 'e8898fd92aebbecdc946c14e2a9f9c481946de3cbde1ebc3c647c02892640598',
  },
});

export function validateSnowLumaConfig({ dir, botAccount, token, wsUrl }) {
  const read = name => JSON.parse(fs.readFileSync(path.join(dir, 'config', name), 'utf8'));
  const runtime = read('runtime.json');
  if (runtime.hookAutoLoad !== false || runtime.webuiHost !== '127.0.0.1') throw new Error('SnowLuma 必须关闭自动注入，管理页只绑定本机');
  if (!/^\d{5,12}$/.test(String(botAccount || '')) || !token) throw new Error('机器人账号或 OneBot 令牌未配置');
  const names = fs.readdirSync(path.join(dir, 'config')).filter(name => /^onebot(?:_.*)?\.json$/.test(name));
  const botFile = `onebot_${botAccount}.json`;
  if (!names.includes('onebot.json') || !names.includes(botFile)) throw new Error('缺少全局或机器人账号的 OneBot 配置');
  for (const name of names) {
    const config = read(name);
    const networks = config.networks;
    if (!networks || !['httpServers', 'httpClients', 'wsServers', 'wsClients'].every(kind => Array.isArray(networks[kind]))) throw new Error('OneBot 配置必须使用完整 networks 格式');
    const enabled = Object.entries(networks).flatMap(([kind, list]) => {
      if (!Array.isArray(list)) throw new Error('OneBot networks 字段不合法');
      return list.filter(item => item.enabled !== false).map(item => ({ kind, item }));
    });
    if (name !== botFile && enabled.length) throw new Error('全局及其他账号不能启用适配器');
    if (name === botFile && (enabled.length !== 1 || enabled[0].kind !== 'wsClients')) throw new Error('机器人账号只能有一个反向 WebSocket');
    if (name === botFile) {
      const c = enabled[0].item;
      if (c.url !== wsUrl || c.accessToken !== token || c.role !== 'Universal' || c.messageFormat !== 'array' || c.reportSelfMessage !== false) throw new Error('机器人反向 WebSocket 地址、令牌、消息格式或角色不匹配');
    }
  }
  return true;
}

export function verifySnowLumaFiles(dir) {
  for (const [name, expected] of Object.entries(SNOWLUMA_RELEASE.files)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
    if (actual !== expected) throw new Error(`SnowLuma ${name} 与核对过的官方版本不一致，未启动`);
  }
  return true;
}
