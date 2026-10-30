import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { paths } from './config.js';
import { logger } from './logger.js';
import { SerialQueue } from './serial.js';
const asrQueue = new SerialQueue({ maxWaiting: 3, waitMs: 20000 });

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 16000;
const MIN_FREE_MB = 260;
const MAX_BYTES = 12 * 1024 * 1024;
const TAGS = /<\|[^|>]*\|>/g;

let lib = null;
let loadError = '';
let recognizer = null;
let pending = null;
let lastHeardAt = 0;

function modelFiles() {
  const dir = path.join(paths.root, 'asr', 'model');
  const tokens = path.join(dir, 'tokens.txt');
  for (const name of ['model.int8.onnx', 'model.onnx']) {
    const model = path.join(dir, name);
    if (fs.existsSync(model) && fs.existsSync(tokens)) return { model, tokens, dir };
  }
  return null;
}

function binding() {
  if (lib || loadError) return lib;
  try {
    lib = require('sherpa-onnx-node');
  } catch (error) {
    loadError = `识别库装不上：${error.message}`;
    logger.warn('sherpa-onnx 加载失败', { error: error.message });
  }
  return lib;
}

function ensureRecognizer() {
  if (recognizer) return Promise.resolve(recognizer);
  if (pending) return pending;
  const engine = binding();
  const files = modelFiles();
  if (!engine || !files) return Promise.resolve(null);
  if (os.freemem() / 1024 / 1024 < MIN_FREE_MB) {
    loadError = `本机空闲内存不足 ${MIN_FREE_MB}MB，先不加载识别模型`;
    logger.warn('内存不够，语音识别暂缓', { freeMb: Math.round(os.freemem() / 1024 / 1024) });
    return Promise.resolve(null);
  }
  pending = engine.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: files.model, language: 'zh', useInverseTextNormalization: 1 },
      tokens: files.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
      modelType: 'sense_voice',
    },
  })
    .then((instance) => {
      recognizer = instance;
      pending = null;
      loadError = '';
      logger.info('语音识别模型已加载', { model: path.basename(files.model) });
      return instance;
    })
    .catch((error) => {
      pending = null;
      loadError = error.message;
      logger.warn('语音识别模型加载失败', { error: error.message });
      return null;
    });
  return pending;
}

export function asrStatus() {
  const files = modelFiles();
  const ready = Boolean(files) && Boolean(binding());
  return {
    ready,
    warm: Boolean(recognizer),
    engine: ready ? 'sensevoice' : 'none',
    model: files ? path.basename(files.model) : '',
    modelBytes: files ? fs.statSync(files.model).size : 0,
    lastHeardAt,
    releaseSupported: false,
    error: loadError,
  };
}

function toTargetRate(wave) {
  if (wave.sampleRate === SAMPLE_RATE) return wave.samples;
  const resampler = new lib.LinearResampler(wave.sampleRate, SAMPLE_RATE);
  return resampler.flush(wave.samples);
}

export async function transcribeWav(file, { locked = false } = {}) {
  if (!locked) return asrQueue.run('asr', () => transcribeWav(file, { locked: true }));
  const abs = String(file || '');
  if (!abs || !fs.existsSync(abs)) return { text: '', engine: 'none', error: '没有语音文件' };
  const bytes = fs.statSync(abs).size;
  if (bytes < 200) return { text: '', engine: 'none', error: '语音文件是空的' };
  if (bytes > MAX_BYTES) return { text: '', engine: 'none', error: '语音太长，先不解' };
  const engine = await ensureRecognizer();
  if (!engine) return { text: '', engine: 'none', error: loadError || '识别模型没就绪' };
  const startedAt = Date.now();
  try {
    const wave = lib.readWave(abs);
    const stream = engine.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: toTargetRate(wave) });
    const result = await engine.decodeAsync(stream);
    lastHeardAt = Date.now();
    const text = String(result?.text || '').replace(TAGS, '').trim();
    logger.info('本地语音识别完成', { chars: text.length, ms: lastHeardAt - startedAt });
    return { text: text.slice(0, 500), engine: 'sensevoice', emotion: result?.emotion || '' };
  } catch (error) {
    loadError = error.message;
    logger.warn('本地语音识别失败', { error: error.message });
    return { text: '', engine: 'none', error: error.message };
  }
}

export async function transcribeRecord(data = {}, { fetchWav } = {}) {
  const qqText = String(data.text || '').trim();
  if (qqText && qqText !== '[语音]') {
    logger.info('语音由 QQ 转好了文字', { chars: qqText.length });
    return { text: qqText.slice(0, 500), engine: 'qq' };
  }
  const direct = String(data.file || '').trim();
  if (direct && !/^https?:|^base64:/.test(direct) && fs.existsSync(direct) && /\.wav$/i.test(direct)) {
    return transcribeWav(direct);
  }
  if (!asrStatus().ready) return { text: '', engine: 'none', error: loadError || '本地识别还没装上' };
  const wav = fetchWav ? await fetchWav(data) : '';
  if (!wav) return { text: '', engine: 'none', error: '语音转不成 wav' };
  return transcribeWav(wav);
}
