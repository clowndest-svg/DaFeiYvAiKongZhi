// RVC 二次变声的判据。全部离线：引擎路径指向临时假目录，Python 进程用替身，
// 这套判据里绝不真起 Python——真推理在控制台"试听"那条路上量，量完把数字写进说明。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadSettings, saveSettings } from '../src/config.js';
import { closeDb } from '../src/db.js';
import { findRvcModel, listRvcModels, rvcConvert, rvcEngineStatus, rvcPaths, rvcSelectProblem, rvcTimeoutMs } from '../src/rvc.js';
import { RvcRunner } from '../src/rvc-runner.js';
import { applyRvc } from '../src/tts.js';

test.after(closeDb);

// 造一个"看起来装了"的项目根：python、工人脚本、基座权重、清单和模型文件都齐。
function fakeRoot({ models = 1, dropPth = false, withIndex = true, base = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizhi-rvc-'));
  const p = rvcPaths(root);
  fs.mkdirSync(path.dirname(p.python), { recursive: true });
  fs.writeFileSync(p.python, 'fake');
  fs.mkdirSync(path.dirname(p.worker), { recursive: true });
  fs.writeFileSync(p.worker, 'fake');
  fs.writeFileSync(p.server, 'fake');
  if (base) {
    fs.mkdirSync(path.dirname(p.baseWeights), { recursive: true });
    fs.writeFileSync(p.baseWeights, 'fake');
  }
  fs.mkdirSync(p.modelDir, { recursive: true });
  const entries = [];
  for (let i = 1; i <= models; i += 1) {
    const id = `voice-${i}`;
    const dir = path.join(p.modelDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const pth = path.join(dir, `m${i}.pth`);
    fs.writeFileSync(pth, Buffer.alloc(2 * 1024 * 1024, 1));
    const idx = withIndex ? path.join(dir, `i${i}.index`) : '';
    if (idx) fs.writeFileSync(idx, Buffer.alloc(4096, 2));
    if (dropPth) fs.rmSync(pth);
    entries.push({
      id,
      repo: 'fake/repo',
      path: `m${i}.pth`,
      title: `女声 ${i}`,
      family: '女声',
      bytes: 2 * 1024 * 1024,
      pth: path.relative(root, pth).split(path.sep).join('/'),
      index: idx ? path.relative(root, idx).split(path.sep).join('/') : '',
      sample: '',
      ok: true,
    });
  }
  fs.writeFileSync(p.manifest, JSON.stringify({ entries }), 'utf8');
  const input = path.join(root, 'in.mp3');
  fs.writeFileSync(input, Buffer.alloc(4096, 3));
  return { root, p, input };
}

// 替身 Python 进程：按行收任务、按行回结果，并把收到的任务留下来给判据核对。
function fakeServer({ tasks = [], onConvert = null, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(text) {
      const task = JSON.parse(String(text).trim());
      tasks.push(task);
      if (hang) return;
      setImmediate(() => {
        if (task.cmd === 'load') {
          child.stdout.emit('data', Buffer.from(`${JSON.stringify({ ok: true, loaded: 'm1.pth', ms: 900 })}\n`));
          return;
        }
        if (task.cmd === 'convert') {
          if (onConvert) onConvert(task.dst);
          else fs.writeFileSync(task.dst, Buffer.alloc(4096, 8));
          child.stdout.emit('data', Buffer.from(`${JSON.stringify({ ok: true, bytes: 4096, ms: 1200 })}\n`));
          return;
        }
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ ok: true, pid: 1 })}\n`));
      });
    },
  };
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  child.exitCode = null;
  return child;
}

function runnerFor(root, options = {}) {
  const spawned = [];
  const runner = new RvcRunner({
    root,
    spawnImpl: () => {
      const child = fakeServer(options);
      spawned.push(child);
      return child;
    },
  });
  return { runner, spawned };
}

test('没装引擎：直接拒绝，一个进程都不起', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bizhi-rvc-empty-'));
  let called = 0;
  try {
    const engine = rvcEngineStatus(empty);
    assert.equal(engine.installed, false);
    assert.equal(engine.modelCount, 0);
    const out = await rvcConvert(path.join(empty, 'x.mp3'), 'voice-1', { root: empty, runner: { convert: async () => { called += 1; return { ok: true }; } } });
    assert.equal(out.ok, false);
    assert.equal(out.engineMissing, true);
    assert.match(out.reason, /没装变声引擎/);
    assert.equal(called, 0, '没装引擎还把活交给了变声进程');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('缺基座权重：同样拒绝，不许半路崩给上层', async () => {
  const { root, input } = fakeRoot({ base: false });
  let called = 0;
  try {
    const out = await rvcConvert(input, 'voice-1', { root, runner: { convert: async () => { called += 1; return { ok: true }; } } });
    assert.equal(out.ok, false);
    assert.match(out.reason, /基座权重/);
    assert.equal(called, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('清单里的模型文件被删了就不算可用，也不许拿去变声', async () => {
  const { root, p, input } = fakeRoot({ dropPth: true });
  let called = 0;
  try {
    const models = listRvcModels(root);
    assert.equal(models.length, 1);
    assert.equal(models[0].available, false, '文件不在还被当成可用');
    assert.equal(findRvcModel('voice-1', root), null);
    const out = await rvcConvert(input, 'voice-1', { root, runner: { convert: async () => { called += 1; return { ok: true }; } } });
    assert.equal(out.ok, false);
    assert.match(out.reason, /清单里没有这个音色/);
    assert.equal(called, 0);
    assert.ok(fs.existsSync(p.manifest));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('只认清单里的 id：路径穿越和空 id 都拒绝，绝不交给进程', async () => {
  const { root, input } = fakeRoot();
  const handed = [];
  try {
    for (const bad of ['../../windows/system32/cmd', '', '   ', 'voice-999']) {
      const out = await rvcConvert(input, bad, { root, runner: { convert: async (file, model) => { handed.push(model); return { ok: true }; } } });
      assert.equal(out.ok, false, `「${bad}」竟然通过了`);
    }
    assert.deepEqual(handed, [], '非法 id 还是被交给了变声进程');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('常驻工人：先 load 再 convert，参数按白名单和边界清洗，同模型第二条不再重载入', async () => {
  const { root, input } = fakeRoot();
  const tasks = [];
  try {
    const { runner, spawned } = runnerFor(root, { tasks });
    const outFile = path.join(root, 'out.wav');
    const first = await rvcConvert(input, 'voice-1', { root, runner, outFile, f0: 'rmvpe; rm -rf /', transpose: 999, indexRate: 5 });
    assert.equal(first.ok, true, `该成功却失败：${first.reason}`);
    assert.equal(spawned.length, 1, '一次转换起了多个进程');
    assert.equal(tasks[0].cmd, 'load');
    assert.match(tasks[0].model, /\.pth$/, 'load 没把模型路径交给工人');
    assert.ok(tasks[0].index, '清单里有 .index 却没带上');
    assert.equal(tasks[1].cmd, 'convert');
    assert.equal(tasks[1].f0, 'harvest', '非法 f0 没退回默认值');
    assert.equal(tasks[1].transpose, 24, '音高偏移没夹到 ±24');
    assert.equal(tasks[1].index_rate, 1, 'index_rate 没夹到 0~1');
    assert.equal(tasks[1].src, input);
    assert.equal(tasks[1].dst, outFile);
    assert.ok(!JSON.stringify(tasks).includes('rm -rf'), '注入串被原样传给了工人');

    // 第二条：模型没换，不该再付一次载入
    const second = await rvcConvert(input, 'voice-1', { root, runner, outFile: path.join(root, 'out2.wav') });
    assert.equal(second.ok, true);
    assert.equal(tasks.filter((t) => t.cmd === 'load').length, 1, '同一个模型被重复载入');
    assert.equal(tasks.filter((t) => t.cmd === 'convert').length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('换模型要重新载入：不能拿着上一个声音的模型继续转', async () => {
  const { root, input } = fakeRoot({ models: 2 });
  const tasks = [];
  try {
    const { runner } = runnerFor(root, { tasks });
    await rvcConvert(input, 'voice-1', { root, runner, outFile: path.join(root, 'a.wav') });
    await rvcConvert(input, 'voice-2', { root, runner, outFile: path.join(root, 'b.wav') });
    const loads = tasks.filter((t) => t.cmd === 'load');
    assert.equal(loads.length, 2, '换了模型却没重新载入，第二条其实还是上一个声音');
    assert.notEqual(loads[0].model, loads[1].model);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('工人说失败就失败；说成功但磁盘没文件也不算成功', async () => {
  const { root, input } = fakeRoot();
  try {
    const lying = await rvcConvert(input, 'voice-1', {
      root,
      runner: { convert: async () => ({ ok: true, file: path.join(root, 'ghost.wav'), bytes: 9999, ms: 10 }) },
    });
    assert.equal(lying.ok, false, '上层报了成功但文件不存在');

    const noSound = await rvcConvert(input, 'voice-1', {
      root,
      runner: { convert: async () => ({ ok: false, reason: 'ValueError: 模型文件读不了' }) },
    });
    assert.equal(noSound.ok, false);
    assert.match(noSound.reason, /模型文件读不了/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('工人真的写不出文件时，runner 自己也要判失败', async () => {
  const { root, input } = fakeRoot();
  try {
    const { runner } = runnerFor(root, { onConvert: () => {} });
    const out = await runner.convert(input, findRvcModel('voice-1', root), { outFile: path.join(root, 'never.wav'), transpose: 0, indexRate: 0.5, protect: 0.33, f0: 'harvest' });
    assert.equal(out.ok, false, '工人说 ok 但没落盘，runner 还当成功');
    assert.match(out.reason, /磁盘上没有文件/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('超时只杀自己起的那个进程', async () => {
  const { root } = fakeRoot();
  try {
    const { runner, spawned } = runnerFor(root, { hang: true });
    const out = await runner.ask({ cmd: 'status' }, 200);
    assert.equal(out.ok, false);
    assert.match(out.error, /没出来/);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].kills, ['SIGKILL'], '超时没杀进程，或者杀错了对象');
    assert.equal(runner.alive, false, '超时后进程状态还说活着');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('超时的下限与上限都夹住：别让设置里一个 0 把变声秒砍', () => {
  assert.equal(rvcTimeoutMs(0), 180000, '清空/填 0 应当回到默认，而不是砍到下限');
  assert.equal(rvcTimeoutMs(-5), 180000);
  assert.equal(rvcTimeoutMs('abc'), 180000);
  assert.equal(rvcTimeoutMs(1000), 15000, '填了个真数字但要抬到下限');
  assert.equal(rvcTimeoutMs(60000), 60000);
  assert.equal(rvcTimeoutMs(9999999), 600000);
});

test('接线：开关关着完全不碰变声；开着就换文件；变声失败必须发原声并留下原因', async () => {
  const base = { file: 'data/base.mp3', bytes: 100, mime: 'audio/mpeg', engine: 'edge', voice: 'x' };
  withRvc({ enabled: false, model: 'voice-1' });
  let called = 0;
  const off = await applyRvc(base, { convert: async () => { called += 1; return { ok: true }; } });
  assert.equal(called, 0, '开关是关的，还是去调了变声');
  assert.equal(off.engine, 'edge');
  assert.equal(off.rvc, undefined);

  withRvc({ enabled: true, model: 'voice-1' });
  const keep1 = path.join(os.tmpdir(), 'keep-me.mp3');
  fs.writeFileSync(keep1, Buffer.alloc(512, 4));
  const ok = await applyRvc({ ...base, file: keep1 }, {
    convert: async () => {
      fs.writeFileSync(path.join(os.tmpdir(), 'keep-me-rvc.wav'), Buffer.alloc(2048, 7));
      return { ok: true, file: path.join(os.tmpdir(), 'keep-me-rvc.wav'), bytes: 2048, model: 'voice-1', title: '女声 1', ms: 1234 };
    },
  });
  assert.equal(ok.engine, 'edge+rvc', '变声成功却没标出来，界面就无从核对');
  assert.equal(ok.mime, 'audio/wav');
  assert.equal(ok.rvc.ok, true);
  assert.ok(!fs.existsSync(keep1), '变声成功后原音频还留着，等于把同一句话存两份');
  fs.rmSync(path.join(os.tmpdir(), 'keep-me-rvc.wav'), { force: true });

  const keep2 = path.join(os.tmpdir(), 'keep-me2.mp3');
  fs.writeFileSync(keep2, Buffer.alloc(512, 5));
  const bad = await applyRvc({ ...base, file: keep2 }, { convert: async () => ({ ok: false, reason: '没装变声引擎' }) });
  assert.equal(bad.engine, 'edge', '变声失败却把 engine 改了');
  assert.ok(fs.existsSync(keep2), '变声失败时原声被删了——那条语音就没了');
  assert.equal(bad.rvc.ok, false);
  assert.match(bad.rvc.reason, /没装变声引擎/, '失败原因没如实带出去');
  fs.rmSync(keep2, { force: true });
});

// 只改 rvc 这一段，别把 tts 里其它设置写没了
function withRvc(rvc) {
  saveSettings({ tts: { ...loadSettings().tts, rvc } });
}

test('开关报的错要指着真正缺的那一步：没挑音色不能推给清单', () => {
  const engine = { installed: true, baseWeights: true, installHint: 'node tools/install-rvc-env.mjs' };
  // 他点的是开关，缺的是"还没挑音色"——这句必须说清下一步点哪，不能写成清单坏了。
  assert.match(rvcSelectProblem({ engine, modelId: '', chosen: null }), /还没挑音色/);
  assert.match(rvcSelectProblem({ engine, modelId: '  ', chosen: null }), /用这个声音/);
  assert.ok(!/清单/.test(rvcSelectProblem({ engine, modelId: '', chosen: null })), '没挑音色却怪清单');
  // 真挑了一个但文件不在了，才说清单/文件
  assert.match(rvcSelectProblem({ engine, modelId: 'voice-9', chosen: null }), /不在清单里或文件不在/);
  assert.match(rvcSelectProblem({ engine: { ...engine, installed: false }, modelId: 'voice-1', chosen: {} }), /还没装变声引擎/);
  assert.match(rvcSelectProblem({ engine: { ...engine, baseWeights: false }, modelId: 'voice-1', chosen: {} }), /基座权重/);
  assert.equal(rvcSelectProblem({ engine, modelId: 'voice-1', chosen: { id: 'voice-1' } }), '', '该放行时还拦着');
});

test('界面：没挑音色时点开关不该把 400 抛给用户', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'web', 'app.js'), 'utf8').replace(/\r/g, '');
  assert.match(app, /先在下面挑一个音色/, '开关那条路没给人下一步');
  const hint = app.indexOf('先在下面挑一个音色');
  const sent = app.indexOf("api('/api/voice/rvc/select'");
  assert.ok(hint > 0 && sent > hint, '提示应当出现在发请求之前');
  assert.ok(app.slice(hint, sent).includes('return;'), '没挑音色时没提前返回，还是会把请求发出去');
});
