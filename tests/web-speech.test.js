import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('web/app.js', 'utf8');
const speech = source.slice(source.indexOf('function stopSpeech()'), source.indexOf('function updateVoiceButton()'));

function harness(api) {
  const players = [];
  const errors = [];
  class Audio {
    constructor(url) { this.url = url; players.push(this); }
    async play() { queueMicrotask(() => this.onended?.()); }
    pause() { this.paused = true; }
  }
  const context = vm.createContext({
    state: {}, AbortController, setTimeout, clearTimeout, Audio, api,
    withToken: url => url,
    splitSentences: text => String(text || '').split(/(?<=[。！？])/u).filter(Boolean),
    toast: message => errors.push(message),
  });
  vm.runInContext(speech, context);
  return { context, players, errors };
}

test('网页朗读用软件语音接口，不调用独立的系统高音女声', async () => {
  const requests = [];
  const app = harness(async (path, options) => {
    requests.push({ path, text: options.body.text });
    return { url: '/api/voice/audio?file=fixture.mp3', voice: 'zh-CN-XiaoxiaoNeural', engine: 'edge' };
  });
  await app.context.speak('我在呢。今天慢慢说。');
  assert.deepEqual(requests, [
    { path: '/api/voice/speak', text: '我在呢。' },
    { path: '/api/voice/speak', text: '今天慢慢说。' },
  ]);
  assert.equal(app.players.length, 2);
  assert.equal(app.errors.length, 0);
  assert.doesNotMatch(speech, /speechSynthesis|SpeechSynthesisUtterance/);
});

test('新朗读顶掉旧请求，旧请求返回后不能突然播出来', async () => {
  let releaseOld;
  const app = harness(async (path, options) => {
    if (options.body.text === '旧句子。') return new Promise(resolve => { releaseOld = resolve; });
    return { url: '/new.mp3' };
  });
  const old = app.context.speak('旧句子。');
  const latest = app.context.speak('新句子。');
  assert.equal(app.players.length, 0);
  releaseOld({ url: '/old.mp3' });
  await Promise.all([old, latest]);
  assert.equal(app.players.length, 1);
  assert.equal(app.players[0].url, '/new.mp3');
});

test('朗读失败明确提示，不偷偷换成系统声音或绕过配额', async () => {
  let requests = 0;
  const app = harness(async () => { requests += 1; throw new Error('今日念话额度用完'); });
  await app.context.speak('我在呢。');
  assert.equal(requests, 1);
  assert.equal(app.players.length, 0);
  assert.match(app.errors[0], /今日念话额度用完/);
});

test('音色回退时朗读会提示实际回退情况', async () => {
  const app = harness(async () => ({ url: '/fallback.wav', fallbackReason: '在线女声暂时不可用，已切换到本地语音' }));
  await app.context.speak('我在呢。');
  assert.match(app.errors[0], /已切换到本地语音/);
  assert.equal(app.players[0].url, '/fallback.wav');
});
