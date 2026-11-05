// RVC 常驻工人：把音色模型留在一个 Python 进程里，避免每条语音都冷启动一次。
// 实测（本机 CPU、4 秒语音）：新进程第一次转换 ~24 秒，同进程第二次 ~6 秒。
// 稳定性约束照搬本地 TTS 那一套：并发 1、超时只杀自己 spawn 的 pid、空闲就收摊、
// 功能没被用到时不产生任何进程、定时器或网络请求。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from './config.js';
import { logger } from './logger.js';
import { rvcPaths } from './rvc-paths.js';

const IDLE_UNLOAD_MS = 120000;
const RESTART_LIMIT = 2;
// 崩过之后隔多久允许再试：不隔时间就会"崩两次→永远拒绝"，那句"下一条会再试一次"就成了假话。
const DEATH_COOLDOWN_MS = 90000;
// 一次变声实际要吃 1.5~2.5GB（hubert + 检查点 + BLAS 工作区）。机器只剩这么点空闲就别起，
// 起了也是半路 segfault（实测 OpenBLAS malloc failed / 退出码 0xC0000005）。
const MIN_FREE_BYTES = 1_600_000_000;

export function rvcFreeMemoryGb() {
  return Math.round((os.freemem() / 1e9) * 100) / 100;
}

export class RvcRunner {
  constructor({ root = paths.root, idleMs = IDLE_UNLOAD_MS, spawnImpl = spawn, timeoutMs = 180000, minFreeGb = MIN_FREE_BYTES / 1e9, freeMemory = rvcFreeMemoryGb } = {}) {
    this.p = rvcPaths(root);
    this.idleMs = idleMs;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.minFreeGb = minFreeGb;
    this.freeMemory = freeMemory;
    this.child = null;
    this.children = new Set();
    this.queue = [];
    this.busy = Promise.resolve();
    this.idleTimer = null;
    this.restarts = 0;
    // deaths 只数"非自愿的死法"：空闲收摊是我自己关的，不该算崩，
    // 否则他多点两次试听就被"重启到上限"永久卡住。成功一次即清零。
    this.deaths = 0;
    this.lastDeathAt = 0;
    this.intentional = false;
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
      deaths: this.deaths,
      lastError: this.lastError || null,
      metrics: this.metrics,
    };
  }

  start() {
    if (this.child) return this.child;
    if (!fs.existsSync(this.p.python) || !fs.existsSync(this.p.server)) {
      throw new Error('没装变声引擎（voice/rvc-env 或 src/rvc-server.py 不在）');
    }
    const free = this.freeMemory();
    if (free < this.minFreeGb) {
      throw new Error(`机器内存不够变声（现在只剩 ${free} GB 空闲，一次要 ${Math.round(this.minFreeGb * 10) / 10} GB 以上）：先关掉一些程序再试`);
    }
    const child = this.spawnImpl(this.p.python, [this.p.server], {
      cwd: this.p.root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BIZHI_RVC_MODELS_DIR: this.p.modelDir,
        PYTHONIOENCODING: 'utf-8',
        // OpenBLAS/MKL 默认按 CPU 核数各开一份工作区，16GB 的机器上这就是第一块倒下的多米诺。
        OMP_NUM_THREADS: '2',
        OPENBLAS_NUM_THREADS: '2',
        MKL_NUM_THREADS: '2',
      },
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
        if (line) this.resolve(line, child);
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

  resolve(line, from) {
    // 收摊中的旧进程可能还吐最后一行；那行不属于任何在等的请求，
    // 认下来就会把新进程的回答错位消耗掉（表现是"说成功了但磁盘没文件"）。
    if (from && from !== this.child) return;
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
    if (this.intentional) this.intentional = false;
    else {
      this.deaths += 1;
      this.lastDeathAt = Date.now();
    }
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
    return this.ensureStarted()
      .catch((error) => ({ ok: false, error: String(error.message || error).slice(0, 140), refused: true }))
      .then(
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
    if (Date.now() - this.lastDeathAt > DEATH_COOLDOWN_MS) this.deaths = 0;
    if (this.deaths >= RESTART_LIMIT) {
      return Promise.reject(new Error(`变声进程连着崩了 ${this.deaths} 次，这条先用原来的声音（${Math.round(DEATH_COOLDOWN_MS / 1000)} 秒后会再试一次）`));
    }
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
    const loadTask = { cmd: 'load', model: path.join(this.p.root, model.pth), index: model.index ? path.join(this.p.root, model.index) : '' };
    const convertTask = { cmd: 'convert', src: inputFile, dst: params.outFile, transpose: params.transpose, index_rate: params.indexRate, protect: params.protect, f0: params.f0 };
    let out = await this.runTask(loadTask, convertTask, budget);
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
    // 只有真出声才清零"连着崩"的计数：失败也清零的话，进程反复死就会被无限重试拖住。
    this.deaths = 0;
    this.armIdle();
    return { ok: true, file: params.outFile, bytes: fs.statSync(params.outFile).size, ms: Date.now() - started };
  }

  // 进程半路没了（内存吃干、原生层 abort）不算这条该放弃：重新起一个进程再做一次，只重试一次。
  async runTask(loadTask, convertTask, budget, depth = 0) {
    if (this.loadedKey !== loadTask.model + '|' + loadTask.index) {
      const loaded = await this.ask(loadTask, budget);
      if (!loaded.ok) return { ok: false, error: loaded.error || '模型载入失败' };
      this.loadedKey = loadTask.model + '|' + loadTask.index;
    }
    const first = await this.ask(convertTask, budget);
    if (first.ok || first.refused) return first;
    if (this.child || first.timedOut || depth >= 1) return first;
    logger.warn('变声工人中途没了，重起一个进程再试一次', { error: first.error || '' });
    this.loadedKey = '';
    return this.runTask(loadTask, convertTask, budget, depth + 1);
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  stop() {
    this.intentional = true;
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
    return { ...s.metrics, alive: s.alive, loaded: s.loaded, restarts: s.restarts, deaths: s.deaths, lastError: s.lastError };
}

let shared = null;
export function rvcRunner(options = {}) {
  // 判据要能塞替身；产品代码不传参数，共用同一个常驻进程。
  if (options.spawnImpl || options.root) return new RvcRunner(options);
  if (!shared) shared = new RvcRunner();
  return shared;
}
