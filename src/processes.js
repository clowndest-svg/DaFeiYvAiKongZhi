import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { env, paths } from './config.js';

function windowsQuery(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding:'utf8', windowsHide:true, timeout:10000, maxBuffer:1024*1024 });
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
