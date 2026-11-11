// 冻结 QQ 的热更新（可逆，不删文件、不杀进程、不动注册表）。
//
// 背景：QQ NT 9.9.x 每小时跑一次 startAutoUpdate（%APPDATA%\QQ\log\updater.log 可见），
// 新版本包下到 安装目录/versions/<版本>.zip，下次启动解压成 安装目录/versions/<版本>/ 并换装。
// 没有官方开关，界面那个勾选框由腾讯云控管；11-03 用的「把 zip 改名扣住」（hold-qq-update.mjs）
// 只挡一次，实测那个 1.14GB 的包后来已经不在了，云控随时能重下。
// SnowLuma 上游已停止公开维护，QQ 一旦换版本，本机这版协议端没人会来适配。
//
// 这里做的是目录级、只作用于 versions/ 这一层的 ACL 拒绝规则：
//   拒绝 Everyone 在该目录「新建文件 / 新建子目录」，不继承到子目录。
//   → 下载不了新 zip，解压不出新版本目录，因此不可能换装；
//   → 已存在的 config.json / setting.json / channel.json 仍可写（QQ 每次启动会清 readyVersion），
//      9.9.28-46928/ 里的内容完全不受影响，登录态在 %APPDATA%\QQ\auth 也不受影响。
// 一条 --unfreeze 精确移除这条规则即可回到原状；原有 ACL 从头到尾没被改写过。
//
// 边界：拦不住人手动运行完整安装包（QQSetup.exe）覆盖安装，也不拦 QQ 业务功能，
// 只拦「QQ 自己在 versions/ 里放新版本」。真要升级 QQ，先 --unfreeze，升完再 --freeze。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { qqInstallDir } from '../src/processes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'data', 'qq-update-freeze');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const FREEZE_SID = 'S-1-1-0'; // Everyone：QQ 无论以哪个身份运行都受这条拒绝规则约束
export const FREEZE_RIGHTS = 'CreateFiles, CreateDirectories';
const PROBE_FILE = '.bizhi-freeze-probe';

function die(message) {
  console.log(`✗ ${message}`);
  console.log('RESULT fail');
  process.exit(1);
}

// PowerShell 单引号字符串：只有单引号要翻倍。路径由我们生成，不做任何 shell 拼接。
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// 纯函数：便于测试，也避免把带引号的路径塞进命令行参数时被拆开。
export function buildFreezeScript({ mode = 'show', target = '', stateFile = '' } = {}) {
  const body = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$rights = [System.Security.AccessControl.FileSystemRights]__RIGHTS__
$sid = New-Object System.Security.Principal.SecurityIdentifier(__SID__)
function Find-FreezeRule($acl) {
  foreach ($entry in $acl.Access) {
    if ($entry.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Deny) { continue }
    if ($entry.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) { continue }
    if (($entry.FileSystemRights -band $rights) -ne $rights) { continue }
    try {
      $who = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch { continue }
    if ($who -eq $sid.Value) { return $entry }
  }
  return $null
}
function New-FreezeRule {
  return New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid, $rights,
    [System.Security.AccessControl.InheritanceFlags]::None,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Deny)
}
$acl = Get-Acl -LiteralPath $Target
$existing = Find-FreezeRule $acl
$result = [ordered]@{
  mode = $Mode
  target = $Target
  found = ($null -ne $existing)
  sddlBefore = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
  action = 'noop'
}
if ($Mode -eq 'freeze' -and $null -eq $existing) {
  $acl.AddAccessRule((New-FreezeRule))
  Set-Acl -LiteralPath $Target -AclObject $acl
  $result.action = 'added'
} elseif ($Mode -eq 'unfreeze' -and $null -ne $existing) {
  # 用实际读到的那条规则去删，不重建：ACL 规范化后 IdentityReference 可能从 SID 变成名称。
  $acl.RemoveAccessRuleSpecific($existing)
  Set-Acl -LiteralPath $Target -AclObject $acl
  $result.action = 'removed'
}
$after = Get-Acl -LiteralPath $Target
$result.foundAfter = ($null -ne (Find-FreezeRule $after))
$result.sddlAfter = $after.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
$json = $result | ConvertTo-Json -Compress
if ($StateFile) { $json | Set-Content -LiteralPath $StateFile -Encoding UTF8 }
$json
`;
  const withRights = body
    .replace('__RIGHTS__', psQuote(FREEZE_RIGHTS))
    .replace('__SID__', psQuote(FREEZE_SID));
  return [
    `$Mode = ${psQuote(mode)}`,
    `$Target = ${psQuote(target)}`,
    `$StateFile = ${psQuote(stateFile)}`,
    withRights,
  ].join('\n');
}

export function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const stdout = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
}

export function readQqVersions(versionsDir) {
  const result = { curVersion: '', readyVersion: '', pending: [], held: [], error: '' };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(versionsDir, 'config.json'), 'utf8'));
    result.curVersion = String(cfg.curVersion || '');
    result.readyVersion = String(cfg.readyVersion || '');
  } catch (error) {
    result.error = `config.json 读不到：${error.message}`;
  }
  try {
    for (const name of fs.readdirSync(versionsDir)) {
      if (/^\d+\.\d+\.\d+-\d+\.zip$/.test(name)) result.pending.push(name.replace(/\.zip$/, ''));
      else if (/^\d+\.\d+\.\d+-\d+\.zip\.held/.test(name)) result.held.push(name);
    }
  } catch (error) {
    result.error = `versions/ 读不到：${error.message}`;
  }
  return result;
}

function snapshot(versionsDir, sddlBefore) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const configNames = ['config.json', 'setting.json', 'channel.json'];
  const files = {};
  for (const name of configNames) {
    try { files[name] = fs.readFileSync(path.join(versionsDir, name), 'utf8'); }
    catch { files[name] = null; }
  }
  const backup = path.join(STATE_DIR, `before-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify({ at: new Date().toISOString(), sddlBefore, files }, null, 2));
  return backup;
}

