import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { env, paths } from './config.js';
import { SerialQueue } from './serial.js';

const queue = new SerialQueue();
const actions = new Set(['screenshot', 'windows', 'focus', 'click', 'scroll', 'type', 'key', 'open_url', 'open_app']);

export async function desktopAction(input, { signal } = {}) {
  if (!actions.has(input?.action)) throw new Error('未知桌面动作');
  if (env.testMode || process.platform !== 'win32') throw new Error('真实桌面工具只在 Windows 正式运行中可用');
  return queue.run('desktop', () => new Promise((resolve, reject) => {
    const file = input.action === 'screenshot' ? `owner-${randomUUID()}.png` : '';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(paths.root, 'tools', 'desktop.ps1')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal,
      env: { ...process.env, PSModulePath: undefined },
    });
    let output = '', error = '', done = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('桌面动作超时，执行状态未知，请截图核对后再操作')); }, 25000);
    function finish(failure, result) {
      if (done) return;
      done = true; clearTimeout(timer);
      if (failure) reject(failure); else resolve(result);
    }
    child.on('error', failure => finish(failure));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { error += chunk.toString('utf8'); });
    child.on('close', code => {
      try {
        if (code !== 0) throw new Error(error.slice(0, 1000) || `桌面工具退出 ${code}`);
        const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
        if (file) {
          const bytes = fs.readFileSync(path.join(paths.media, file));
          if (bytes.length > 7 * 1024 * 1024) throw new Error('桌面截图超过 7 MB，请调整屏幕分辨率');
          result.image = `data:image/png;base64,${bytes.toString('base64')}`;
          result.attachment = { url: `/media/${file}`, kind: 'screenshot' };
        }
        finish(null, result);
      } catch (failure) { finish(failure); }
    });
    child.stdin.end(JSON.stringify({ ...input, output: file ? path.join(paths.media, file) : '' }));
  }), { signal });
}
