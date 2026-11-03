// 「评论和@」页签的读取判据：解析必须吃真实页面的文本形状，闸门不许被绕过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const { parseMentionItem } = await import('../src/channels/xhs.js');

test('解析：粉丝评论、作者回复、陌生形状，都按真实页面文本', () => {
  const a = parseMentionItem('小丸纸（关必回） 你的粉丝 评论了你的笔记11分钟前 交友[打招呼]求回 回复');
  assert.equal(a.author, '小丸纸（关必回）');
  assert.equal(a.relation, '你的粉丝');
  assert.equal(a.action, '评论了你的笔记');
  assert.equal(a.time, '11分钟前');
  assert.equal(a.text, '交友[打招呼]求回');
  assert.equal(a.ok, true);

  const b = parseMentionItem('像素纤维球 作者 回复了你的评论2天前 谢谢喜欢[亲一个R][亲一个R] 迷你版也太可爱了吧 回复');
  assert.equal(b.author, '像素纤维球');
  assert.equal(b.action, '回复了你的评论');
  assert.equal(b.time, '2天前');
  assert.match(b.text, /谢谢喜欢/);

  const c = parseMentionItem('完全不是通知的句子');
  assert.equal(c.ok, false, '解析不出来就整条保留、老实标 ok:false，不许硬拆');
});

test('闸门：提及只负责让她看见，回复仍走她自己笔记评论那条链', () => {
  const xhs = fs.readFileSync(path.join(ROOT, 'src', 'channels', 'xhs.js'), 'utf8');
  assert.match(xhs, /addEvent\('xhs_mention'/);
  assert.match(xhs, /recordXhsActivity/);
  assert.ok(!/sendXhsComment|xhs_comment_reply/.test(xhs.split('parseMentionItem')[1] || ''), '提及读取器里不许出现直接回复的动作');
  const scheduler = fs.readFileSync(path.join(ROOT, 'src', 'scheduler.js'), 'utf8');
  assert.match(scheduler, /readXhsMentions/, '轮询里必须真的读「评论和@」');
});

test('克隆音色：配了就先试、失败软回退、没配就当没有', () => {
  const tts = fs.readFileSync(path.join(ROOT, 'src', 'tts.js'), 'utf8');
  assert.match(tts, /cloneSynthesize/);
  assert.match(tts, /cloneUrl/);
  assert.match(tts, /克隆音色不通，退回在线音色/, '克隆挂掉绝不能让她不说话');
  assert.match(tts, /loadSettings\(\)\.tts/);
});
