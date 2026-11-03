import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { env, paths } from './config.js';

function windowsQuery(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding:'utf8', windowsHide:true, timeout:10000, maxBuffer:1024*1024, stdio:['ignore','pipe','ignore'] });
}
// 定时任务里必须用异步版：同步版会把事件循环卡住近一秒，正在回的消息都被拖慢。
function windowsQueryAsync(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding:'utf8', windowsHide:true, timeout:10000, maxBuffer:1024*1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
function qqRootQuery(account) {
  return "$ErrorActionPreference='Stop';"
    + '$q=@(Get-CimInstance Win32_Process -Filter "Name=\'QQ.exe\'");'
    + `$m=@($q | Where-Object { $_.CommandLine -match '-q ${account}' });`
    + '$ids=@($q | ForEach-Object { $_.ProcessId });'
    + '@($m | Where-Object { $ids -notcontains $_.ParentProcessId } | ForEach-Object { @{pid=$_.ProcessId; parent=$_.ParentProcessId} }) | ConvertTo-Json -Compress';
}
function parseQqRoots(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}
export async function listBotQqRootsAsync(account) {
  const at = new Date().toISOString();
  if (!/^\d{5,12}$/.test(String(account || ''))) return { state: 'unknown', roots: [], at, reason: '机器人小号没配置' };
  if (env.testMode || process.platform !== 'win32') return { state: 'unknown', roots: [], at, reason: '非 Windows 或隔离测试，不查进程' };
  try {
    return { state: 'ok', roots: parseQqRoots(await windowsQueryAsync(qqRootQuery(account))), at, reason: '' };
  } catch (error) {
    return { state: 'unknown', roots: [], at, reason: String(error && error.message || error).slice(0, 80) };
  }
}
function normalize(file) { return path.resolve(file || '').replace(/\\/g,'/').toLowerCase(); }
export function isOwnedProcess(process, kind) {
  if (!process?.ProcessId || !process.ExecutablePath) return false;
  if (kind === 'napcat') return normalize(process.ExecutablePath) === normalize(path.join(paths.root,'napcat','NapCatWinBootMain.exe'));
  const words = String(process.CommandLine || '').match(/"[^"]*"|[^\s]+/g) || [];
  const entry = words.slice(1).find(word => !word.startsWith('-'))?.replace(/^"|"$/g, '');
  return normalize(process.ExecutablePath) === normalize(globalThis.process.execPath) && entry && normalize(entry) === normalize(path.join(paths.src, 'index.js'));
}
export function listOwned(kind) {
  if (env.testMode || process.platform !== 'win32') return [];
  const name=kind==='napcat'?'NapCatWinBootMain.exe':'node.exe';
  const raw=windowsQuery(`Get-CimInstance Win32_Process -Filter "Name='${name}'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`);
  const values=raw.trim()?JSON.parse(raw):[];
  return (Array.isArray(values)?values:[values]).filter(item=>isOwnedProcess(item,kind));
}
// QQ 进程数三态探测：present / absent / unknown。
// 查询失败绝不能当成 absent —— 那会被读成"客户端没了"，然后去启动第二个 QQ。
// 所以同一次查询里带上进程总数做哨兵：总数为 0 或命令报错都算 unknown。
export function countQqProcesses() {
  const at = new Date().toISOString();
  if (env.testMode || process.platform !== 'win32') return { state: 'unknown', count: null, at, reason: '非 Windows 或隔离测试，不查进程' };
  try {
    const raw = windowsQuery("$ErrorActionPreference='Stop'; $all=@(Get-Process); $qq=@($all | Where-Object { $_.ProcessName -eq 'QQ' }); Write-Output ($qq.Count.ToString() + '/' + $all.Count.ToString())");
    const [qqRaw, allRaw] = String(raw).trim().split('/');
    const count = Number(qqRaw);
    const total = Number(allRaw);
    if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0) {
      return { state: 'unknown', count: null, at, reason: `进程查询结果不可信（${String(raw).trim().slice(0, 20)}）` };
    }
    return { state: count > 0 ? 'present' : 'absent', count, at, reason: '' };
  } catch (error) {
    return { state: 'unknown', count: null, at, reason: String(error && error.message || error).slice(0, 80) };
  }
}