function verifyFrozen(versionsDir) {
  const checks = [];
  // 1) 新文件：必须建不出来（这是「下载不了新版本包」的证明）
  const newFile = path.join(versionsDir, `.bizhi-probe-${process.pid}`);
  let createFileBlocked = false;
  try {
    fs.writeFileSync(newFile, 'x');
    fs.unlinkSync(newFile);
  } catch { createFileBlocked = true; }
  checks.push({ name: '不能在 versions/ 新建文件', ok: createFileBlocked });

  // 2) 新目录：必须建不出来（这是「解压不出新版本目录」的证明）
  const newDir = path.join(versionsDir, `.bizhi-probe-dir-${process.pid}`);
  let createDirBlocked = false;
  try {
    fs.mkdirSync(newDir);
    fs.rmdirSync(newDir);
  } catch { createDirBlocked = true; }
  checks.push({ name: '不能在 versions/ 新建目录', ok: createDirBlocked });

  // 3) 已存在文件：必须还能写（这是「QQ 每小时清 readyVersion 不受影响」的证明）
  const probe = path.join(versionsDir, PROBE_FILE);
  let existingWritable = false;
  try {
    fs.writeFileSync(probe, `probe ${new Date().toISOString()}`);
    existingWritable = true;
    fs.unlinkSync(probe);
  } catch { /* 保持 false */ }
  checks.push({ name: '已存在的 config.json 类文件仍可写', ok: existingWritable });

  // 4) 现役版本目录：必须还在、可读（冻结绝不能碰已经装好的那一版）
  let versionDirReadable = false;
  try { versionDirReadable = fs.readdirSync(versionsDir).some((n) => /^\d+\.\d+\.\d+-\d+$/.test(n)); }
  catch { /* 保持 false */ }
  checks.push({ name: '现役版本目录仍可读', ok: versionDirReadable });
  return checks;
}

// 被测试 import 时只暴露纯函数，绝不去动真实 ACL；只有 `node tools/freeze-qq-update.mjs ...` 才执行下面的动作。
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
const argv = process.argv.slice(2);
const mode = argv.includes('--freeze') ? 'freeze' : argv.includes('--unfreeze') ? 'unfreeze' : 'show';
const overrideIndex = argv.indexOf('--dir');
const overrideDir = overrideIndex >= 0 ? argv[overrideIndex + 1] : '';

if (process.platform !== 'win32') die('这个工具只在 Windows 上改 NTFS 权限');
const qqDir = overrideDir || await qqInstallDir();
if (!qqDir) die('读不到 QQ 安装位置（注册表卸载项），加 --dir "D:\\路径\\qq" 指定');
const versionsDir = path.join(qqDir, 'versions');
if (!fs.existsSync(versionsDir)) die(`versions/ 不存在：${versionsDir}`);

const versions = readQqVersions(versionsDir);
console.log(`QQ 安装位置：${qqDir}`);
console.log(`现役版本：${versions.curVersion || '未读到'}｜readyVersion：${versions.readyVersion || '（空）'}`);
console.log(`待装包：${versions.pending.join('、') || '无'}｜已扣住：${versions.held.join('、') || '无'}`);
if (versions.error) console.log(`提醒：${versions.error}`);
if (overrideDir) console.log('（本次用 --dir 指定的目录）');

let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { state = {}; }

