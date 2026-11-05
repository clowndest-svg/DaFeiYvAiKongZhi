// RVC 二次变声：把已经合成好的语音再过一遍音色模型，换成他试听后选定的那个声音。
//
// 这个模块的稳定性约束（跟本地 TTS 同一套规矩）：
// 1) 引擎是本项目自带的隔离 Python（voice/rvc-env），没装就当功能不存在，绝不退回"悄悄不换声还装作换了"；
// 2) 子进程只在真的被调用时起来，超时只杀自己 spawn 的那个 pid；
// 3) 变声失败一律如实报原因，并由调用方决定（默认发原声），永远不许因为变声把话弄没；
// 4) 模型只能从清单里按 id 选，不接受调用方传路径（防目录穿越）。

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { logger } from './logger.js';
import { rvcPaths } from './rvc-paths.js';
import { rvcRunner } from './rvc-runner.js';

export { rvcPaths };

const F0_METHODS = ['harvest', 'pm', 'crepe', 'rmvpe', 'mfcc'];

// 路径一律按 root 现算：判据能指着空目录验"没装就拒绝"，也能指着假目录验传参，不依赖本机装了什么。
function readManifest(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

// 清单说有不算数：文件真在磁盘上、够大，才算可用。
export function listRvcModels(root = paths.root) {
  const p = rvcPaths(root);
  return readManifest(p.manifest)
    .map((entry) => {
      const pth = entry.pth ? path.join(p.root, entry.pth) : '';
      const index = entry.index ? path.join(p.root, entry.index) : '';
      const exists = Boolean(pth) && fs.existsSync(pth);
      const bytes = exists ? fs.statSync(pth).size : 0;
      return {
        id: String(entry.id || ''),
        title: String(entry.title || entry.id || ''),
        family: String(entry.family || '未标注'),
        source: String(entry.repo || ''),
        sample: entry.sample && fs.existsSync(path.join(p.root, entry.sample)) ? String(entry.sample) : '',
        pth: exists ? String(entry.pth) : '',
        index: index && fs.existsSync(index) ? String(entry.index) : '',
        bytes,
        available: exists && bytes > 1024 * 1024,
      };
    })
    .filter((item) => item.id)
    .sort((a, b) => (a.family === b.family ? a.title.localeCompare(b.title) : a.family.localeCompare(b.family, 'zh')));
}

export function findRvcModel(id, root = paths.root) {
  const wanted = String(id || '').trim();
  if (!wanted) return null;
  return listRvcModels(root).find((item) => item.id === wanted && item.available) || null;
}

export function rvcEngineStatus(root = paths.root) {
  const p = rvcPaths(root);
  const models = listRvcModels(root);
  const python = fs.existsSync(p.python);
  return {
    installed: python && fs.existsSync(p.worker),
    python: python ? path.relative(p.root, p.python).split(path.sep).join('/') : '',
    worker: fs.existsSync(p.worker),
    baseWeights: fs.existsSync(p.baseWeights),
    modelCount: models.length,
    readyCount: models.filter((m) => m.available).length,
    models,
    installHint: 'node tools/install-rvc-env.mjs && node tools/fetch-rvc-models.mjs',
  };
}

// 一次变声最多等多久：下限防"设置里填 0 就把变声秒砍"，上限防它一直占着机器。
export function rvcTimeoutMs(value) {
  const n = Number(value);
  return Math.max(15000, Math.min(600000, Number.isFinite(n) && n > 0 ? n : 180000));
}

function normalizeOptions(opts) {
  const transpose = Math.max(-24, Math.min(24, Math.round(Number(opts.transpose || 0))));
  const indexRate = Math.max(0, Math.min(1, Number(opts.indexRate ?? 0.5)));
  const protect = Math.max(0, Math.min(0.5, Number(opts.protect ?? 0.33)));
  const f0 = F0_METHODS.includes(opts.f0) ? opts.f0 : 'harvest';
  return { transpose, indexRate, protect, f0 };
}

// 一次转换。任何失败都变成 { ok:false, reason }，调用方拿原声继续。
export function rvcConvert(inputFile, modelId, opts = {}) {
  const started = Date.now();
  const root = opts.root || paths.root;
  const timeoutMs = rvcTimeoutMs(opts.timeoutMs);
  const engine = rvcEngineStatus(root);
  if (!engine.installed) return Promise.resolve({ ok: false, reason: '没装变声引擎（voice/rvc-env）', engineMissing: true, ms: 0 });
  if (!engine.baseWeights) return Promise.resolve({ ok: false, reason: '缺 RVC 基座权重 hubert_base.pt', engineMissing: true, ms: 0 });
  const model = findRvcModel(modelId, root);
  if (!model) return Promise.resolve({ ok: false, reason: `清单里没有这个音色或文件不在：${String(modelId).slice(0, 40)}`, ms: 0 });
  if (!fs.existsSync(inputFile)) return Promise.resolve({ ok: false, reason: '要变声的音频不在', ms: 0 });

  const params = normalizeOptions(opts);
  const outFile = String(opts.outFile || `${inputFile.replace(/\.[a-z0-9]+$/i, '')}-rvc.wav`);
  // 进程归 rvc-runner 管：同一个音色模型留在内存里，第二条语音不用再过 20 秒冷启动。
  const runner = opts.runner || rvcRunner(opts.runnerOptions || {});
  return runner
    .convert(inputFile, model, { ...params, outFile }, { timeoutMs })
    .then((out) => {
      // 上层也必须看一眼磁盘：调用方成功后会删掉原音频，指着不存在的文件发出去就等于那条语音没了。
      if (out.ok && (!out.file || !fs.existsSync(out.file))) {
        logger.warn('RVC 说成功了但文件不在', { model: model.id, file: out.file || '' });
        return { ok: false, reason: '变声说成功了，可磁盘上没有这个文件', ms: Date.now() - started, model: model.id };
      }
      if (out.ok) {
        logger.info('RVC 变声完成', { model: model.id, ms: out.ms, bytes: out.bytes });
        return { ok: true, file: out.file, bytes: out.bytes, model: model.id, title: model.title, ms: out.ms };
      }
      const reason = out.reason || '变声没成';
      logger.warn('RVC 变声没成', { model: model.id, reason, ms: Date.now() - started });
      return { ok: false, reason, ms: Date.now() - started, model: model.id };
    });
}

// 打开开关之前到底缺了哪一步：没装引擎、还没挑音色、挑的那个文件不在了——三件事不能混成一句。
export function rvcSelectProblem({ engine, modelId, chosen }) {
  if (!engine?.installed) return `还没装变声引擎，开不了（跑 ${engine?.installHint || 'node tools/install-rvc-env.mjs'}）`;
  if (!engine?.baseWeights) return '缺 RVC 基座权重 hubert_base.pt，开不了';
  if (!String(modelId || '').trim()) return '还没挑音色：先在下面点某个音色那一行的「用这个声音」，再打开这个开关';
  if (!chosen) return `这个音色不在清单里或文件不在磁盘上：${String(modelId).slice(0, 40)}`;
  return '';
}

export function rvcVoiceLabel(modelId, root = paths.root) {
  const model = findRvcModel(modelId, root);
  return model ? `RVC · ${model.title}` : '';
}
