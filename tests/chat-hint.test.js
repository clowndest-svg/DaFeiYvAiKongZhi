import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStickerHint } from '../src/chat.js';
import { buildChatPayload } from '../src/prompt.js';

test('回复里的表情标记会被剥离成 hint', () => {
  const parsed = parseStickerHint('喏，就这个。[[sticker:shy]]');
  assert.equal(parsed.text, '喏，就这个。');
  assert.equal(parsed.hint, 'shy');
  assert.deepEqual(parseStickerHint('没有表情'), { text: '没有表情', hint: null, voice: false });
});

test('只有 QQ 通道的 system prompt 才教她使用表情标记', () => {
  const settings = { companion: { name: '小知' }, memory: {} };
  const mood = { label: '平静', valence: 0, energy: 0.5, affection: 20, reason: '' };
  const block = { core: [], long: [], mid: [], summary: '', handover: '', innerThoughts: [] };
  const base = { settings, mood, block, history: [{ role: 'user', content: '在吗', meta: {} }], maxContextTokens: 100000 };
  const qq = buildChatPayload({ ...base, channel: 'qq' });
  const web = buildChatPayload({ ...base, channel: 'web' });
  assert.match(qq.messages[0].content, /\[\[sticker:happy\]\]/);
  assert.doesNotMatch(web.messages[0].content, /\[\[sticker:happy\]\]/);
});

test('群聊 prompt 会加上场景约束和表情标记', () => {
  const settings = { companion: { name: '小知' }, memory: {} };
  const mood = { label: '平静', valence: 0, energy: 0.5, affection: 20, reason: '' };
  const block = { core: [], long: [], mid: [], summary: '', handover: '', innerThoughts: [] };
  const payload = buildChatPayload({
    settings,
    mood,
    block,
    history: [{ role: 'user', content: '大家好', meta: {} }],
    maxContextTokens: 100000,
    channel: 'qq-group',
  });
  assert.match(payload.messages[0].content, /QQ 群里/);
  assert.match(payload.messages[0].content, /私人信息/);
  assert.match(payload.messages[0].content, /\[\[sticker:happy\]\]/);
});
