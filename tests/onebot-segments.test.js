import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMessage } from '../src/channels/onebot.js';

test('能区分 QQ 小黄脸和 QQ 表情包，并保留表情包数据', () => {
  const result = extractMessage({
    message: [
      { type: 'text', data: { text: '给你' } },
      { type: 'face', data: { id: '14' } },
      {
        type: 'mface',
        data: {
          emoji_id: '123456',
          emoji_package_id: '789',
          key: 'abc',
          summary: '[表情包]',
          url: 'https://example.com/a.gif',
        },
      },
    ],
  });
  assert.equal(result.text, '给你[表情][表情包]');
  assert.equal(result.faces.length, 1);
  assert.equal(result.faces[0].id, '14');
  assert.equal(result.mfaces.length, 1);
  assert.equal(result.mfaces[0].emoji_id, '123456');
  assert.equal(result.mfaces[0].emoji_package_id, '789');
  assert.equal(result.mfaces[0].key, 'abc');
});

test('图片消息仍然能被提取', () => {
  const result = extractMessage({
    message: [{ type: 'image', data: { url: 'https://example.com/a.jpg' } }],
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.text, '');
});
