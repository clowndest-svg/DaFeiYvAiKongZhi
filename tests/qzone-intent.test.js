import test from 'node:test';
import assert from 'node:assert/strict';
import { isQzonePostIntent } from '../src/channels/onebot.js';

test('能区分“问能不能发”和“让她真的发”', () => {
  assert.equal(isQzonePostIntent('你能发qq说说吗'), false);
  assert.equal(isQzonePostIntent('帮我发个说说'), true);
  assert.equal(isQzonePostIntent('你想发一下我看看哈哈'), false);
  assert.equal(isQzonePostIntent('发一下我看看', { previousText: '刚才说的是 QQ 空间说说' }), true);
  assert.equal(isQzonePostIntent('发空间'), true);
  assert.equal(isQzonePostIntent('今天吃什么'), false);
});
