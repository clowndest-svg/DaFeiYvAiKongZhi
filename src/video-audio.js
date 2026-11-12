import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storage } from './config.js';
import { asrStatus, transcribeWav } from './asr.js';

export async function captureMediaAudioPage({ token, seconds = 15 }) {
  const available = [...document.querySelectorAll('video,audio')].filter(item => item.readyState >= 2);
  const media = available.find(item => !item.paused) || available[0];
  if (!media || typeof media.captureStream !== 'function' || typeof MediaRecorder === 'undefined') return { ok: false, status: 'unavailable', reason: '播放器不支持音轨采集' };
  const duration = Math.max(1, Math.min(30, Number(seconds) || 15));
  let startSeconds = Number(media.currentTime) || 0;
  let cancelled = false, stream, recorder, context, timer;
  let cancelRecording = () => {};
  globalThis[token] = () => { cancelled = true; cancelRecording(); };
  try {
    await Promise.race([
      media.play(),
      new Promise((_, reject) => {
        cancelRecording = () => reject(new Error('采集已取消'));
        timer = setTimeout(() => reject(new Error('播放器启动超时')), 5000);
      }),
    ]);
    clearTimeout(timer);
    if (cancelled) return { ok: false, status: 'cancelled', reason: '采集已取消' };
    stream = media.captureStream();
    const tracks = stream.getAudioTracks();
    if (!tracks.length) return { ok: false, status: 'unavailable', reason: '当前视频没有可采集音轨' };
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) return { ok: false, status: 'unavailable', reason: '浏览器没有可用的音轨编码器' };
    const audio = new MediaStream(tracks);
    const chunks = [];
    let total = 0, tooLarge = false;
    recorder = new MediaRecorder(audio, { mimeType });
    const blob = await new Promise((resolve, reject) => {
      recorder.ondataavailable = event => {
        total += event.data.size;
        if (total > 4 * 1024 * 1024) { tooLarge = true; if (recorder.state === 'recording') recorder.stop(); return; }
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = event => reject(new Error(event.error?.message || '音轨采集失败'));
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
      cancelRecording = () => { if (recorder.state === 'recording') recorder.stop(); };
      media.addEventListener('ended', cancelRecording, { once: true });
      startSeconds = Number(media.currentTime) || 0;
      recorder.start(500);
      timer = setTimeout(cancelRecording, duration * 1000);
    });
    media.removeEventListener('ended', cancelRecording);
    if (cancelled) return { ok: false, status: 'cancelled', reason: '采集已取消' };
    if (tooLarge) return { ok: false, status: 'error', reason: '音轨采集超过大小上限' };
    context = new AudioContext({ sampleRate: 16000 });
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const count = Math.min(Math.floor(decoded.duration * 16000), 30 * 16000);
    const pcm = new Uint8Array(count * 2);
    const view = new DataView(pcm.buffer);
    let peak = 0;
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
    for (let index = 0; index < count; index++) {
      const source = Math.min(decoded.length - 1, Math.floor(index * decoded.sampleRate / 16000));
      const value = Math.max(-1, Math.min(1, channels.reduce((sum, channel) => sum + channel[source], 0) / channels.length));
      peak = Math.max(peak, Math.abs(value));
      view.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    if (!count || peak < 0.0005) return { ok: false, status: 'silent', reason: '采样音轨为静音，可能没有声音或受跨域限制', startSeconds, durationSeconds: count / 16000 };
    let binary = '';
    for (let offset = 0; offset < pcm.length; offset += 8192) binary += String.fromCharCode(...pcm.subarray(offset, offset + 8192));
    return { ok: true, pcmBase64: btoa(binary), sampleRate: 16000, durationSeconds: count / 16000, startSeconds, peak };
  } catch (error) {
    return { ok: false, status: cancelled ? 'cancelled' : 'error', reason: String(error.message).slice(0, 300) };
  } finally {
    clearTimeout(timer);
    media.removeEventListener('ended', cancelRecording);
    if (recorder?.state === 'recording') recorder.stop();
    stream?.getTracks().forEach(track => track.stop());
    await context?.close().catch(() => {});
    delete globalThis[token];
  }
}

export function pcmAudioToWav(capture) {
  if (capture.sampleRate !== 16000 || typeof capture.pcmBase64 !== 'string' || capture.pcmBase64.length > 1400000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(capture.pcmBase64)) throw new Error('音轨采样格式不合法');
  const pcm = Buffer.from(capture.pcmBase64, 'base64');
  if (pcm.length < 3200 || pcm.length % 2 || pcm.length > 30 * 32000) throw new Error('音轨样本长度不合法');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function captureBrowserAudio(browser, { seconds = 15, signal } = {}) {
  signal?.throwIfAborted();
  const token = `__bizhiAudio_${randomUUID().replaceAll('-', '')}`;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    browser.evaluateFunction(key => globalThis[key]?.(), [token], { timeoutMs: 3000 }).catch(() => {});
    rejectAbort(signal.reason);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([browser.evaluateFunction(captureMediaAudioPage, [{ token, seconds }], { timeoutMs: (Math.max(1, Math.min(30, Number(seconds) || 15)) + 15) * 1000 }), aborted]);
  } catch (error) {
    if (!signal?.aborted) await browser.evaluateFunction(key => globalThis[key]?.(), [token], { timeoutMs: 3000 }).catch(() => {});
    throw error;
  } finally { signal?.removeEventListener('abort', abort); }
}

export async function understandBrowserAudio(browser, { seconds = 15, signal, transcribe = transcribeWav } = {}) {
  signal?.throwIfAborted();
  if (!asrStatus().ready && transcribe === transcribeWav) return { status: 'unavailable', reason: '本地语音识别模型尚未就绪', text: '' };
  let file;
  try {
    const capture = await captureBrowserAudio(browser, { seconds, signal });
    if (!capture.ok) return { ...capture, text: '' };
    const wav = pcmAudioToWav(capture);
    file = path.join(storage.temp, `video-audio-${randomUUID()}.wav`);
    fs.writeFileSync(file, wav, { flag: 'wx' });
    const result = await transcribe(file, { signal });
    signal?.throwIfAborted();
    const text = String(result.text || '').trim().slice(0, 1000);
    return { status: text ? 'transcribed' : 'unrecognized', text, engine: result.engine, reason: result.error || (text ? '' : '本段音轨未识别出清晰语音'), startSeconds: Math.max(0, Number(capture.startSeconds) || 0), durationSeconds: (wav.length - 44) / 32000 };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: 'error', reason: String(error.message).slice(0, 300), text: '' };
  } finally { if (file && fs.existsSync(file)) fs.unlinkSync(file); }
}