if (mode === 'freeze') {
  // 冻结前先在 versions/ 放一个探针文件：冻结后要靠它证明「已存在文件仍可写」。
  const probe = path.join(versionsDir, PROBE_FILE);
  fs.writeFileSync(probe, 'probe before freeze');
  const backup = snapshot(versionsDir, '（写入前由 PowerShell 回填）');
  let ps;
  try {
    ps = runPowerShell(buildFreezeScript({ mode: 'freeze', target: versionsDir, stateFile: backup + '.aclresult' }));
  } catch (error) {
    try { fs.unlinkSync(probe); } catch { /* 不掩盖主错误 */ }
    die(`设置 ACL 失败：${error.message}`);
  }
  // 把真实的写入前 SDDL 补进备份（snapshot 先跑是为了保证「改之前」一定有一份落盘）。
  try {
    const saved = JSON.parse(fs.readFileSync(backup, 'utf8'));
    saved.sddlBefore = ps.sddlBefore;
    fs.writeFileSync(backup, JSON.stringify(saved, null, 2));
  } catch { /* 备份补写失败不影响冻结本身，但下面会明说 */ }
  try { fs.unlinkSync(backup + '.aclresult'); } catch { /* 清理 PS 的中间输出 */ }

  const checks = verifyFrozen(versionsDir);
  for (const check of checks) console.log(`${check.ok ? '✓' : '✗'} ${check.name}`);
  const ok = ps.foundAfter && checks.every((c) => c.ok);
  if (!ok) {
    console.log('冻结没通过验证，正在自动撤回这条 ACL 规则……');
    try { runPowerShell(buildFreezeScript({ mode: 'unfreeze', target: versionsDir })); } catch { /* 下面会给出手动命令 */ }
    die(`自检没过（action=${ps.action}, foundAfter=${ps.foundAfter}）。回退：node tools/freeze-qq-update.mjs --unfreeze`);
  }
  state = {
    ...state,
    frozenAt: new Date().toISOString(),
    unfrozenAt: null,
    qqDir,
    versionsDir,
    qqVersion: versions.curVersion,
    backup,
    sid: FREEZE_SID,
    rights: FREEZE_RIGHTS,
    action: ps.action,
  };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`✓ 已冻结：${ps.action === 'added' ? '新增拒绝规则' : '规则本来就在'}`);
  console.log(`  写入前备份：${backup}`);
  console.log('  放行（升级 QQ 前先跑）：node tools/freeze-qq-update.mjs --unfreeze');
  console.log('  说明：不删文件、不杀 QQ、不动登录态；手动运行完整安装包仍可覆盖安装，那不属于自动更新。');
} else if (mode === 'unfreeze') {
  let ps;
  try { ps = runPowerShell(buildFreezeScript({ mode: 'unfreeze', target: versionsDir })); }
  catch (error) { die(`移除 ACL 失败：${error.message}`); }
  if (ps.foundAfter) die('复核时规则还在，没放行成功；不要手动升级 QQ，先看一眼 icacls');
  const newFile = path.join(versionsDir, `.bizhi-probe-${process.pid}`);
  let writable = false;
  try { fs.writeFileSync(newFile, 'x'); writable = true; fs.unlinkSync(newFile); } catch { /* 保持 false */ }
  if (!writable) die('规则没了但新建文件仍失败，可能是别的 ACL 在挡；先看一眼 icacls');
  state = { ...state, unfrozenAt: new Date().toISOString(), frozenAt: null };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`✓ 已放行：${ps.action === 'removed' ? '移除拒绝规则' : '规则本来就不在'}；versions/ 现在可以新建文件了`);
  console.log('  升完 QQ 记得再跑：node tools/freeze-qq-update.mjs --freeze');
} else {
  let ps = null;
  let psError = '';
  try { ps = runPowerShell(buildFreezeScript({ mode: 'show', target: versionsDir })); }
  catch (error) { psError = error.message; }
  const frozen = ps ? ps.found : null;
  console.log(`冻结规则：${frozen === null ? `未读到（${psError}）` : frozen ? '已生效' : '未生效'}`);
  if (state.frozenAt) console.log(`冻结于：${state.frozenAt}（QQ ${state.qqVersion || '版本未记'}）｜备份：${state.backup || '无'}`);
  if (state.unfrozenAt) console.log(`上次放行：${state.unfrozenAt}`);
  console.log('QQ 每小时查一次更新（%APPDATA%\\QQ\\log\\updater.log）；冻结后它仍会查，但放不进新版本包。');
  console.log('命令：--freeze 冻结｜--unfreeze 放行｜--show 只读查看｜--dir "<QQ 安装目录>" 手动指定');
  if (psError) { console.log('RESULT fail'); process.exit(1); }
}
console.log('RESULT pass');
}

if (isMain) await main();
