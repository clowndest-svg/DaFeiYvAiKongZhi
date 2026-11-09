import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeek, pricingFor } from '../src/llm.js';
import { officialRate } from '../src/pricing.js';
import { chatThinking } from '../src/llm-policy.js';
import { addMessage, createSession, getDb, getMessage, costSummary, closeDb, kvSet } from '../src/db.js';
import { loadSettings, saveSettings } from '../src/config.js';
import { queueReflection, claimReflection, recoverReflections, finishReflection } from '../src/reflection-work.js';
import { reflect } from '../src/reflect.js';
import { reserveCost, settleCost, uncertainCost } from '../src/cost-reservations.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { getMood } from '../src/mood.js';

test.after(closeDb);
test.beforeEach(() => {
  getDb().exec("DELETE FROM reflection_work; DELETE FROM kv WHERE key LIKE 'reflect_attempt_at:%'");
});

test('非思考后台请求受限，聊天模式可按复杂度或显式偏好选择', () => {
  const llm = new DeepSeek({ apiKey: 'fixture' });
  const body = llm.buildBody([], { kind: 'reflect', maxTokens: 1100, reasoningEffort: 'low' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.max_tokens, 1100);
  assert.equal(chatThinking('在干嘛', { model: {} }), false);
  assert.equal(chatThinking('请逐步分析这个算法', { model: {} }), true);
  assert.equal(chatThinking('在干嘛', { model: { thinkingMode: 'enabled' } }), true);
  assert.equal(chatThinking('推导公式', { model: { thinkingMode: 'disabled' } }), false);
});

test('后台截断一次结算后停止，既不放大输出也不应用半截 JSON', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ model: 'deepseek-flash', choices: [{ message: { content: '{"memories":[' }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 20 } } }) };
  };
  try {
    const llm = new DeepSeek({ apiKey: 'fixture', baseUrl: 'http://fixture' });
    await assert.rejects(llm.chat([], { kind: 'reflect', requestId: 'bounded-task', maxTokens: 1000 }), { code: 'BACKGROUND_OUTPUT_LIMIT' });
    assert.equal(calls, 1);
    const cost = getDb().prepare("SELECT * FROM costs WHERE request_id='bounded-task'").all();
    assert.equal(cost.length, 1);
    assert.equal(cost[0].outcome, 'truncated');
    assert.equal(cost[0].reasoning_tokens, 20);
  } finally { globalThis.fetch = original; }
});

test('网络重试保留同一任务 ID，第二次请求显示重试且单次上限不变', async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) return { ok: false, status: 503, text: async () => 'busy' };
    return { ok: true, json: async () => ({ model: 'deepseek-flash', choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }) };
  };
  try {
    const llm = new DeepSeek({ apiKey: 'fixture', baseUrl: 'http://fixture' });
    await llm.chat([], { kind: 'compact', requestId: 'retry-task', maxTokens: 900 });
    assert.deepEqual(bodies.map(body => body.max_tokens), [900, 900]);
    const cost = getDb().prepare("SELECT * FROM costs WHERE request_id='retry-task'").get();
    assert.equal(cost.attempt, 2);
    const summary = costSummary().breakdown.find(row => row.feature === 'compact');
    assert.equal(summary.retries, 1);
    assert.equal(summary.attempts, 2);
    assert.equal(summary.tasks, 1);
    assert.equal(summary.uncertain, 1);
  } finally { globalThis.fetch = original; }
});

test('重复入队、冷却和崩溃恢复都保留来源，应用结果与完成标记原子提交', async () => {
  const session = createSession('持久整理');
  let last;
  for (let index = 0; index < 4; index += 1) {
    addMessage({ sessionId: session.id, role: 'user', content: `我第${index}件事是喜欢温水` });
    last = addMessage({ sessionId: session.id, role: 'assistant', content: '知道了' });
    queueReflection(session.id, last.id);
    queueReflection(session.id, last.id);
  }
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM reflection_work').get().n, 4);
  const settings = loadSettings();
  const batch = claimReflection(settings);
  assert.equal(batch.messages.length, 8);
  const llm = { chat: async () => ({ content: JSON.stringify({ inner_thought: '记住温水', memories: [{ content: '温水', evidence: '我第0件事是喜欢温水' }] }) }) };
  await assert.rejects(reflect({ llm, settings, sessionId: session.id, assistantMessageId: last.id, messages: batch.messages, batched: true,
    onApplied: () => { finishReflection(batch, 'done'); throw new Error('injected before commit'); } }), /injected/);
  assert.equal(getMessage(last.id).meta.innerThought, undefined);
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM reflection_work WHERE state='running'").get().n, 4);
  recoverReflections();
  const recovered = claimReflection(settings, Date.now() + 121000);
  assert.equal(recovered.rows.length, 4);
  await reflect({ llm, settings, sessionId: session.id, assistantMessageId: last.id, messages: recovered.messages, batched: true,
    onApplied: () => finishReflection(recovered, 'done') });
  assert.equal(getMessage(last.id).meta.innerThought, '记住温水');
  queueReflection(session.id, last.id);
  assert.equal(claimReflection(settings, Date.now() + 300000), null);
});

