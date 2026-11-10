// 一键准备：检查 Node 版本 → 装依赖 → 交互生成 .env → 可选启动。
// 用法：node tools/setup.mjs（或双击 setup.bat）。不会覆盖已有的 .env。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const root = process.cwd();
const envPath = path.join(root, '.env');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 16)) {
  console.error(`需要 Node.js 22.16 或更高，当前是 ${process.version}。请先安装：https://nodejs.org/`);
  process.exit(1);
}

if (!fs.existsSync(path.join(root, 'node_modules', 'ws'))) {
  console.log('安装依赖（npm ci）…');
  const result = spawnSync(npm, ['ci'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('依赖安装失败。确认网络可用后重试，或手动执行 npm ci。');
    process.exit(result.status || 1);
  }
} else {
  console.log('依赖已安装，跳过。');
}

async function ask(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

if (fs.existsSync(envPath)) {
  console.log('.env 已存在，不覆盖（要重新配置请先备份并删除它）。');
} else {
  console.log('\n=== 生成 .env（只保存在本机，不会提交）===');
  const apiKey = await ask('DeepSeek API Key（sk-…；回车可稍后再填，先体验网页聊天也可）: ');
  let password = '';
  while (!password) password = await ask('控制台登录密码（必填，自己设一个）: ');
  const provider = (await ask('QQ 接入端 snowluma / napcat（默认 snowluma；不用 QQ 直接回车）: ')) || 'snowluma';
  const lines = [
    '# 由 setup 生成；请勿提交这个文件',
    `DEEPSEEK_API_KEY=${apiKey}`,
    'DEEPSEEK_BASE_URL=https://api.deepseek.com',
    'DEEPSEEK_MODEL=deepseek-flash',
    'PORT=7788',
    `ONEBOT_TOKEN=bz_${crypto.randomBytes(16).toString('hex')}`,
    `BIZHI_QQ_PROVIDER=${['napcat', 'snowluma'].includes(provider) ? provider : 'snowluma'}`,
    `CONSOLE_PASSWORD=${password}`,
    'OPEN_BROWSER=1',
    '',
  ];
  fs.writeFileSync(envPath, lines.join('\n'));
  console.log('.env 已生成。\n');
}

console.log('下一步：打开 http://127.0.0.1:7788/ 就能聊天；QQ 和社交平台在设置页按提示扫码接入。');
const answer = (await ask('现在启动服务吗？(Y/n) ')).toLowerCase();
if (answer !== 'n') {
  spawn(npm, ['start'], { cwd: root, stdio: 'inherit' });
}
