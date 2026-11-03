// QQ 会自动把新版本包下到 versions/ 里，下次启动按 config.json 的 readyVersion 换装。
// 这台机器上 NapCat 挂在 QQ 上做注入，QQ 悄悄换版本可能直接把她打瘫，而且没有官方"关闭自动更新"的开关。
// 这个工具只做一件可逆的事：把待装的 zip 改名扣住（QQ 启动时找不到包就没得换），要放行一条命令改回来。
// 说清楚做不到的部分：腾讯云控可以重新下载同一个包，改名不等于永久关掉更新。
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, qqVersions } from '../src/napcat-versions.js';

const HELD = (version, at) => `${version}.zip.held-${at}`;
const HELD_RE = /^(\d+\.\d+\.\d+-\d+)\.zip\.held-/;

function die(message) {
  console.log(`✗ ${message}`);
  console.log('RESULT fail');
  process.exit(1);
}

const { qqInstallDir } = await import('../src/processes.js');
const dir = await qqInstallDir();
if (!dir) die('读不到 QQ 安装位置（注册表里没有可用的卸载项），不动任何东西');
const versionsDir = path.join(dir, 'versions');
const info = qqVersions(dir);
if (info.error) die(`versions/ 读不到：${info.error}`);
const current = info.curVersion || info.installed[0] || '';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const argv = process.argv.slice(2);
const mode = argv.includes('--hold') ? 'hold' : argv.includes('--release') ? 'release' : 'show';

const names = fs.readdirSync(versionsDir);
const held = names.filter((n) => HELD_RE.test(n));
console.log(`QQ 安装位置：${dir}`);
console.log(`已装版本：${current || '未读到'}｜config.json 的 readyVersion：${info.readyVersion ? info.readyVersion : '（空：下次启动本来就没排期要换）'}`);
console.log(`待装包：${info.pendingUpdate.join('、') || '无'}`);
console.log(`已扣住：${held.join('、') || '无'}`);
console.log('提醒：扣住不等于关掉更新——腾讯云控可能重新下载同一个包，所以她是每次对账时重新看一遍，升上去了会立刻报。');

if (mode === 'hold') {
  const targets = info.pendingUpdate.filter((v) => (compareVersions(v, current) ?? 0) > 0);
  if (!targets.length) { console.log('没有比当前版本新的待装包，什么都不用做'); console.log('RESULT pass'); process.exit(0); }
  if (info.readyVersion) console.log(`注意：readyVersion 已经是 ${info.readyVersion}，改名拦不住这一次换装（要放行得改回原名再想别的办法）`);
  for (const version of targets) {
    const from = path.join(versionsDir, `${version}.zip`);
    const to = path.join(versionsDir, HELD(version, stamp));
    if (!fs.existsSync(from)) die(`${version}.zip 不在了，先看一眼目录再说`);
    const bytes = fs.statSync(from).size;
    fs.renameSync(from, to);
    if (!fs.existsSync(to) || fs.existsSync(from)) die(`改名没成功（${version}），现役文件可能被占用，先别折腾`);
    console.log(`✓ 已扣住 ${version}（${(bytes / 1073741824).toFixed(2)} GB）→ ${path.basename(to)}`);
  }
  const after = qqVersions(dir);
  console.log(`复核：待装包 ${after.pendingUpdate.join('、') || '无'}｜已扣住 ${after.heldUpdate.join('、') || '无'}`);
  if (after.pendingUpdate.length) die('复核发现还有待装包没扣住，请看上面的目录');
  console.log(`放行（下次 QQ 启动就可能自己升版本）：node tools/hold-qq-update.mjs --release`);
  const { addEvent } = await import('../src/db.js');
  addEvent('qq_update_held', `她把 QQ 的待装更新包改名扣住了：${targets.join('、')}（NapCat 还跟着 ${current}）`, { targets, dir });
} else if (mode === 'release') {
  if (!held.length) { console.log('没有扣着的包'); console.log('RESULT pass'); process.exit(0); }
  for (const name of held) {
    const version = name.match(HELD_RE)[1];
    const to = path.join(versionsDir, `${version}.zip`);
    if (fs.existsSync(to)) die(`${version}.zip 已经在了（QQ 可能重新下过一个），不覆盖，先人工看一眼`);
    fs.renameSync(path.join(versionsDir, name), to);
    console.log(`✓ 已放行 ${version} → ${path.basename(to)}`);
  }
  console.log('放行之后，下次 QQ 启动就会照 config.json 的排期换装；换完她会在 QQ 面板里报出新的 QQ 版本。');
  const { addEvent } = await import('../src/db.js');
  const { kvGetJson, kvSetJson } = await import('../src/db.js');
  addEvent('qq_update_released', '他把之前扣住的 QQ 更新包放行了，下次 QQ 启动会自己换版本', { names: held });
  const held_state = kvGetJson('qq_update_held_state', null);
  if (held_state) kvSetJson('qq_update_held_state', { ...held_state, releasedAt: new Date().toISOString() });
}
console.log('RESULT pass');
// 报告得跟着马上变：不然 QQ 面板上还挂着「已下载待装 9.9.36」，而那个包已经被改名了。
if (mode !== 'show') {
  const { checkNapcatVersions } = await import('../src/napcat-versions.js');
  const fresh = await checkNapcatVersions();
  console.log(`对账报告已刷新：待装 ${fresh.qqPendingUpdate.join('、') || '无'}｜已扣住 ${fresh.qqHeldUpdate.join('、') || '无'}`);
}
