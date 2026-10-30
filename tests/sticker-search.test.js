import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-sticker-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;

const { parseBingImageHtml, adoptStickerImage, stickerLibraryStatus } = await import('../src/sticker-search.js');
const { kvSetJson, closeDb } = await import('../src/db.js');
const { listLearnedImages } = await import('../src/learned-images.js');

const fixture = [
  '<div class="iusc" m="{&quot;murl&quot;:&quot;https://img.example.com/a.png&quot;,&quot;t&quot;:&quot;x&quot;}">',
  '<div m="{&quot;murl&quot;:&quot;https://img.example.com/a.png&quot;}">',
  '<div m="{&quot;murl&quot;:&quot;https://cdn.example.net/cat%20face.jpg?pid=3&amp;h=1&quot;}">',
  '<div m="{&quot;murl&quot;:&quot;not-a-url&quot;}">',
].join('\n');

test('Bing 图片结果解析：去重、去掉跟踪参数、按上限截断', () => {
  const hits = parseBingImageHtml(fixture, { query: '猫', limit: 10 });
  assert.equal(hits.length, 2, '重复和坏链接要丢掉');
  assert.equal(hits[0].url, 'https://img.example.com/a.png');
  assert.match(hits[1].url, /^https:\/\/cdn\.example\.net\/cat%20face\.jpg$/);
  assert.ok(!hits[1].url.includes('pid='), '跟踪参数要清掉');
  assert.equal(parseBingImageHtml(fixture, { limit: 1 }).length, 1);
  assert.deepEqual(parseBingImageHtml('没有结果', { limit: 5 }), []);
});

test('她不能把内网地址当图片收进来', async () => {
  await assert.rejects(() => adoptStickerImage('http://127.0.0.1:7788/api/status'), /本机|内网|不允许/);
  await assert.rejects(() => adoptStickerImage('http://192.168.1.1/a.png'), /本机|内网|不允许/);
  await assert.rejects(() => adoptStickerImage('file:///C:/Windows/win.ini'), /协议不支持/);
});

test('每天收图有上限，收满就拒绝', async () => {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  kvSetJson('sticker_adopt_day', { day, count: 12 });
  await assert.rejects(() => adoptStickerImage('https://img.example.com/x.png'), /上限/);
  kvSetJson('sticker_adopt_day', { day, count: 0 });
  assert.deepEqual(stickerLibraryStatus(), { total: 0, adoptedToday: 0, dailyMax: 12 });
  assert.deepEqual(listLearnedImages(), []);
});

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
