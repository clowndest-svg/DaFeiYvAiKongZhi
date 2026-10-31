// 本地 TTS 的主进程侧封装：只在真的被调用时才起子进程，用完自己收摊。
// 稳定性要求写死在这里：并发 1、超时只杀自己 spawn 的那个 pid、崩溃重启最多两次、
// 空闲 90 秒卸载模型；功能没被选用时这个模块不产生任何进程、定时器或网络请求。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env, paths } from './config.js';
import { logger } from './logger.js';
import { ensureDir } from './util.js';

const MODEL_FILES = ['model-steps-3.onnx', 'vocos-22khz-univ.onnx', 'lexicon.txt', 'tokens.txt', 'dict', 'date.fst', 'number.fst', 'phone.fst'];
const IDLE_UNLOAD_MS = 90000;
const RESTART_LIMIT = 2;

export function localTtsPaths(root = paths.root) {
  const dir = path.join(root, 'voice', 'matcha');
  return { dir, files: MODEL_FILES.map((name) => path.join(dir, name)) };
}

export function localTtsStatus(root = paths.root) {
  const { dir } = localTtsPaths(root);
  const missing = MODEL_FILES.filter((name) => !fs.existsSync(path.join(dir, name)));
  return { installed: missing.length === 0, missing, dir };
}

export class LocalTtsRunner {
  constructor({ root = paths.root, timeoutMs = 20000, threads = Number(env.localTtsThreads || 2), idleMs = IDLE_UNLOAD_MS } = {}) {
    this.root = root;
    this.timeoutMs = timeoutMs;
    this.threads = threads;
    this.idleMs = idleMs;
    this.child = null;
    // 记下每一个自己起过的 pid：超时那一步会把 child 引用摘掉（避免复用正在死的进程），
    // 但收摊时必须还能找到它，否则原生 worker 会以 200MB 的个头永久挂在机器上。
    this.children = new Set();
    this.pending = new Map();
    this.seq = 0;
    this.restarts = 0;
    this.busy = Promise.resolve();
    this.idleTimer = null;
    this.metrics = { calls: 0, firstMs: null, lastMs: null, lastSeconds: null, lastRtf: null, failures: 0, peakRssMB: null };
    this.lastError = '';
  }

  get alive() {
    return Boolean(this.child);
  }

  status() {
    const install = localTtsStatus(this.root);
    return {
      installed: install.installed,
      missing: install.missing,
      alive: this.alive,
      restarts: this.restarts,
      lastError: this.lastError || null,
      metrics: this.metrics,
    };
  }

  start() {
    if (this.child) return this.child;
    const install = localTtsStatus(this.root);
    if (!install.installed) throw new Error(`本地音色没装齐，缺 ${install.missing.join('、')}（跑 npm run tts:install-local）`);
    const worker = path.join(this.root, 'src', 'local-tts-worker.js');
    const child = spawn(process.execPath, [worker], {
      cwd: this.root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BIZHI_LOCAL_TTS_THREADS: String(this.threads) },
    });
    this.child = child;
    this.children.add(child);
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.onLine(line);
        index = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', () => {
      // 原生库的进度和 WARNING 不进主日志，只在失败时由超时/退出路径报告
    });
    // 子进程已经死了之后再写 stdin 会抛 EPIPE。这个 error 如果不接住，会以 uncaughtException
    // 冒到主进程 —— 一个本地音色把整个小知带下去是不能接受的。
    child.stdin.on('error', (error) => {
      this.lastError = `本地音色管道已断：${String(error.message).slice(0, 80)}`;
    });
    child.on('exit', (code) => {
      this.children.delete(child);
      if (this.child === child) this.child = null;
      const error = new Error(`本地音色进程退出了（${code}）`);
      for (const [, item] of this.pending) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      this.pending.clear();
      this.metrics.failures += 1;
      this.lastError = error.message;
      logger.warn('本地 TTS 子进程退出', { code });
    });
    child.on('error', (error) => {
      this.lastError = String(error.message);
    });
    return child;
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const item = msg.id === undefined ? null : this.pending.get(msg.id);
    if (!item) return;
    this.pending.delete(msg.id);
    clearTimeout(item.timer);
    if (msg.ok) item.resolve(msg);
    else item.reject(Object.assign(new Error(msg.error || '本地音色失败'), { fatal: Boolean(msg.fatal) }));
  }

  armIdleUnload() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop('idle'), this.idleMs);
    this.idleTimer.unref?.();
  }

  stop(reason = 'manual') {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const targets = [...this.children];
    if (this.child) targets.push(this.child);
    if (!targets.length) return { stopped: false, reason };
    this.child = null;
    for (const child of new Set(targets)) {
      try {
        child.stdin.write(`${JSON.stringify({ type: 'bye' })}\n`);
      } catch {
        // 管道可能已经断了
      }
      try {
        child.kill();
      } catch {
        // 已经退了
      }
      logger.info('本地 TTS 子进程已关闭', { reason, pid: child.pid });
    }
    return { stopped: true, pids: [...new Set(targets)].map((child) => child.pid), reason };
  }

  // 一次只放一个推理任务：这台机器还要同时跑 SenseVoice，抢核不如排队。
  synthesize(text, { out, speed = 1 } = {}) {
    const job = this.busy.then(() => this.run(text, out, speed), () => this.run(text, out, speed));
    this.busy = job.catch(() => {});
    return job;
  }

  async run(text, out, speed) {
    if (!out) throw new Error('没给出音频落点');
    ensureDir(paths.media);
    if (this.restarts > RESTART_LIMIT) throw new Error(`本地音色这轮不再重启（已试 ${this.restarts} 次）`);
    const child = this.start();
    const id = (this.seq += 1);
    const payload = { type: 'speak', id, text: String(text).slice(0, 200), speed, out };
    const wait = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 只处理自己持有的那个 pid，绝不按进程名批量结束
        try {
          child.kill();
        } catch {
          // 忽略
        }
        // kill 之后 exit 是异步的：现在就摘掉引用，否则下一次 synthesize 会复用这个正在死的进程。
        if (this.child === child) this.child = null;
        this.restarts += 1;
        reject(Object.assign(new Error('本地音色超时'), { code: 'LOCAL_TTS_TIMEOUT' }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(payload)}\n`);
      else throw new Error('本地音色进程已经不在了');
    } catch (error) {
      clearTimeout(this.pending.get(id)?.timer);
      this.pending.delete(id);
      throw error;
    }
    const result = await wait;
    this.metrics.calls += 1;
    if (this.metrics.firstMs === null) this.metrics.firstMs = result.ms;
    this.metrics.lastMs = result.ms;
    this.metrics.lastSeconds = result.seconds;
    this.metrics.lastRtf = result.seconds ? Number((result.ms / 1000 / result.seconds).toFixed(2)) : null;
    this.armIdleUnload();
    return result;
  }
}
