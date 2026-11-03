// 桌面通知走 Windows 自己的气泡，不走浏览器：浏览器那条要"控制台开着 + 那个浏览器给过权限"，
// 而他真正需要知道的恰恰是人不在电脑前的那一刻（QQ 断了、要扫码）。
// 生产 Node 挂在进程守卫下，wscript/cscript 被禁止启动；powershell 不在禁止名单，用隐藏窗口的它。
// 代价说清楚：我们只能确认 powershell 退出码，确认不了"屏幕上真冒出了气泡"，
// 所以留了一条自检接口，点了就知道。
import { spawn } from 'node:child_process';
import { env, loadSettings } from './config.js';
import { addEvent, kvGetJson, kvSetJson } from './db.js';
import { logger } from './logger.js';

const STATE_KEY = 'qq_desktop_notify';
const SENT_KEY = 'qq_desktop_notify_sent';

const psQuote = (value) => String(value || '').replace(/["'`$\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

export function toastScript(title, body) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon = [System.Drawing.SystemIcons]::Information',
    '$n.Visible = $true',
    `$n.BalloonTipTitle = '${psQuote(title)}'`,
    `$n.BalloonTipText = '${psQuote(body)}'`,
    '$ProgressPreference=SilentlyContinue;',
    '$n.ShowBalloonTip(15000)',
    'Start-Sleep -Seconds 16',
    '$n.Dispose()',
  ].join('; ');
}

function runHiddenPowershell(script) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let stderr = '';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经退了 */ } }, 40000);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, error: String(error.message || error).slice(0, 120) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      // 成功时不回收 CLIXML 的进度记录：那是 powershell 的噪音，留着会把"其实弹出来了"写得像出过事。
      const clean = stderr.replace(/\s+/g, ' ').trim();
      resolve({ ok: code === 0, exitCode: code, error: code === 0 ? '' : clean.slice(0, 120) });
    });
  });
}

// 默认开着：2026-11-03 他明确说要开。设置里写成 false 才关。
export function desktopNotifyEnabled() {
  return loadSettings().qq?.desktopNotify !== false;
}

export function desktopNotifyState() {
  return kvGetJson(STATE_KEY, null);
}

export async function notifyDesktop({ title, body, run = runHiddenPowershell } = {}) {
  const result = await run(toastScript(title, body));
  const record = { ...result, title, at: new Date().toISOString(), enabled: desktopNotifyEnabled() };
  kvSetJson(STATE_KEY, record);
  if (!result.ok) {
    addEvent('qq_notify_failed', `想弹桌面通知没弹成：${result.error || `powershell 退出码 ${result.exitCode}`}`, { title });
    logger.warn('桌面通知失败', { title, exitCode: result.exitCode, error: result.error });
  }
  return record;
}

// 同一件事只通知一次：断连、要扫码这类状态会反复被看门狗读到，不能每次读到的时候都弹。
export async function maybeNotify(kind, { stamp = '', title, body, run = runHiddenPowershell } = {}) {
  // 隔离测试里默认那条真起 powershell 的路必须不动；判据传了 run 才允许跑逻辑（测去重和留痕）。
  if (env.testMode && !run) return { skipped: '隔离测试里不启动外部进程' };
  if (!desktopNotifyEnabled()) return { skipped: '桌面通知已关掉' };
  const key = `${kind}:${stamp || title}`;
  const sent = kvGetJson(SENT_KEY, {});
  if (sent[key]) return { skipped: '这件事已经通知过一次', at: sent[key] };
  const record = await notifyDesktop({ title, body, run });
  if (record.ok) {
    sent[key] = new Date().toISOString();
    kvSetJson(SENT_KEY, Object.fromEntries(Object.entries(sent).slice(-30)));
  }
  return record;
}
