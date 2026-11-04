import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { env, paths, loadSettings } from './config.js';
import { logger } from './logger.js';
import { ensureDir } from './util.js';
import { LocalTtsRunner } from './local-tts.js';
import { rvcConvert } from './rvc.js';

export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

export const VOICE_CATALOG = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '小晓 · 御姐档（慢速低音）', note: '默认：+2% 速度、-12Hz 音高' },
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
      else reject(new Error(`${path.basename(exe)} 失败（${code}）${err.replace(/\s+/g, ' ').slice(-240)}`));
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

export function buildEdgeArgs(text, { voice, rate, pitch, volume }, file) {
  // argparse 会把单独的负值当成选项；带符号的参数必须与选项名合在一起。
  const args = ['-m', 'edge_tts', '--voice', voice, `--rate=${rate}`, `--pitch=${pitch}`];
  const vol = signed(volume, /^[+-][0-9]{1,3}%$/, '');
  if (vol) args.push(`--volume=${vol}`);
  args.push('--text', text, '--write-media', file);
  return args;
}

async function edgeCliSynthesize(text, options, file) {
  const cli = edgeCli();
  if (!cli) throw new Error('没装 edge 音色环境（voice/pyenv）');
  await runSpawn(cli.python, buildEdgeArgs(text, options, file), { timeoutMs: 30000, expectFile: file });
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


// 克隆音色：走本地 GPT-SoVITS 的 api_v2（/tts）。引擎装没装、地址对不对，都在设置里（tts.cloneUrl）。
// 参考音频必须是"你有权使用的那个人"的声音——这是他自己答应的，代码只负责调用。
async function cloneSynthesize(text, { cloneUrl, cloneRefAudio, clonePromptText }, file) {
  if (!cloneUrl) throw new Error('没配克隆引擎地址');
  if (!cloneRefAudio) throw new Error('没配参考音频');
  const base = String(cloneUrl).replace(/\/+$/, '');
  const res = await fetch(base + '/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      text_lang: 'zh',
      ref_audio_path: cloneRefAudio,
      prompt_text: clonePromptText || '',
      prompt_lang: 'zh',
      text_split_method: 'cut5',
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`克隆引擎 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`克隆引擎只回了 ${buf.length} 字节，不像音频`);
  fs.writeFileSync(file, buf);
  return { bytes: buf.length, mime: buf[0] === 0x52 ? 'audio/wav' : 'audio/mpeg' };
}

// 控制台"试听某个音色"用的这条路：先按当前设置合成，再只针对这一次做变声，不改用户选中的模型。
export async function synthesizeWithRvc(text, modelId, opts = {}) {
  const base = await synthesizeBase(text, opts);
  const cfg = loadSettings().tts?.rvc || {};
  const out = await rvcConvert(base.file, modelId, {
    transpose: opts.transpose ?? cfg.transpose,
    indexRate: opts.indexRate ?? cfg.indexRate,
    protect: opts.protect ?? cfg.protect,
    f0: opts.f0 || cfg.f0,
    timeoutMs: Math.max(15, Math.min(600, Number(cfg.timeoutSeconds || 180))) * 1000,
  });
  return { base, rvc: out };
}

// 他选的音色如果是"二次变声"出来的，那这一步必须真的跑过；跑不过就发原声并如实带上原因。
export async function synthesizeSpeech(text, opts = {}) {
  const base = await synthesizeBase(text, opts);
  return applyRvc(base);
}

export async function applyRvc(base, { convert = rvcConvert } = {}) {
  const cfg = loadSettings().tts?.rvc || {};
  if (cfg.enabled !== true || !cfg.model) return base;
  const out = await convert(base.file, cfg.model, {
    transpose: cfg.transpose,
    indexRate: cfg.indexRate,
    protect: cfg.protect,
    f0: cfg.f0,
    timeoutMs: Math.max(15, Math.min(600, Number(cfg.timeoutSeconds || 180))) * 1000,
  });
  if (!out.ok) {
    logger.warn('二次变声没成，这条发原来的声音', { model: cfg.model, reason: out.reason });
    return { ...base, rvc: { attempted: true, ok: false, reason: out.reason || '变声没成' } };
  }
  removeQuietly(base.file);
  return {
    ...base,
    file: out.file,
    bytes: out.bytes,
    mime: 'audio/wav',
    engine: `${base.engine}+rvc`,
    rvc: { attempted: true, ok: true, model: out.model, title: out.title, ms: out.ms },
  };
}

async function synthesizeBase(
  text,
  { voice = DEFAULT_VOICE, rate = '+2%', pitch = '-12Hz', volume = '', maxChars = 160 } = {},
) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
  if (!clean) throw new Error('没有要说的话');
  ensureDir(paths.media);
  const chosen = normalizeVoice(voice);
  let fallbackReason = '';
  const stamp = `${Date.now()}-${randomUUID()}`;

  // 克隆音色优先：配了地址就先试，失败按"退回在线音色"处理，绝不因为克隆挂掉就不说话。
  const cloneOpts = loadSettings().tts || {};
  if (cloneOpts.cloneUrl) {
    const wav = path.join(paths.media, `voice-${stamp}.wav`);
    try {
      const got = await cloneSynthesize(clean, cloneOpts, wav);
      const bytes = fs.statSync(wav).size;
      logger.info('语音已合成（克隆音色）', { bytes, chars: clean.length });
      return { file: wav, bytes, mime: got.mime, engine: 'clone', voice: 'clone', text: clean };
    } catch (error) {
      logger.warn('克隆音色不通，退回在线音色', { error: error.message });
      removeQuietly(wav);
    }
  }

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
      await edgeCliSynthesize(clean, { voice: chosen, rate: signed(rate, /^[+-][0-9]{1,3}%$/, '+2%'), pitch: signed(pitch, /^[+-][0-9]{1,3}Hz$/, '-12Hz'), volume: signed(volume, /^[+-][0-9]{1,3}%$/, '') }, mp3);
      const bytes = fs.statSync(mp3).size;
      logger.info('语音已合成（edge 音色）', { bytes, chars: clean.length, voice: chosen });
      return { file: mp3, bytes, mime: 'audio/mpeg', engine: 'edge', voice: chosen, text: clean };
    } catch (error) {
      fallbackReason = '在线音色暂时不可用，已切换到本地语音';
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
      return { file: wav, bytes, mime: 'audio/wav', engine: 'piper', voice: 'local-piper', requestedVoice: chosen, fallbackReason, text: clean };
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
    return { file, bytes, mime: 'audio/wav', engine: 'sapi', voice: 'sapi', requestedVoice: chosen, fallbackReason: fallbackReason || '所选音色不可用，已切换到系统语音', text: clean };
  } catch (error) {
    removeQuietly(file);
    throw error;
  }
}
