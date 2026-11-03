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
  // 关键：表情商城的动画表情也要把图取到，否则她只会说"我这边空白一片"
  assert.deepEqual(result.images, ['https://example.com/a.gif'], 'mface 的图没被取到');
});

test('表情包有真名字时带上名字，QQ 那种字面"[表情包]"不算名字', () => {
  const named = extractMessage({
    message: [{ type: 'mface', data: { summary: '撅管理员', url: 'https://example.com/b.gif' } }],
  });
  assert.equal(named.text, '[表情包：撅管理员]');
  assert.deepEqual(named.images, ['https://example.com/b.gif']);

  for (const junk of ['[表情包]', '【动画表情】', '表情', '  ', '']) {
    const plain = extractMessage({ message: [{ type: 'mface', data: { summary: junk } }] });
    assert.equal(plain.text, '[表情包]', `占位 summary「${junk}」被当成名字了`);
  }
});

test('mface 没有直链时不编造图片，只留文字说明', () => {
  const result = extractMessage({ message: [{ type: 'mface', data: { emoji_id: '1', summary: '[表情包]' } }] });
  assert.deepEqual(result.images, [], '没有 url 却凭空造出图片地址');
  assert.equal(result.text, '[表情包]');
});

test('图片消息仍然能被提取', () => {
  const result = extractMessage({
    message: [{ type: 'image', data: { url: 'https://example.com/a.jpg' } }],
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.text, '');
});
