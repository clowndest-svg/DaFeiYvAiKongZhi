import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from './config.js';
import { addEvent, kvGet, kvSet } from './db.js';
import { logger } from './logger.js';
import { transcribeWav } from './asr.js';
import { synthesizeSpeech } from './tts.js';
import { ensureDir, shanghaiDayKey } from './util.js';

export const MAX_WAV_BYTES = 2 * 1024 * 1024;
export const MAX_WAV_SECONDS = 60;
export const MAX_SPEAK_CHARS = 160;

export class PresenceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PresenceError';
    this.status = status;
  }
}

function dayKey() {
  return shanghaiDayKey();
}

function readCount(key) {
  const n = Number(kvGet(key, '0') || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function bumpCount(key) {
  const next = readCount(key) + 1;
  kvSet(key, String(next));
  return next;
}

/**
 * 只认浏览器能稳定产出的标准 WAV：RIFF/WAVE + fmt + data，PCM16 或 float32。
 * 不做任何“看起来像就收下”的宽松判断——这个接口会把文件交给解码器。
 */
export function readWavInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return { ok: false, error: '音频太短，不像一个完整的 wav' };
  if (buffer.length > MAX_WAV_BYTES) return { ok: false, error: `语音文件超过 ${Math.round(MAX_WAV_BYTES / 1024 / 1024)}MB` };
  const tag = (offset) => buffer.toString('ascii', offset, offset + 4);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return { ok: false, error: '不是 wav 文件（缺 RIFF/WAVE 头）' };
  if (tag(12) !== 'fmt ') return { ok: false, error: 'wav 头里没有 fmt 段' };
  const fmtSize = buffer.readUInt32LE(16);
  const audioFormat = buffer.readUInt16LE(20);
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const byteRate = buffer.readUInt32LE(28);
  const bits = buffer.readUInt16LE(34);
  if (![1, 3].includes(audioFormat)) return { ok: false, error: '只收 PCM 或 float 波形' };
  if (bits !== 16 && bits !== 32) return { ok: false, error: '只收 16 位或 32 位音频' };
  if (channels < 1 || channels > 2) return { ok: false, error: '只收单声道或立体声' };
  if (sampleRate < 8000 || sampleRate > 48000) return { ok: false, error: '采样率要在 8k–48k 之间' };
  let dataOffset = 20 + fmtSize;
  let dataSize = 0;
  while (dataOffset + 8 <= buffer.length) {
    const id = tag(dataOffset);
    const size = buffer.readUInt32LE(dataOffset + 4);
    if (id === 'data') {
      dataSize = Math.min(size, buffer.length - dataOffset - 8);
      dataOffset += 8;
      break;
    }
    dataOffset += 8 + size + (size % 2);
  }
  if (!dataSize) return { ok: false, error: 'wav 里没有 data 段' };
  const seconds = byteRate > 0 ? dataSize / byteRate : 0;
  if (seconds < 0.2) return { ok: false, error: '这段太短了，没听到什么' };
  if (seconds > MAX_WAV_SECONDS) return { ok: false, error: `一条语音最长 ${MAX_WAV_SECONDS} 秒` };
  return { ok: true, seconds: Math.round(seconds * 10) / 10, sampleRate, channels, bits, dataSize };
}

export function decodeAudioPayload(value) {
  const text = String(value || '');
  if (!text) throw new PresenceError('没收到音频');
  const base64 = text.includes(',') ? text.slice(text.indexOf(',') + 1) : text;
  if (base64.length > MAX_WAV_BYTES * 1.5) throw new PresenceError('音频太大，先别说这么久');
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw new PresenceError('音频编码读不出来');
  }
  if (!buffer.length) throw new PresenceError('音频是空的');
  const info = readWavInfo(buffer);
  if (!info.ok) throw new PresenceError(info.error);
  return { buffer, info };
}