export async function stopOwned(kind) {
  const targets=listOwned(kind);
  for(const item of targets) await new Promise((resolve,reject)=>{
    const child=spawn('taskkill.exe',['/PID',String(item.ProcessId),'/T','/F'],{stdio:'ignore',windowsHide:true});
    const timer=setTimeout(()=>{child.kill();reject(new Error('停止进程超时'));},10000);
    child.once('error',reject);child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('没有确认进程已停止'));});
  });
  return { stopped:targets.length, simulated:env.testMode };
}
// 生成"隐藏窗口 + 脱离我们进程树"的启动脚本（.vbs + WScript.Shell.Run）。
// 为什么要脱离：实测父进程被杀（SIGKILL）或正常退出，detached:false 的子进程都会跟着死，
// 所以每次轮换生产 = 把 NapCat 一起带走 = 要人重扫一次码。detached:true 的子进程能活下来，
// 但 DETACHED_PROCESS 下 QQ.exe 会自己新建一个可见控制台（之前那个黑框）。
// 两轮对照实验的结果：
//   · spawn powershell detached → 脚本根本没跑起来（marker 文件没生成）
//   · spawn wscript detached + Run(cmd, 0, False) → 跑起来了、wscript 退出后子进程还活着、可见窗口 0
// 所以走 wscript；输出用 cmd 的 >> 追加，日志不会每次启动被清空。
export function buildHiddenLaunchVbs({ exe, args, cwd, logPath }) {
  const q = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const command = [q(exe), ...args.map(q)].join(' ');
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${q(cwd)}`,
    `sh.Run "cmd /c ${command} >> ${q(logPath)} 2>&1", 0, False`,
  ].join('\r\n');
}

// 机器人小号的 QQ 根实例。守卫必须看这个，不能看启动器：
// NapCatWinBootMain.exe 注入成功后会自己退出，于是旧守卫以为"什么都没跑"，
// 每次重启都再起一个 → 同一账号多个实例互相挤下线（实测这台机器上堆到 8 个）。
export function listBotQqRoots(account) {
  const at = new Date().toISOString();
  if (!/^\d{5,12}$/.test(String(account || ''))) return { state: 'unknown', roots: [], at, reason: '机器人小号没配置' };
  if (env.testMode || process.platform !== 'win32') return { state: 'unknown', roots: [], at, reason: '非 Windows 或隔离测试，不查进程' };
  try {
    return { state: 'ok', roots: parseQqRoots(windowsQuery(qqRootQuery(account))), at, reason: '' };
  } catch (error) {
    return { state: 'unknown', roots: [], at, reason: String(error && error.message || error).slice(0, 80) };
  }
}

// 要不要再起一个 NapCat：只有"确认没有 QQ 实例、也没有启动器"才允许。
// 查不到一律不动手——重复实例比没实例更糟（它们会互相把登录挤掉）。
export function shouldStartNapCat({ launcherCount = 0, qqProbeState = 'unknown', qqRootCount = 0 } = {}) {
  if (qqProbeState !== 'ok') return { start: false, reason: `QQ 实例查不到（${qqProbeState}），不重复启动` };
  if (qqRootCount > 0) return { start: false, reason: `已经有 ${qqRootCount} 个机器人小号的 QQ 在跑，再起一个会互相挤下线` };
  if (launcherCount > 0) return { start: false, reason: 'NapCat 启动器还在跑' };
  return { start: true, reason: '没有 QQ 实例也没有启动器' };
}

export async function startNapCat() {
  if (env.testMode) return {simulated:true};
  if (process.platform!=='win32') throw new Error('当前 NapCat 启动入口仅支持 Windows');
  const exe=path.join(paths.root,'napcat','NapCatWinBootMain.exe');
  if(!fs.existsSync(exe))throw new Error('NapCat 未安装，请按 README 安装');
  const {loadSettings}=await import('./config.js');const account=loadSettings().qq.botAccount;
  if(!/^\d{5,12}$/.test(account))throw new Error('请先配置机器人 QQ 小号');
  const probe = listBotQqRoots(account);
  const decision = shouldStartNapCat({
    launcherCount: listOwned('napcat').length,
    qqProbeState: probe.state,
    qqRootCount: probe.roots.length,
  });
  if (!decision.start) return { already: true, reason: decision.reason, instances: probe.roots.length };
  const reg=execFileSync('reg.exe',['query','HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ','/v','UninstallString'],{encoding:'utf8',windowsHide:true,timeout:5000});
  const command=reg.match(/REG_SZ\s+(.+)/)?.[1]?.trim().replace(/^"|"$/g,'');
  const qq=command&&path.join(path.dirname(command),'QQ.exe');if(!qq||!fs.existsSync(qq))throw new Error('找不到 QQ 安装位置');
  const napcatDir=path.join(paths.root,'napcat');
  const logPath=path.join(paths.logs,'napcat.out');
  const args=[qq,path.join(napcatDir,'NapCatWinBootHook.dll'),account];
  const envVars={...process.env,NAPCAT_LOAD_PATH:path.join(napcatDir,'loadNapCat.js'),NAPCAT_INJECT_PATH:path.join(napcatDir,'NapCatWinBootHook.dll'),NAPCAT_MAIN_PATH:path.join(napcatDir,'napcat.mjs'),NAPCAT_PATCH_PACKAGE:path.join(napcatDir,'qqnt.json')};

  // 首选：wscript 隐藏启动 + 脱离进程树。脚本写进 data/（运行时生成，不进仓库）。
  try {
    const vbsPath=path.join(paths.data,'launch-napcat.vbs');
    fs.writeFileSync(vbsPath, buildHiddenLaunchVbs({exe,args,cwd:napcatDir,logPath}),'utf8');
    const wscript=spawn('wscript.exe',[vbsPath],{cwd:napcatDir,detached:true,windowsHide:true,stdio:'ignore',env:envVars});
    wscript.unref();
    for(let i=0;i<16;i+=1){
      await new Promise((resolve)=>{setTimeout(resolve,500);});
      if(listOwned('napcat').length)return {started:true,mode:'detached-hidden'};
    }
  } catch { /* 落到下面的保底 */ }

  // 保底：老办法（继承隐藏控制台）。它会被我们带走，但至少不会出现可见窗口。
  const log=fs.openSync(logPath,'a');
  const child=spawn(exe,args,{
    // 不能用 detached：Windows 上它等于 DETACHED_PROCESS（子进程没有控制台），
    // 于是还要往 stdout 写的 QQ.exe 会被系统另建一个可见控制台窗口（标题就是它的 exe 路径），
    // 桌面上那个黑框就是这么冒出来的。改成继承一个隐藏控制台，QQ 复用同一个控制台，不再新建窗口。
    cwd:napcatDir, detached:false,windowsHide:true,stdio:['ignore',log,log], env:envVars,
  });
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});fs.closeSync(log);child.unref();
  return {started:true,mode:'inherited-console'};
}
