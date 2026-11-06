// RVC 变声引擎安装：隔离 Python 环境 + rvc-python，全程只写本项目 voice/ 目录，不动系统 Python。
// 每一步都把结论写进日志，最后 EXIT 行与产物一起才算数（后台任务的 "completed" 早于子进程结束）。
import './project-env.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const VOICE = path.join(ROOT, 'voice');
const ENV = path.join(VOICE, 'rvc-env');
const LOG = path.join(ROOT, 'data', 'logs', 'rvc-install.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.mkdirSync(VOICE, { recursive: true });

function run(exe, args, { timeout = 1800000, cwd = ROOT, env = {} } = {}) {
  const line = `$ ${exe} ${args.join(' ')}\n`;
  fs.appendFileSync(LOG, line);
  const r = spawnSync(exe, args, { cwd, windowsHide: true, env: { ...process.env, ...env }, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  fs.appendFileSync(LOG, out.split(/\r?\n/).slice(-40).join('\n') + `\n--- exit=${r.status ?? 'null'} ---\n`);
  return { status: r.status, out };
}

const steps = [];

// 1) uv 能不能给出一个 3.10（rvc-python 的依赖只有 3.10 有 Windows 轮子）
let py = run('uv', ['python', 'find', '3.10'], { timeout: 120000 });
fs.appendFileSync(LOG, 'uv python find 3.10 -> ' + py.out.trim().slice(-200) + '\n');
if (py.status !== 0) {
  py = run('uv', ['python', 'install', '3.10'], { timeout: 900000 });
  py = run('uv', ['python', 'find', '3.10'], { timeout: 120000 });
}
const python310 = py.out.trim().split(/\r?\n/).pop();
steps.push(['python310', python310]);
if (!python310) {
  fs.appendFileSync(LOG, 'FATAL: 拿不到 Python 3.10\nEXIT=1\n');
  process.exit(1);
}

// 2) 建隔离环境
if (!fs.existsSync(path.join(ENV, 'Scripts', 'python.exe'))) {
  run('uv', ['venv', '--python', python310, ENV], { timeout: 300000 });
}
const venvPy = path.join(ENV, 'Scripts', 'python.exe');
steps.push(['venv', fs.existsSync(venvPy) ? 'ok' : 'MISSING']);

// 3) 装 rvc-python（它会带 torch/faiss/fairseq 等）
const install = run('uv', ['pip', 'install', '--python', venvPy, 'rvc-python'], { timeout: 3000000 });
steps.push(['rvc-python', install.status === 0 ? 'ok' : 'exit ' + install.status]);

// 4) 真实导入检查（装上了不等于能用）
const check = run(venvPy, ['-I', '-c', 'import importlib.util as u;print({n:u.find_spec(n) is not None for n in ["torch","rvc_python","faiss","fairseq","librosa","soundfile"]})'], { timeout: 300000 });
steps.push(['imports', check.out.trim().slice(-300)]);
const ver = run(venvPy, ['-I', '-c', 'import torch;print(torch.__version__, torch.cuda.is_available())'], { timeout: 300000 });
steps.push(['torch', ver.out.trim().slice(-120)]);

fs.appendFileSync(LOG, '\n== 结论 ==\n' + steps.map(([k, v]) => `${k}: ${v}`).join('\n') + '\nEXIT=0\n');
