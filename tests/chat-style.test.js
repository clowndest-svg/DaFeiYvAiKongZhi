import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { paths } from '../src/config.js';
import { buildChatPayload, buildPostPrompt } from '../src/prompt.js';

const settings = { companion: { name: '小知' }, memory: {} };
const mood = { label: '平静', valence: 0.2, energy: 0.5, affection: 30, reason: '' };
const block = { core: [], long: [], mid: [], summary: '', handover: '', innerThoughts: [] };
const history = [
  { role: 'user', content: '今天有点想你。' },
  { role: 'assistant', content: '我也想你。\n\n刚刚还在等你忙完。' },
  { role: 'user', content: '然后呢' },
];
const payloadFor = (channel, overrides = {}) => buildChatPayload({ settings, mood, block, history, channel, ...overrides });

test('主人私聊把短消息续聊与寒暄区分开', () => {
  for (const channel of ['web', 'qq']) {
    const payload = payloadFor(channel);
    assert.match(payload.system, /这是寒暄的默认节奏，不是所有短消息的字数限制/);
    assert.match(payload.system, /按上一轮的意思继续，别因为输入短就掐掉话题/);
    assert.equal(payload.messages.at(-1).content, '然后呢');
    assert.equal(payload.messages.at(-2).content, history[1].content);
  }
});

test('私聊要求接完整意思，不用悬念和害羞代替回应', () => {
  const { system } = payloadFor('web');
  assert.match(system, /先把这一层意思接完整/);
  assert.match(system, /不把边界包装成欲擒故纵/);
  assert.match(system, /停在最让人兴奋的地方/);
  assert.doesNotMatch(system, /允许半句话咽回去/);
  assert.match(system, /他明确说停、不舒服或换话题时马上尊重/);
  assert.match(system, /不写露骨性描写/);
});

test('自然私聊规则在人设被自定义后仍然进入请求', (t) => {
  const original = fs.readFileSync(paths.persona, 'utf8');
  t.after(() => fs.writeFileSync(paths.persona, original));
  fs.writeFileSync(paths.persona, '你叫小知，说话平静自然。\n');
  const { system } = payloadFor('qq');
  assert.match(system, /你叫小知，说话平静自然/);
  assert.match(system, /私聊里的亲近可以直白、从容/);
  assert.match(system, /按上一轮的意思继续/);
});

test('记忆压缩后仍保留续聊和明确边界', () => {
  const memories = Array.from({ length: 40 }, () => ({ content: '今天一起讨论了一个具体的话题。'.repeat(40) }));
  const { system } = payloadFor('web', {
    settings: { ...settings, memory: { maxPromptTokens: 3000 } },
    block: { ...block, core: memories, mid: memories, long: memories },
  });
  assert.match(system, /按上一轮的意思继续/);
  assert.match(system, /不把边界包装成欲擒故纵/);
});

test('私聊风格不扩散到群聊、访客与公开动态', () => {
  const privateOnly = /私聊的相处|私聊里的亲近可以直白|停在最让人兴奋的地方|成熟、从容的御姐口吻/;
  for (const channel of ['qq-group', 'qq-guest']) {
    const { system } = payloadFor(channel);
    assert.doesNotMatch(system, privateOnly);
    assert.match(system, /不把对方当恋人/);
  }
  for (const kind of ['qzone', 'xhs', 'douyin']) {
    assert.doesNotMatch(buildPostPrompt({ settings, mood, block, kind }), privateOnly);
  }
});
