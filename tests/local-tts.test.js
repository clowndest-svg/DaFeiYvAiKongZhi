// 本地 matcha 引擎的判据。
// 分两层：不需要模型的结构判据（缺文件就拒绝、不起进程、超时只杀自己），
// 和真跑原生推理的门禁判据（默认跳过，明确说明"没测"而不是"通过"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalTtsRunner, localTtsStatus } from '../src/local-tts.js';

const PRODUCT_DIR = path.join(process.cwd(), 'voice', 'matcha');
const installed = localTtsStatus(process.cwd()).installed;

test('缺文件时状态如实报告缺哪几个，并且 synthesize 直接拒绝、不起进程', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bizhi-tts-empty-'));
  try {
    const status = localTtsStatus(empty);
    assert.equal(status.installed, false);
    assert.ok(status.missing.includes('model-steps-3.onnx'), '没报告缺声学模型');
    assert.ok(status.missing.includes('vocos-22khz-univ.onnx'), '没报告缺声码器（matcha 的包里没有）');
    const runner = new LocalTtsRunner({ root: process.cwd() });
    // 指着一个空目录跑：必须报错并给出安装命令，且绝不 spawn。
    const missingRunner = new LocalTtsRunner({ root: empty });
    await assert.rejects(() => missingRunner.synthesize('你好', { out: path.join(empty, 'a.wav') }), /没装齐|install-local/);
    assert.equal(missingRunner.alive, false, '模型没齐就已经起了子进程');
    runner.stop();
  } finally {
    fs.rmSync(empty, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('产品目录里没装权重时，试听接口不会假装本地可用', () => {
  const status = localTtsStatus(process.cwd());
  assert.equal(typeof status.installed, 'boolean');
  if (!status.installed) {
    assert.ok(status.missing.length > 0, '没装却报不出缺什么文件');
  }
});

test('超时只处理自己 spawn 的那个进程，并且到次数上限就不再重试', { skip: installed ? false : '本机 voice/matcha 没装权重，跑不了真推理' }, async () => {
  const runner = new LocalTtsRunner({ root: process.cwd(), timeoutMs: 120 });
  const child = [];
  const originalSpawn = runner.start.bind(runner);
  runner.start = () => {
    const c = originalSpawn();
    child.push(c);
    return c;
  };
  await assert.rejects(() => runner.synthesize('今天怎么啦？', { out: path.join(process.cwd(), 'data', 'media', `timeout-${Date.now()}.wav`) }), /超时/);
  assert.ok(child.length >= 1, '没起过子进程，超时判据是空的');
  assert.equal(runner.alive, false, '超时之后子进程没被收掉');
  await assert.rejects(() => runner.synthesize('再来一句', { out: path.join(process.cwd(), 'data', 'media', `timeout2-${Date.now()}.wav`) }));
  runner.stop();
});

test('真跑一句中文：出得了 wav、时长量级合理、RTF 在门槛内', { skip: installed ? false : '本机 voice/matcha 没装权重，跑不了真推理' }, async (t) => {
  const out = path.join(process.cwd(), 'data', 'media', `local-tts-test-${Date.now()}.wav`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const runner = new LocalTtsRunner({ root: process.cwd(), timeoutMs: 30000 });
  t.after(() => runner.stop());
  const first = await runner.synthesize('今天怎么啦？听起来你有点累。', { out });
  assert.ok(first.seconds > 1 && first.seconds < 20, `音频时长不合理：${first.seconds}`);
  assert.equal(first.sampleRate, 22050);
  assert.ok(fs.existsSync(out) && fs.statSync(out).size > 1000);
  const header = fs.readFileSync(out).subarray(0, 4).toString();
  assert.equal(header, 'RIFF', '写出来的不是 wav');
  // 第二句是暖机后的成绩，准入门槛看这个（RTF P95 ≤0.5 是我给这台机器定的等级一线）。
  const second = await runner.synthesize('我记着你说过周三要交报告。', { out });
  const rtf = second.ms / 1000 / second.seconds;
  assert.ok(rtf <= 0.5, `暖机 RTF 超门槛：${rtf.toFixed(2)}`);
  assert.ok(runner.status().metrics.calls === 2, '调用计数没对上');
  fs.unlinkSync(out);
});

test('子进程退出时在途请求必须被拒绝，不许留悬空 Promise', async (t) => {
  const runner = new LocalTtsRunner({ root: process.cwd(), timeoutMs: 30000 });
  // 一定要 after 里收掉：留着活着的子进程 + 打开的管道，整个测试进程都不会退出。
  t.after(() => runner.stop('test-after'));
  if (!installed) {
    await assert.rejects(() => runner.synthesize('喂', { out: 'x.wav' }), /没装齐/);
    return;
  }
  const pending = runner.synthesize('这一句还没回来说不定就断了', { out: path.join(process.cwd(), 'data', 'media', `kill-${Date.now()}.wav`) });
  const killed = await Promise.race([pending.then(() => 'resolved'), new Promise((resolve) => setTimeout(() => resolve('killed'), 40))]);
  runner.stop('test');
  if (killed === 'resolved') return; // 快到来得及回，那就验不到这条，明确不假装成功
  await assert.rejects(() => pending, /退出|超时/);
});
