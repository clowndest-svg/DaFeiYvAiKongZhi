import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(process.cwd(), 'data', `test-learned-images-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;

const db = await import('../src/db.js');
const learned = await import('../src/learned-images.js');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n2cAAAAASUVORK5CYII=';

test('图片表情会存到本地、去重，并能读出来', () => {
  const record = learned.learnImage(`data:image/png;base64,${PNG_1X1}`);
  assert.ok(record.file.endsWith('.png'));
  assert.equal(learned.listLearnedImages().length, 1);
  const same = learned.learnImage(`data:image/png;base64,${PNG_1X1}`);
  assert.equal(same.hash, record.hash);
  assert.equal(learned.listLearnedImages().length, 1);
  const full = path.join(dataDir, 'stickers-learned', record.file);
  assert.ok(fs.existsSync(full));
  const b64 = learned.getLearnedImageBase64(record);
  assert.ok(b64.length > 50);
});

test('只接受图片 data URL，乱字符串会被拒绝', () => {
  assert.throws(() => learned.learnImage('not-an-image'), /图片格式/);
});

test('清空后文件和索引都消失', () => {
  assert.equal(learned.clearLearnedImages(), 0);
  assert.equal(learned.listLearnedImages().length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'stickers-learned')) ? fs.readdirSync(path.join(dataDir, 'stickers-learned')).length : 0, 0);
});

test.after(() => {
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
