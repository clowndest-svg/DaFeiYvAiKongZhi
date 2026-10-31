import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { env, paths } from './config.js';
import { logger } from './logger.js';
import { ensureDir } from './util.js';
import { LocalTtsRunner } from './local-tts.js';

export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

export const VOICE_CATALOG = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '小晓 · 温柔大姐姐', note: '最自然，默认' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 软糯活泼', note: '偏少女' },
  { id: 'zh-TW-HsiaoChenNeural', label: '晓臻 · 台式轻软', note: '声音很轻' },
  { id: 'zh-TW-HsiaoYuNeural', label: '晓雨 · 气声甜', note: '气声多' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 港味女声', note: '可带粤语腔' },
  { id: 'zh-HK-HiuGaaiNeural', label: '曉佳 · 港味女声', note: '比曉曼稳' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北女', note: '逗趣' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西女', note: '方言' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 阳光男声', note: '想换男声' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 少年男声', note: '年纪小' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 低沉男声', note: '体育解说味' },
  { id: 'local-matcha', label: '本地离线 · Matcha 中文女声', note: '不联网；先跑 npm run tts:install-local' },
  { id: 'local-piper', label: '本地离线 · piper 华言', note: '音色一般，断网兜底' },
];

export function ttsVoices() {
  return VOICE_CATALOG;
}

// 子进程只在真的选了这个引擎时才起来（见 src/local-tts.js 的约束）。
const localRunner = new LocalTtsRunner();

export function localTts() {
  return localRunner;
}

export function localTtsReady() {
  return localRunner.status().installed;
}

export function normalizeVoice(voice) {
  const value = String(voice || '').trim();
  return VOICE_CATALOG.some((item) => item.id === value) ? value : DEFAULT_VOICE;
}

function signed(value, pattern, fallback) {
  const text = String(value || '').trim();
  return pattern.test(text) ? text : fallback;
}

export function edgeCli() {
  const base = path.join(paths.root, 'voice');
  const candidates = [
    path.join(base, 'pyenv', 'Scripts', 'python.exe'),
    path.join(base, 'pyenv', 'bin', 'python'),
    String(env.edgePython || '').trim(),
  ];
  const python = candidates.find((item) => item && fs.existsSync(item));
  return python ? { python } : null;
}

function piperPaths() {
  const exe = path.join(paths.root, 'asr', 'piper', 'piper.exe');
  const model = path.join(paths.root, 'asr', 'zh_CN-huayan-medium.onnx');
  const dataDir = path.join(paths.root, 'asr', 'piper', 'espeak-ng-data');
  if (fs.existsSync(exe) && fs.existsSync(model) && fs.existsSync(dataDir)) return { exe, model, dataDir };
  return null;
}

export function ttsStatus() {
  return {
    edge: Boolean(edgeCli()),
    piper: Boolean(piperPaths()),
    sapi: process.platform === 'win32',
    local: localRunner.status(),
  };
}

function runSpawn(exe, args, { timeoutMs = 25000, expectFile, stdin = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(exe)} 超时`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
      if (err.length > 4000) err = err.slice(-2000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const bytes = expectFile && fs.existsSync(expectFile) ? fs.statSync(expectFile).size : 0;
      if (code === 0 && bytes > 512) resolve(expectFile);
      else reject(new Error(`${path.basename(exe)} 失败（${code}）${err.replace(/\s+/g, ' ').slice(0, 140)}`));
    });
    if (stdin) {
      child.stdin.on('error', () => {
        // 进程已经退了，忽略管道错误
      });
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

async function edgeCliSynthesize(text, { voice, rate, pitch, volume }, file) {
  const cli = edgeCli();
  if (!cli) throw new Error('没装 edge 音色环境（voice/pyenv）');
  const args = ['-m', 'edge_tts', '--voice', voice, '--rate', rate, '--pitch', pitch];
  // 没显式给音量就一个参数都不多加：默认调用形态必须和改动前逐字一致。
  const vol = signed(volume, /^[+-][0-9]{1,3}%$/, '');
  if (vol) args.push('--volume', vol);
  args.push('--text', text, '--write-media', file);
  await runSpawn(cli.python, args, { timeoutMs: 30000, expectFile: file });
  return file;
}

async function piperSynthesize(text, file) {
  const piper = piperPaths();
  if (!piper) throw new Error('piper 还没装好');
  return runSpawn(piper.exe, ['--model', piper.model, '--data-dir', piper.dataDir, '--output_file', file, '--length_scale', '1.05'], {
    timeoutMs: 60000,
    expectFile: file,
    stdin: text,
  });
}

export function buildSapiScript(text, file) {
  const literal = (value) => `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(String(value), 'utf8').toString('base64')}'))`;
  return [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$text = ${literal(String(text).slice(0, 200))}`,
    `$file = ${literal(file)}`,
    'try { $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like "zh*" } | Select-Object -First 1; if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }; $s.SetOutputToWaveFile($file); $s.Speak($text) } finally { $s.Dispose() }',
  ].join('; ');
}

function sapiSynthesize(text, file) {
  if (process.platform !== 'win32') throw new Error('本机没有可用的语音引擎，请安装 Edge TTS 或 Piper');
  const script = Buffer.from(buildSapiScript(text, file), 'utf16le').toString('base64');
  return runSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
    timeoutMs: 30000,
    expectFile: file,
  });
}

function removeQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // 忽略
  }
}

export function piperReady() {
  return Boolean(piperPaths());
}

export async function synthesizeSpeech(
  text,
  { voice = DEFAULT_VOICE, rate = '+8%', pitch = '+2Hz', volume = '', maxChars = 160 } = {},
) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
  if (!clean) throw new Error('没有要说的话');
  ensureDir(paths.media);
  const chosen = normalizeVoice(voice);
  const stamp = `${Date.now()}-${randomUUID()}`;

  if (chosen === 'local-matcha') {
    const wav = path.join(paths.media, `voice-${stamp}.wav`);
    try {
      const result = await localRunner.synthesize(clean, { out: wav });
      const bytes = fs.statSync(wav).size;
      logger.info('语音已合成（本地 matcha）', { bytes, chars: clean.length, ms: result.ms, seconds: result.seconds });
      return { file: wav, bytes, mime: 'audio/wav', engine: 'local-matcha', voice: chosen, text: clean, seconds: result.seconds, sampleRate: result.sampleRate };
    } catch (error) {
      logger.warn('本地 matcha 不通，退回在线音色', { error: error.message });
      removeQuietly(wav);
    }
  }

  if (chosen !== 'local-piper') {
    const mp3 = path.join(paths.media, `voice-${stamp}.mp3`);
    try {
      await edgeCliSynthesize(clean, { voice: chosen, rate: signed(rate, /^[+-][0-9]{1,3}%$/, '+8%'), pitch: signed(pitch, /^[+-][0-9]{1,3}Hz$/, '+2Hz'), volume: signed(volume, /^[+-][0-9]{1,3}%$/, '') }, mp3);
      const bytes = fs.statSync(mp3).size;
      logger.info('语音已合成（edge 音色）', { bytes, chars: clean.length, voice: chosen });
      return { file: mp3, bytes, mime: 'audio/mpeg', engine: 'edge', voice: chosen, text: clean };
    } catch (error) {
      logger.warn('edge 音色不通，退回本地声', { error: error.message, voice: chosen });
      removeQuietly(mp3);
    }
  }

  if (piperPaths()) {
    const wav = path.join(paths.media, `voice-${stamp}.wav`);
    try {
      await piperSynthesize(clean, wav);
      const bytes = fs.statSync(wav).size;
      logger.info('语音已合成（piper 本地）', { bytes, chars: clean.length });
      return { file: wav, bytes, mime: 'audio/wav', engine: 'piper', voice: 'local-piper', text: clean };
    } catch (error) {
      logger.warn('piper 合成失败，退回本机语音', { error: error.message });
      removeQuietly(wav);
    }
  }

  const file = path.join(paths.media, `voice-${stamp}.wav`);
  try {
    await sapiSynthesize(clean, file);
    const bytes = fs.statSync(file).size;
    logger.info('语音已合成（本机 SAPI）', { bytes, chars: clean.length });
    return { file, bytes, mime: 'audio/wav', engine: 'sapi', voice: 'sapi', text: clean };
  } catch (error) {
    removeQuietly(file);
    throw error;
  }
}
