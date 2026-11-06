import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { env, paths } from '../src/config.js';
import { qqProvider } from '../src/qq-provider.js';
import { listOwned, startQqProvider } from '../src/processes.js';
import { acquireRuntimeLock } from '../src/runtime-lock.js';
import { restartDecision } from '../src/background-policy.js';

const disabledFile = path.join(paths.data, 'background.disabled');
const stateFile = path.join(paths.data, 'background-state.json');
const lockDir = path.join(paths.data, 'background');
const attempts = { app: [], qq: [] };
try {
  const previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')).attempts;
  for (const kind of ['app', 'qq']) if (Array.isArray(previous?.[kind])) attempts[kind] = previous[kind].filter(Number.isFinite);
} catch { /* A first run has no retry history. */ }
let stopping = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function save(state) {
  state.attempts = attempts;
  const temp = stateFile + '.tmp'; fs.writeFileSync(temp, JSON.stringify(state)); fs.renameSync(temp, stateFile);
}
async function healthy(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}
// The port owner's executable is checked without trusting a PID saved on disk.
// Relative index.mjs from a manual launch is observed here, never killed.
function snowProbe() {
  if (env.testMode || process.platform !== 'win32') return 'unknown';
  const script = `$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ExecutablePath,CommandLine); ConvertTo-Json -InputObject $p -Compress`;
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const all = JSON.parse(raw);
    if (!Array.isArray(all) || all.some(p => !p.ExecutablePath)) return 'unknown';
    const exe = path.join(paths.root, 'snowluma', 'node.exe').toLowerCase();
    return all.some(p => p.ExecutablePath.toLowerCase() === exe) ? 'present' : 'absent';
  } catch { return 'unknown'; }
}
async function tick() {
  const state = { at: new Date().toISOString(), provider: qqProvider, disabled: stopping || fs.existsSync(disabledFile) };
  let appProbe = 'unknown';
  try { appProbe = listOwned('server').length ? 'present' : 'absent'; } catch { /* Do not start on ambiguous ownership. */ }
  const appHealthy = await healthy(`http://127.0.0.1:${env.port}/api/health`);
  // An unknown occupant of the business port must never get a second writer.
  const app = restartDecision({ probe: appHealthy ? 'present' : appProbe, healthy: appHealthy, attempts: attempts.app, disabled: state.disabled });
  attempts.app = app.attempts;
  save(state); // Reserve a restart attempt before spawning, including crash recovery.
  if (app.start) {
    const log = fs.openSync(path.join(paths.logs, 'server.out'), 'a');
    try {
      const child = spawn(process.execPath, [path.join(paths.src, 'index.js')], { cwd: paths.root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, OPEN_BROWSER: '0' } });
      child.on('error', () => {}); child.unref();
    } finally { fs.closeSync(log); }
  }
  state.app = { state: app.state, retriesInWindow: attempts.app.length };
  const qqHealthy = qqProvider === 'snowluma' && await healthy('http://127.0.0.1:5099/');
  let probe = 'unknown';
  if (qqProvider === 'snowluma') probe = snowProbe();
  else { try { probe = listOwned('napcat').length ? 'present' : 'unknown'; } catch {} }
  const qq = restartDecision({ probe: qqHealthy ? 'present' : probe, healthy: qqHealthy, attempts: attempts.qq, disabled: state.disabled });
  attempts.qq = qq.attempts;
  save(state);
  if (qq.start) {
    try { await startQqProvider({ runtimeOnly: true, keepLauncherAlive: false }); } catch (error) { state.qqError = String(error.message).slice(0, 180); }
  }
  state.qq = { state: qq.state, retriesInWindow: attempts.qq.length };
  save(state);
}
export async function main() {
  if (process.platform !== 'win32' || env.testMode) throw new Error('后台守护只能由 Windows 操作者启用，隔离测试不启动真实服务');
  const release = acquireRuntimeLock(lockDir);
  process.on('SIGINT', () => { stopping = true; }); process.on('SIGTERM', () => { stopping = true; });
  try { while (!stopping && !fs.existsSync(disabledFile)) { await tick(); await sleep(15000); } } finally { release(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