test('无新聊天也能在到期后整理，超长来源保持完整', () => {
  const session = createSession('稀疏聊天');
  const content = '很长的背景'.repeat(180) + '我的生日是3月14日';
  addMessage({ sessionId: session.id, role: 'user', content });
  const reply = addMessage({ sessionId: session.id, role: 'assistant', content: '记下了' });
  const now = Date.now();
  queueReflection(session.id, reply.id, now);
  assert.equal(claimReflection(loadSettings(), now + 119000), null);
  const batch = claimReflection(loadSettings(), now + 120001);
  assert.equal(batch.messages[0].content, content);
});

test('恢复补回回复已保存但入队前崩溃的消息，未确认的 QQ 回复继续隔离', () => {
  const session = createSession('入队边界');
  kvSet('reflection_work_baseline', '0');
  addMessage({ sessionId: session.id, role: 'user', content: '我生日是3月14日' });
  const missed = addMessage({ sessionId: session.id, role: 'assistant', content: '记得了', meta: { usage: { prompt: 10 }, qqDelivery: 'sent' } });
  const unknown = addMessage({ sessionId: session.id, role: 'assistant', content: '待确认', meta: { usage: { prompt: 10 }, qqDelivery: 'unknown' } });
  recoverReflections();
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM reflection_work WHERE message_id=?').get(missed.id).n, 1);
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM reflection_work WHERE message_id=?').get(unknown.id).n, 0);
});

test('固定规则前缀跨时间和心情保持一致，动态内容仍送入上下文', () => {
  const block = { core: [], long: [], mid: [], innerThoughts: [], summary: '', handover: '' };
  const settings = loadSettings();
  const a = buildSystemPrompt({ settings, block, mood: getMood(), now: new Date('2026-11-09T00:00:00Z') });
  const b = buildSystemPrompt({ settings, block, mood: getMood(), now: new Date('2026-11-09T01:00:00Z') });
  const split = '===== 你此刻带着的东西';
  assert.equal(a.split(split)[0], b.split(split)[0]);
  assert.notEqual(a, b);
});

test('官方模型峰谷价按 UTC+8 边界、周末和节假日选取，未知模型继续标记估算', () => {
  const peak = officialRate('deepseek-flash', '2026-11-09T01:00:00Z');
  const off = officialRate('deepseek-flash', '2026-11-09T04:00:00Z');
  assert.equal(peak.output, off.output * 2);
  assert.equal(officialRate('deepseek-flash', '2026-11-08T02:00:00Z').output, off.output);
  assert.equal(officialRate('deepseek-flash', '2026-10-01T02:00:00Z').output, off.output);
  assert.equal(officialRate('deepseek-v4-pro', '2026-11-09T02:00:00Z').output, 3.96);
  assert.equal(pricingFor('unknown', '').version, 'legacy-flash-estimate');
});

test('整理预算在模型调用前拦截，预算预留同时计入', () => {
  saveSettings({ model: { reflectMaxDailyCny: 0.1 } });
  reserveCost({ model: 'deepseek-flash', kind: 'reflect', estimate: 0.08 });
  assert.throws(() => reserveCost({ model: 'deepseek-flash', kind: 'reflect', estimate: 0.08 }), { code: 'REFLECTION_BUDGET' });
});

test('同一任务跨恢复继续递增请求序号，结算使用持久化序号和请求时刻', () => {
  const a = reserveCost({ model: 'fixture', kind: 'recovery_probe', requestId: 'recover-task' });
  uncertainCost(a);
  const b = reserveCost({ model: 'fixture', kind: 'recovery_probe', requestId: 'recover-task' });
  settleCost(b, { model: 'fixture', kind: 'recovery_probe', attempt: 1, createdAt: '2000-01-01T00:00:00.000Z' });
  const row = getDb().prepare("SELECT attempt,created_at FROM costs WHERE request_id='recover-task'").get();
  assert.equal(row.attempt, 2);
  assert.equal(row.created_at, '2000-01-01T00:00:00.000Z');
});

test('带子类型的调用在费用和请求明细中按同一主功能归类', () => {
  const id = reserveCost({ model: 'fixture', kind: 'post:fixture', requestId: 'post-subtype' });
  settleCost(id, { model: 'fixture', kind: 'post:fixture', promptTokens: 100 });
  const rows = costSummary().breakdown;
  const row = rows.find(item => item.feature === 'post');
  assert.equal(row.tasks, 1);
  assert.equal(row.attempts, 1);
  assert.equal(row.inputTokens, 100);
  assert.equal(rows.some(item => item.feature === 'post:fixture'), false);
});