async function withTempWav(buffer, fn) {
  ensureDir(paths.presenceTmp);
  const file = path.join(paths.presenceTmp, `hear-${Date.now()}-${randomUUID()}.wav`);
  try {
    fs.writeFileSync(file, buffer);
    return await fn(file);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      logger.warn('临时语音文件没删掉', { file: path.basename(file) });
    }
  }
}

/** 他说 → 文字。麦克风开关没开就直接拒，不悄悄听。 */
export async function hearWav(value, { settings } = {}) {
  const presence = settings?.presence || {};
  if (!presence.micEnabled) throw new PresenceError('麦克风输入是关的：到设置页「陪伴与感官」里打开', 403);
  const { buffer, info } = decodeAudioPayload(value);
  const result = await withTempWav(buffer, (file) => transcribeWav(file));
  if (result.error && !result.text) throw new PresenceError(`没听清：${result.error}`, 500);
  return { text: result.text || '', engine: result.engine || 'none', seconds: info.seconds };
}

export function presenceBudget(settings) {
  const presence = settings?.presence || {};
  return {
    cameraEnabled: Boolean(presence.cameraEnabled),
    micEnabled: Boolean(presence.micEnabled),
    speakReplies: Boolean(presence.speakReplies),
    cameraToday: readCount(`presence_look_day:${dayKey()}`),
    cameraMax: Number(presence.cameraDailyMax) || 0,
    speakToday: readCount(`presence_speak_day:${dayKey()}`),
    speakMax: Number(presence.speakDailyMax) || 0,
    lastLookAt: kvGet('presence_last_look_at') || '',
    lookIntervalSeconds: Number(presence.cameraIntervalSeconds) || 90,
  };
}

function assertSlot(used, max, label) {
  if (max <= 0) throw new PresenceError(`${label}的每日上限设成了 0，等于关掉，先去掉上限或开额度`, 403);
  if (used >= max) throw new PresenceError(`今天的${label}次数用完了（${used}/${max}），明天自动恢复`, 429);
}

export function consumeCameraSlot(settings, { now = new Date() } = {}) {
  const presence = settings?.presence || {};
  if (!presence.cameraEnabled) throw new PresenceError('摄像头是关的：设置页「陪伴与感官」里打开才能让她看', 403);
  const budget = presenceBudget(settings);
  assertSlot(budget.cameraToday, budget.cameraMax, '让她看');
  const lastAt = Date.parse(budget.lastLookAt);
  const waitMs = (Number(presence.cameraIntervalSeconds) || 90) * 1000;
  if (Number.isFinite(lastAt) && now.getTime() - lastAt < waitMs) {
    const left = Math.ceil((waitMs - (now.getTime() - lastAt)) / 1000);
    throw new PresenceError(`刚刚才看过了，再等 ${left} 秒`, 429);
  }
  kvSet('presence_last_look_at', now.toISOString());
  bumpCount(`presence_look_day:${dayKey()}`);
  return presenceBudget(settings);
}

/** 念话只在真的合成成功时才计一次：TTS 坏了不该把一天的额度烧光。 */
export function checkSpeakSlot(settings) {
  const budget = presenceBudget(settings);
  assertSlot(budget.speakToday, budget.speakMax, '控制台念话');
  return budget;
}

export function noteSpeakUsed(settings) {
  bumpCount(`presence_speak_day:${dayKey()}`);
  return presenceBudget(settings);
}

/** 控制台念一句：单独一套日配额，不抢她发给 QQ 的语音额度。 */
export async function speakLine(text, settings) {
  const audio = await synthesizeSpeech(String(text || ''), {
    voice: settings?.tts?.voice,
    rate: settings?.tts?.rate,
    pitch: settings?.tts?.pitch,
    maxChars: MAX_SPEAK_CHARS,
  });
  return {
    url: `/api/voice/audio?file=${encodeURIComponent(path.basename(audio.file))}`,
    engine: audio.engine,
    voice: audio.voice,
    bytes: audio.bytes,
  };
}

export function noteLookFailed(reason) {
  addEvent('presence_look_error', '让她看摄像头没成', { error: String(reason || '').slice(0, 160) });
}
