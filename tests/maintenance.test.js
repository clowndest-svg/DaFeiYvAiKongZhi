import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', `test-maintenance-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_NO_BACKUP = '1';
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ qq: { enabled: false } }), 'utf8');
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { addEvent, closeDb, kvGet, kvSet, listEvents, maintenance } = await import('../src/db.js');

const DAY = 86400000;
const HOUR = 3600000;

function age(file, ms) {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(file, t, t);
}

test('语音/截图产物按期限清掉，没到期的留着', () => {
  const media = path.join(dataDir, 'media');
  fs.mkdirSync(media, { recursive: true });
  const blob = Buffer.alloc(4096, 1);
  const oldVoice = path.join(media, 'voice-old.mp3');
  const newVoice = path.join(media, 'voice-new.mp3');
  const oldShot = path.join(media, 'xhs-shot-old.png');
  const newShot = path.join(media, 'xhs-shot-new.png');
  const other = path.join(media, 'note-keep.png');
  for (const file of [oldVoice, newVoice, oldShot, newShot, other]) fs.writeFileSync(file, blob);
  age(oldVoice, 7 * HOUR);
  age(oldShot, 8 * DAY);
  age(other, 400 * DAY);

  const removed = maintenance();
  assert.equal(fs.existsSync(oldVoice), false, '超过 6 小时的语音该删');
  assert.equal(fs.existsSync(oldShot), false, '超过 7 天的截图该删');
  assert.equal(fs.existsSync(newVoice), true, '没到期的语音别删');
  assert.equal(fs.existsSync(newShot), true, '没到期的截图别删');
  assert.equal(fs.existsSync(other), true, '不在名单里的文件别乱删');
  assert.ok(removed.media >= 2, JSON.stringify(removed));
  assert.ok(removed.mediaBytes >= 8192, JSON.stringify(removed));
});

test('日键清理要覆盖语音/做梦/小红书这些新前缀，旧的清掉新的留着', () => {
  const old = '2026-01-01';
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  for (const key of [`voice_day:${old}`, `heard_day:${old}`, `dream_done:${old}`, `xhs_publish_day:${old}`, `xhs_comment_day:${old}`]) {
    kvSet(key, '3');
  }
  kvSet(`voice_day:${today}`, '1');
  kvSet(`dream_done:${today}`, '1');
  kvSet('last_dream', 'keep me');

  maintenance();
  assert.equal(kvGet('voice_day:' + old, ''), '', '语音额度日键要能清');
  assert.equal(kvGet('heard_day:' + old, ''), '', '听懂计数日键要能清');
  assert.equal(kvGet('dream_done:' + old, ''), '', '做梦完成标记要能清');
  assert.equal(kvGet('xhs_publish_day:' + old, ''), '', '发笔记日计数要能清');
  assert.equal(kvGet('xhs_comment_day:' + old, ''), '', '评论日计数要能清');
  assert.equal(kvGet(`voice_day:${today}`, ''), '1', '今天的不能清');
  assert.equal(kvGet('last_dream', ''), 'keep me', '非日键不能碰');
});

test('maintenance 不会把事件流一起清掉（90 天内还在）', () => {
  addEvent('audit_probe', '这条是刚写的', { ok: true });
  maintenance();
  assert.ok(listEvents(50).some((e) => e.type === 'audit_probe'), '新事件必须留着');
});

test.after(() => {
  try {
    closeDb();
  } catch {
    // 已关闭
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
