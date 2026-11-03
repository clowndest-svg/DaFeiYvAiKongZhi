// QQ 发来的动图必须真能进模型输入——这条判据盯的是"图取到了却被白名单丢掉"那个 bug。
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, createSession, getActiveSession } from '../src/db.js';
import { Companion } from '../src/chat.js';

test.after(closeDb);

function imageParts(payload) {
  const last = payload.messages.at(-1);
  assert.equal(last.role, 'user', '最后一轮应当是他的话');
  if (!Array.isArray(last.content)) return [];
  return last.content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url);
}

test('gif 动图能进模型输入，svg 这类不支持的格式仍然挡在外面', () => {
  if (!getActiveSession()) createSession();
  const companion = new Companion({ llm: { configured: true } });
  const prep = companion.prepare({
    text: '',
    images: ['data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP/', 'data:image/svg+xml;base64,AAAA', 'data:image/webp;base64,AAAA'],
    channel: 'qq',
  });
  const urls = imageParts(prep.payload);
  assert.equal(urls.length, 2, `只该放行 gif 和 webp，实际 ${urls.length} 张：${urls.map((u) => u.slice(5, 15)).join(',')}`);
  assert.ok(urls.some((u) => u.startsWith('data:image/gif;')), 'gif 又被白名单丢掉了');
  assert.ok(!urls.some((u) => u.includes('svg')), '不支持的格式混进了模型输入');
});

test('一张图都没读到时，提示词要让她明说看不到，不许假装看见', () => {
  if (!getActiveSession()) createSession();
  const companion = new Companion({ llm: { configured: true } });
  const prep = companion.prepare({ text: '（他发来了 2 张图片，但我一张都没读到。别说你看见了，直接说图片没加载出来）', images: [], channel: 'qq' });
  const last = prep.payload.messages.at(-1);
  assert.match(typeof last.content === 'string' ? last.content : JSON.stringify(last.content), /一张都没读到/);
});
