import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pcmAudioToWav, understandBrowserAudio, captureBrowserAudio } from '../src/video-audio.js';

const sample = () => ({ ok: true, sampleRate: 16000, pcmBase64: Buffer.alloc(32000, 1).toString('base64'), startSeconds: 4 });

test('音轨 PCM 转为单声道 WAV，拒绝错误格式和超限长度', () => {
  const wav = pcmAudioToWav(sample());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 32000);
  for (const value of [{ ...sample(), sampleRate: 48000 }, { ...sample(), pcmBase64: '***' }, { ...sample(), pcmBase64: Buffer.alloc(3201).toString('base64') }, { ...sample(), pcmBase64: Buffer.alloc(960002).toString('base64') }]) assert.throws(() => pcmAudioToWav(value));
});

test('音轨转写包含实际采样范围，完成和失败都清理临时 WAV', async () => {
  const browser = { evaluateFunction: async () => sample() };
  let file;
  const result = await understandBrowserAudio(browser, { transcribe: async input => {
    file = input;
    assert.equal(fs.readFileSync(input).length, 32044);
    return { text: '  今天测试语音  ', engine: 'fixture' };
  } });
  assert.equal(result.status, 'transcribed');
  assert.equal(result.text, '今天测试语音');
  assert.equal(result.startSeconds, 4);
  assert.equal(result.durationSeconds, 1);
  assert.equal(fs.existsSync(file), false);
  const failed = await understandBrowserAudio(browser, { transcribe: async input => { file = input; throw new Error('识别失败'); } });
  assert.equal(failed.status, 'error');
  assert.equal(fs.existsSync(file), false);
  const silent = await understandBrowserAudio({ evaluateFunction: async () => ({ ok: false, status: 'silent', reason: '无声音' }) }, { transcribe: async () => { throw new Error('不应识别'); } });
  assert.equal(silent.status, 'silent');
});

test('取消音轨采集会通知页面停止，取消本地识别时清理 WAV', async () => {
  const controller = new AbortController();
  let cancelCalled = false;
  const pending = captureBrowserAudio({ evaluateFunction: async (fn) => {
    if (fn.name === 'captureMediaAudioPage') return new Promise(() => {});
    cancelCalled = true;
  } }, { signal: controller.signal });
  controller.abort(new Error('停止采集'));
  await assert.rejects(pending, /停止采集/);
  assert.equal(cancelCalled, true);
  const second = new AbortController();
  let file;
  await assert.rejects(understandBrowserAudio({ evaluateFunction: async () => sample() }, { signal: second.signal, transcribe: async input => {
    file = input;
    second.abort(new Error('停止识别'));
    return { text: '不采用' };
  } }), /停止识别/);
  assert.equal(fs.existsSync(file), false);
});
