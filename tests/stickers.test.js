import test from 'node:test';
import assert from 'node:assert/strict';
import { getStickerBase64, pickSticker, stickerNames } from '../src/stickers.js';

test('五张角色表情包都在，能编码成 base64', () => {
  assert.equal(stickerNames().length, 5);
  for (const name of stickerNames()) {
    const data = getStickerBase64(name);
    assert.ok(data && data.length > 1000, `${name} 表情包为空`);
  }
});

test('明确索要表情包时会挑一张', () => {
  const name = pickSticker({
    text: '发个表情包看看',
    reply: '喏，就这个。',
    settings: { qq: { sendStickers: true, stickerChance: 0 } },
    mood: { affection: 20 },
  });
  assert.ok(stickerNames().includes(name));
});

test('关掉表情包开关就一张都不发', () => {
  const name = pickSticker({
    text: '发个表情包',
    reply: '好呀',
    settings: { qq: { sendStickers: false, stickerChance: 1 } },
    mood: { affection: 20 },
  });
  assert.equal(name, null);
});

test('普通聊天且概率为 0 时不会乱发表情包', () => {
  const name = pickSticker({
    text: '今天吃什么',
    reply: '随便，我都行。',
    settings: { qq: { sendStickers: true, stickerChance: 0 } },
    mood: { affection: 20 },
  });
  assert.equal(name, null);
});
