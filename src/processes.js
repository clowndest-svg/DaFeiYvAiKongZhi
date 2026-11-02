import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { env, paths } from './config.js';

function windowsQuery(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding:'utf8', windowsHide:true, timeout:10000, maxBuffer:1024*1024, stdio:['ignore','pipe','ignore'] });
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
export async function startNapCat() {
  if (env.testMode) return {simulated:true};
  if (process.platform!=='win32') throw new Error('当前 NapCat 启动入口仅支持 Windows');
  if(listOwned('napcat').length)return {already:true};
  const exe=path.join(paths.root,'napcat','NapCatWinBootMain.exe');
  if(!fs.existsSync(exe))throw new Error('NapCat 未安装，请按 README 安装');
  const {loadSettings}=await import('./config.js');const account=loadSettings().qq.botAccount;
  if(!/^\d{5,12}$/.test(account))throw new Error('请先配置机器人 QQ 小号');
  const reg=execFileSync('reg.exe',['query','HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ','/v','UninstallString'],{encoding:'utf8',windowsHide:true,timeout:5000});
  const command=reg.match(/REG_SZ\s+(.+)/)?.[1]?.trim().replace(/^"|"$/g,'');
  const qq=command&&path.join(path.dirname(command),'QQ.exe');if(!qq||!fs.existsSync(qq))throw new Error('找不到 QQ 安装位置');
  const log=fs.openSync(path.join(paths.logs,'napcat.out'),'a');
  const child=spawn(exe,[qq,path.join(paths.root,'napcat','NapCatWinBootHook.dll'),account],{
    // 不能用 detached：Windows 上它等于 DETACHED_PROCESS（子进程没有控制台），
    // 于是还要往 stdout 写的 QQ.exe 会被系统另建一个可见控制台窗口（标题就是它的 exe 路径），
    // 桌面上那个黑框就是这么冒出来的。改成继承一个隐藏控制台，QQ 复用同一个控制台，不再新建窗口。
    cwd:path.join(paths.root,'napcat'), detached:false,windowsHide:true,stdio:['ignore',log,log],
    env:{...process.env,NAPCAT_LOAD_PATH:path.join(paths.root,'napcat','loadNapCat.js'),NAPCAT_INJECT_PATH:path.join(paths.root,'napcat','NapCatWinBootHook.dll'),NAPCAT_MAIN_PATH:path.join(paths.root,'napcat','napcat.mjs'),NAPCAT_PATCH_PACKAGE:path.join(paths.root,'napcat','qqnt.json')},
  });
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});fs.closeSync(log);child.unref();return {started:true};
}
