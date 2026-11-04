// RVC 常驻工人：把音色模型留在一个 Python 进程里，避免每条语音都冷启动一次。
// 实测（本机 CPU、4 秒语音）：新进程第一次转换 ~24 秒，同进程第二次 ~6 秒。
// 稳定性约束照搬本地 TTS 那一套：并发 1、超时只杀自己 spawn 的 pid、空闲就收摊、
// 功能没被用到时不产生任何进程、定时器或网络请求。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from './config.js';
import { logger } from './logger.js';
import { rvcPaths } from './rvc-paths.js';

const IDLE_UNLOAD_MS = 120000;
const RESTART_LIMIT = 2;

export class RvcRunner {
  constructor({ root = paths.root, idleMs = IDLE_UNLOAD_MS, spawnImpl = spawn, timeoutMs = 180000 } = {}) {
    this.p = rvcPaths(root);
    this.idleMs = idleMs;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.children = new Set();
    this.queue = [];
    this.busy = Promise.resolve();
    this.idleTimer = null;
    this.restarts = 0;
    this.loadedKey = '';
    this.lastError = '';
    this.metrics = { calls: 0, firstMs: null, lastMs: null, failures: 0 };
  }

  get alive() {
    return Boolean(this.child);
  }

  status() {
    return {
      alive: this.alive,
      loaded: this.loadedKey,
      restarts: this.restarts,
      lastError: this.lastError || null,
      metrics: this.metrics,
    };
  }

  start() {
    if (this.child) return this.child;
    if (!fs.existsSync(this.p.python) || !fs.existsSync(this.p.server)) {
      throw new Error('没装变声引擎（voice/rvc-env 或 src/rvc-server.py 不在）');
    }
    const child = this.spawnImpl(this.p.python, [this.p.server], {
      cwd: this.p.root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BIZHI_RVC_MODELS_DIR: this.p.modelDir, PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    this.children.add(child);
    this.loadedKey = '';
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.resolve(line);
        index = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).replace(/\s+/g, ' ').slice(0, 200);
      if (text && !/FutureWarning|warnings\.warn|tensorboardX|WeightNorm/.test(text)) this.lastError = text;
    });
    child.on('error', (error) => this.die(`变声进程报错：${String(error.message).slice(0, 100)}`));
    child.on('close', (code) => this.die(`变声进程退出了（${code}）`));
    return child;
  }

  resolve(line) {
    let payload = null;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    const task = this.queue.shift();
    if (!task) return;
    clearTimeout(task.timer);
    task.resolve(payload);
  }

  die(reason) {
    this.lastError = reason;
    this.child = null;
    this.loadedKey = '';
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const pending = this.queue.splice(0);
    for (const task of pending) {
      clearTimeout(task.timer);
      task.resolve({ ok: false, error: reason });
    }
  }

  ask(payload, timeoutMs) {
    return this.ensureStarted().then(
      () =>
        new Promise((resolve) => {
          const child = this.child;
          if (!child) {
            resolve({ ok: false, error: this.lastError || '变声进程没起来' });
            return;
          }
          const timer = setTimeout(() => {
            this.metrics.failures += 1;
            logger.warn('RVC 工人超时，收摊', { timeoutMs });
            this.killChild();
            resolve({ ok: false, error: `变声超过 ${Math.round(timeoutMs / 1000)} 秒没出来，已停止这次变声`, timedOut: true });
          }, timeoutMs);
          this.queue.push({ resolve, timer });
          try {
            child.stdin.write(`${JSON.stringify(payload)}\n`);
          } catch (error) {
            clearTimeout(timer);
            this.queue.pop();
            resolve({ ok: false, error: `写不进变声进程：${String(error.message).slice(0, 80)}` });
          }
        }),
    );
  }

  ensureStarted() {
    if (this.child) return Promise.resolve();
    if (this.restarts >= RESTART_LIMIT) return Promise.reject(new Error(`变声进程已经重启到上限（${this.restarts} 次），这条先用原来的声音`));
    try {
      this.restarts += 1;
      this.start();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  killChild() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // 已经退了
    }
  }

  // 一条完整的活：确保模型载入，再转换。同模型第二次只发 convert，省掉载入。
  async convert(inputFile, model, params, { timeoutMs } = {}) {
    const budget = Math.max(15000, Math.min(600000, Number(timeoutMs || this.timeoutMs)));
    const key = `${model.pth}|${model.index}`;
    const started = Date.now();
    try {
      await this.ensureStarted();
    } catch (error) {
      return { ok: false, reason: String(error.message).slice(0, 140) };
    }
    if (!this.child) return { ok: false, reason: this.lastError || '变声进程没起来' };
    if (this.loadedKey !== key) {
      const loaded = await this.ask({ cmd: 'load', model: path.join(this.p.root, model.pth), index: model.index ? path.join(this.p.root, model.index) : '' }, budget);
      if (!loaded.ok) return { ok: false, reason: loaded.error || '模型载入失败' };
      this.loadedKey = key;
    }
    const out = await this.ask(
      {
        cmd: 'convert',
        src: inputFile,
        dst: params.outFile,
        transpose: params.transpose,
        index_rate: params.indexRate,
        protect: params.protect,
        f0: params.f0,
      },
      budget,
    );
    this.metrics.calls += 1;
    this.metrics.lastMs = Date.now() - started;
    if (this.metrics.firstMs == null) this.metrics.firstMs = this.metrics.lastMs;
    if (!out.ok) {
      this.metrics.failures += 1;
      return { ok: false, reason: out.error || '变声没出声音' };
    }
    if (!fs.existsSync(params.outFile) || fs.statSync(params.outFile).size < 1024) {
      this.metrics.failures += 1;
      return { ok: false, reason: '变声说成功了但磁盘上没有文件' };
    }
    this.armIdle();
    return { ok: true, file: params.outFile, bytes: fs.statSync(params.outFile).size, ms: Date.now() - started };
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  stop() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    if (child) {
      try {
        child.stdin.write('{"cmd":"exit"}\n');
      } catch {
        // 管道断了就直接杀
      }
      setTimeout(() => {
        if (this.children.has(child) && child.exitCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // 已经退了
          }
        }
      }, 1500).unref?.();
    }
    this.child = null;
    this.loadedKey = '';
    for (const task of this.queue.splice(0)) {
      clearTimeout(task.timer);
      task.resolve({ ok: false, error: '变声进程已关闭' });
    }
  }
}

export function rvcRunnerMetrics() {
  if (!shared) return { alive: false, calls: 0, firstMs: null, lastMs: null, failures: 0, restarts: 0, lastError: null };
  const s = shared.status();
  return { ...s.metrics, alive: s.alive, loaded: s.loaded, restarts: s.restarts, lastError: s.lastError };
}

let shared = null;
export function rvcRunner(options = {}) {
  // 判据要能塞替身；产品代码不传参数，共用同一个常驻进程。
  if (options.spawnImpl || options.root) return new RvcRunner(options);
  if (!shared) shared = new RvcRunner();
  return shared;
}
