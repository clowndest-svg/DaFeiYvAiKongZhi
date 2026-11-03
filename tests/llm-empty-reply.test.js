// 上游抽风时她为什么会哑：判据钉住"说清是谁的问题 + 自动重试一次 + 分类别甩锅"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-llm-empty-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_SETTINGS_FILE = path.join(dataDir, 'settings.json');

const { DeepSeek } = await import('../src/llm.js');
const { classifyReplyError } = await import('../src/channels/onebot.js');
const { closeDb } = await import('../src/db.js');

const okJson = (content, finish = 'stop', extra = {}) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content, reasoning_content: extra.reasoning || '' }, finish_reason: finish }],
    usage: { total_tokens: 30, completion_tokens_details: { reasoning_tokens: extra.reasoningTokens || 0 } },
    model: 'deepseek-flash',
  }),
});
const errText = (status, body = '{"error":{"message":"Service is too busy"}}') => ({ ok: false, status, text: async () => body });

async function withFetch(stub, run) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => { calls += 1; return stub(calls, ...args); };
  try {
    return { value: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

const llm = () => new DeepSeek({ apiKey: 'test-key', baseUrl: 'http://stub.local' });

test('上游 200 但正文空：说清是上游的问题，并自动重试一次', async () => {
  const { calls, value } = await withFetch(
    () => okJson('', 'length', { reasoningTokens: 1400 }),
    async () => {
      let error = null;
      await llm().chat([{ role: 'user', content: '在吗' }], { kind: 'chat', maxTokens: 100 }).catch((e) => { error = e; });
      return error;
    },
  );
  assert.ok(value, '空正文必须抛错，不能把空串当回复');
  assert.match(value.message, /模型没给出正文/);
  assert.match(value.message, /max_tokens|正文是空的/, '必须带上是哪种空法，别只写"没有产出有效回复"');
  assert.equal(calls, 2, '空正文是上游抽风的典型形状，要重试一次再报错');
});

test('重试真的能自愈：第一次空、第二次有正文就正常用', async () => {
  const { calls, value } = await withFetch(
    (n) => (n === 1 ? okJson('') : okJson('嗯，我在。')),
    () => llm().chat([{ role: 'user', content: '在吗' }], { kind: 'chat' }),
  );
  assert.equal(calls, 2);
  assert.equal(value.content, '嗯，我在。');
});

test('503 过载：重试一次后按 HTTP 状态报错，不再伪装成"空回复"', async () => {
  const { calls } = await withFetch(() => errText(503), async () => {
    let error = null;
    await llm().chat([{ role: 'user', content: '在吗' }], { kind: 'chat' }).catch((e) => { error = e; });
    return error;
  });
  assert.equal(calls, 2, '503 属于可重试状态');
  const err = await withFetch(() => errText(503), async () => {
    let e2 = null;
    await llm().chat([{ role: 'user', content: '在吗' }], { kind: 'chat' }).catch((e) => { e2 = e; });
    return e2;
  });
  assert.match(err.value.message, /HTTP 503/);
  assert.match(err.value.message, /Service is too busy/, '上游原话要留着，别只留状态码');
});

test('被 max_tokens 截断：下一轮自动加大预算，不是原样再撞一次', async () => {
  const bodies = [];
  const { calls } = await withFetch((n, url, init) => {
    bodies.push(JSON.parse(init.body));
    return okJson('', 'length');
  }, async () => {
    await llm().chat([{ role: 'user', content: '在吗' }], { kind: 'chat', maxTokens: 1000 }).catch(() => {});
    return null;
  });
  assert.equal(calls, 2);
  assert.ok(bodies[1].max_tokens > bodies[0].max_tokens, '第二次必须给更多预算，否则推理又把正文吃光了');
  assert.ok(bodies[1].max_tokens <= 4096, '别无限加，封顶 4096');
});

test('模型超时：说成中文超时、不白等第二轮', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  // 真实的 fetch 会听 signal；桩子也必须听，否则这个判据自己会永远挂着（刚踩过）。
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    calls += 1;
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  try {
    let error = null;
    await llm().chat([{ role: 'user', content: '在吗' }], { kind: 'chat', timeoutMs: 120 }).catch((e) => { error = e; });
    assert.ok(error, '超时必须抛错');
    assert.match(error.message, /模型响应超时/);
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(calls, 1, '同一轮已经中止的 signal 不可能重试成功，别浪费一次请求');
  } finally {
    globalThis.fetch = original;
  }
});

test('错误分类：模型那一步的问题不许甩给 QQ 账号', () => {
  assert.equal(classifyReplyError({ code: 'EMPTY_REPLY', message: '模型没给出正文' }), 'model');
  assert.equal(classifyReplyError({ code: 'HTTP', message: 'DeepSeek 返回 HTTP 503：Service is too busy' }), 'model');
  assert.equal(classifyReplyError({ code: 'NO_KEY', message: '还没有配置 DeepSeek API Key' }), 'model');
  assert.equal(classifyReplyError({ message: '请求超时' }), 'model');
  assert.equal(classifyReplyError({ code: 'TIMEOUT', message: '模型响应超时（60 秒没返回）' }), 'model');
  assert.equal(classifyReplyError({ message: 'The operation was aborted due to timeout' }), 'model');
  assert.equal(classifyReplyError({ message: 'NapCat 还没连上' }), 'channel');
  assert.equal(classifyReplyError({ code: 'DELIVERY_UNKNOWN', message: '发送结果不确定' }), 'channel');
});

test('界面按分类说人话：模型错误不许出现"关掉主号 QQ"这种指引', () => {
  const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /qq\.lastErrorKind === 'model'/, '界面必须读服务端的分类');
  assert.match(app, /模型那边没给出话/, '模型错误要有自己的说明');
  const modelBlock = app.slice(app.indexOf('模型那边没给出话'), app.indexOf('模型那边没给出话') + 260);
  assert.ok(!/主号|重新登录|扫码/.test(modelBlock), '模型错误里不许让人去重扫码');
  assert.match(app, /lastErrorKind/, '老记录没有分类时按文案兜底');
});

test('服务端把分类带进状态接口；成功后必须清掉', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'channels', 'onebot.js'), 'utf8');
  assert.match(src, /lastErrorKind: this\.lastErrorKind \|\| null/);
  assert.match(src, /this\.lastErrorKind = null;/, '成功发出之后还留着旧错误分类，界面会一直红');
  assert.match(src, /kind: this\.lastErrorKind/, '事件里也要记是哪一类，方便回看');
});

test.after(() => closeDb());
