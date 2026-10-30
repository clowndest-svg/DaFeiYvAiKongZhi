import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deepMerge,
  estimateTokens,
  keywordSet,
  overlapScore,
  parseJsonLoose,
  parseClock,
  splitForQQ,
} from '../src/util.js';
import { buildChatPayload, buildPostPrompt } from '../src/prompt.js';

test('中文 token 估算不是 0，也不是按字符一比一', () => {
  const n = estimateTokens('今天有点累，想跟你说说话。');
  assert.ok(n >= 8 && n <= 30, `unexpected tokens: ${n}`);
  assert.equal(estimateTokens(''), 0);
});

test('长消息分条不会丢内容、每一条都不太长', () => {
  const text = '第一句。第二句！第三句？第四句。第五句。第六句。'.repeat(20);
  const chunks = splitForQQ(text, 80);
  assert.ok(chunks.length >= 1 && chunks.length <= 12);
  assert.ok(chunks.every((chunk) => chunk.length <= 80));
  assert.equal(chunks.join(''), text);
});

test('JSON 粘连代码块也能解析', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"ok":true,"n":2}\n```'), { ok: true, n: 2 });
  assert.deepEqual(parseJsonLoose('前面废话 {"a":"b"} 后面废话'), { a: 'b' });
});

test('关键词重合能把相似记忆找出来', () => {
  const query = keywordSet('他喜欢吃草莓蛋糕');
  const score = overlapScore(query, '他最喜欢草莓');
  assert.ok(score > 0.3, `score=${score}`);
});

test('数组会被整体覆盖，而不是按下标深合并', () => {
  const merged = deepMerge({ a: [1, 2], b: { c: 1 } }, { a: [3], b: { d: 2 } });
  assert.deepEqual(merged.a, [3]);
  assert.deepEqual(merged.b, { c: 1, d: 2 });
});

test('时间窗口解析', () => {
  assert.equal(parseClock('08:30', 0), 8.5);
  assert.equal(parseClock('bad', 9), 9);
});

test('拼出的 system prompt 包含人设、核心记忆与边界', () => {
  const settings = {
    companion: { name: '小知', userName: '', nickname: '笨蛋', intro: '' },
    memory: {},
  };
  const mood = { label: '平静', valence: 0.1, energy: 0.5, affection: 20, reason: '' };
  const block = {
    core: [{ content: '他生日是 3 月 14 日' }],
    long: [],
    mid: [{ content: '他累的时候先想找我说话' }],
    summary: '',
    handover: '',
    innerThoughts: [],
  };
  const history = [
    { role: 'user', content: '在吗', meta: {} },
    { role: 'assistant', content: '在呢', meta: {} },
    { role: 'user', content: '看看这个', meta: { hasImage: true } },
  ];
  const payload = buildChatPayload({
    settings,
    mood,
    block,
    history,
    images: ['data:image/png;base64,AAAA'],
    maxContextTokens: 100000,
  });
  assert.equal(payload.messages[0].role, 'system');
  assert.match(payload.messages[0].content, /小知/);
  assert.match(payload.messages[0].content, /3 月 14 日/);
  assert.ok(payload.estimatedTokens > 0);
  const last = payload.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.ok(Array.isArray(last.content));
  assert.equal(last.content[0].type, 'text');
  assert.equal(last.content[1].type, 'image_url');
});

test('动态 prompt 要求 JSON 且包含隐私边界', () => {
  const prompt = buildPostPrompt({
    settings: { companion: { name: '小知' } },
    mood: { label: '平静', valence: 0, energy: 0.5, affection: 10, reason: '' },
    block: { mid: [] },
    kind: 'xhs',
  });
  assert.match(prompt, /JSON/);
  assert.match(prompt, /不要写真实姓名/);
});
