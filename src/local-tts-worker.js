// 本地 matcha 中文 TTS 的子进程 worker。
// 原生推理放在这里而不是主进程：实测单次同步 generate 会把主线程整段占住
// （132–382ms 期间 10ms 监测回调 0 次触发），会拖住 OneBot 心跳和控制台请求。
// 协议：stdin 收一行 JSON 请求，stdout 回一行 JSON 结果。
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const MODEL_DIR = path.join(ROOT, 'voice', 'matcha');
const threads = Number(process.env.BIZHI_LOCAL_TTS_THREADS || 2);

let tts = null;
let loadError = '';

function load() {
  if (tts) return tts;
  const sherpa = require('sherpa-onnx-node');
  tts = new sherpa.OfflineTts({
    model: {
      matcha: {
        acousticModel: path.join(MODEL_DIR, 'model-steps-3.onnx'),
        vocoder: path.join(MODEL_DIR, 'vocos-22khz-univ.onnx'),
        lexicon: path.join(MODEL_DIR, 'lexicon.txt'),
        tokens: path.join(MODEL_DIR, 'tokens.txt'),
        dataDir: MODEL_DIR,
        noiseScale: 0.6,
        lengthScale: 1.0,
      },
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
    maxNumSentences: 1,
    silenceScale: 0.2,
    numThreads: threads,
    provider: 'cpu',
  });
  return tts;
}

function writeWav(samples, sampleRate, file) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return buf.length;
}

function reply(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

readline.createInterface({ input: process.stdin })
  .on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'ping') return reply({ id: msg.id, ok: true, pong: true, loaded: Boolean(tts) });
  if (msg.type === 'bye') process.exit(0);
  if (msg.type !== 'speak') return;
  const t0 = Date.now();
  try {
    const engine = load();
    const audio = engine.generate({ text: String(msg.text || ''), sid: Number(msg.sid || 0), speed: Number(msg.speed || 1) });
    const seconds = audio.samples.length / audio.sampleRate;
    const bytes = writeWav(audio.samples, audio.sampleRate, msg.out);
    reply({ id: msg.id, ok: true, ms: Date.now() - t0, seconds, sampleRate: audio.sampleRate, bytes });
  } catch (error) {
    loadError = String(error && error.message);
    reply({ id: msg.id, ok: false, error: loadError.slice(0, 200), ms: Date.now() - t0 });
  }
})
  // 父进程没了（管道关闭）就自己收摊：原生模型常驻两百多 MB，不能留孤儿。
  .on('close', () => process.exit(0));

process.on('uncaughtException', (error) => {
  reply({ id: null, ok: false, fatal: String(error && error.message).slice(0, 200) });
  process.exit(1);
});
