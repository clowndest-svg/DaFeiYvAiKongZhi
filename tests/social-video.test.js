import test from 'node:test';
import assert from 'node:assert/strict';
import { videoCaption, renderSocialVideo, socialVideoTasks } from '../src/social-video.js';
import { addPost, closeDb, kvSetJson } from '../src/db.js';

test.after(closeDb);
test('口播字幕保留中文和特殊字符并限制行宽', () => {
  const text = '鲸鲸的一天%{测试}：今天学到了新东西。'.repeat(3);
  const caption = videoCaption(text);
  assert.equal(caption.replaceAll('\n', ''), text);
  assert.ok(caption.split('\n').every(line => Array.from(line).length <= 16));
});
test('制作前拦截未批准草稿和超长口播', async () => {
  const draft = addPost({ kind: 'douyin', content: '测试' });
  await assert.rejects(renderSocialVideo(draft.id), /先批准/);
  const long = addPost({ kind: 'douyin', status: 'approved', content: '鲸'.repeat(301) });
  await assert.rejects(renderSocialVideo(long.id), /300/);
});

test('重启前的运行任务转为中断，非法成片路径不对外提供', () => {
  kvSetJson('social:video-task:fixture', { id: 'fixture', postId: 1, runtime: 'old', state: 'running', file: '../private.mp4' });
  const task = socialVideoTasks().find(item => item.id === 'fixture');
  assert.equal(task.state, 'interrupted');
  assert.equal(task.file, null);
  assert.equal(socialVideoTasks().find(item => item.id === 'fixture').state, 'interrupted');
});
