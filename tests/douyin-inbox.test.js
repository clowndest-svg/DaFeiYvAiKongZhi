import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDouyinComments, reserveDouyinReplyAttempt, resolveDouyinReply, clearDouyinReplyDraft, findDouyinReplyReceipt } from '../src/channels/douyin.js';
import { Scheduler, chooseDouyinMonitorVideo } from '../src/scheduler.js';
import { closeDb, kvGet, kvGetJson, kvSet, kvSetJson } from '../src/db.js';
import { beginEffect } from '../src/effects.js';

test.after(closeDb);

test('评论按 ID 去重并保留首次读取时间，无 ID 的内容不会伪造稳定身份', () => {
  const previous = [{ id: '123456', text: '旧内容', firstSeenAt: '2026-01-01', lastSeenAt: '2026-01-01' }];
  const result = mergeDouyinComments(previous, [{ id: '123456', text: '新内容' }, { id: '987654', text: '另一条' }, { id: '', text: '未识别' }], '2026-02-01');
  assert.equal(result.length, 2);
  assert.equal(result.find(item => item.id === '123456').firstSeenAt, '2026-01-01');
  assert.equal(result.find(item => item.id === '123456').text, '新内容');
});

test('关闭监控、维护中及退避期间不会启动浏览器', async () => {
  const scheduler = new Scheduler({ llm: {}, companion: {} });
  kvSetJson('douyin:monitor-enabled', false);
  assert.equal(await scheduler.pollDouyinComments(), null);
  kvSetJson('douyin:monitor-enabled', true);
  kvSetJson('qq_maintenance', true);
  assert.equal(await scheduler.pollDouyinComments(), null);
  kvSetJson('qq_maintenance', false);
  kvSet('douyin:monitor-next', String(Date.now() + 3600000));
  assert.equal(await scheduler.pollDouyinComments(), null);
  kvSetJson('douyin:monitor-enabled', false);
});

test('评论读取改变列表顺序后，轮询仍会覆盖每个视频', () => {
  let cursor = 0;
  const seen = [];
  for (const inbox of [
    [{ videoId: '33333' }, { videoId: '11111' }, { videoId: '22222' }],
    [{ videoId: '11111' }, { videoId: '33333' }, { videoId: '22222' }],
    [{ videoId: '22222' }, { videoId: '11111' }, { videoId: '33333' }],
  ]) {
    const selected = chooseDouyinMonitorVideo(inbox, cursor);
    seen.push(selected.videoId);
    cursor = selected.next;
  }
  assert.deepEqual(seen, ['11111', '22222', '33333']);
  assert.equal(chooseDouyinMonitorVideo([{ videoId: 'invalid' }], 0), null);
});

test('发送尝试、次数和草稿状态原子写入，重启后相同评论不重发', () => {
  const draft = { id: 'fixture', account: 'test-account', videoId: '123456', commentId: '654321', state: 'ready' };
  kvSetJson('douyin:reply-draft', draft);
  const effectKey = reserveDouyinReplyAttempt(draft, '2026-01-01');
  assert.equal(kvGet('douyin:reply-count:test-account:2026-01-01'), '1');
  assert.equal(kvGetJson('douyin:reply-draft').state, 'attempted');
  closeDb();
  assert.throws(() => beginEffect(effectKey), /未知/);
  assert.throws(() => reserveDouyinReplyAttempt(draft, '2026-01-01'), /未知/);
  assert.equal(kvGet('douyin:reply-count:test-account:2026-01-01'), '1');
  kvSet('douyin:reply-count:test-account:2026-01-01', '5');
  assert.throws(() => reserveDouyinReplyAttempt({ ...draft, commentId: '999999' }, '2026-01-01'), /上限|达到/);
  assert.equal(kvGetJson('effect:douyin:reply:test-account:123456:999999', null), null);
});

test('未知发送结果必须核对后才能清除，确认未发才允许重新尝试', async () => {
  const draft = { id: 'review-one', account: 'review-account', videoId: '123456', commentId: '777777', state: 'ready' };
  kvSetJson('douyin:reply-draft', draft);
  const key = reserveDouyinReplyAttempt(draft, '2026-01-02');
  await assert.rejects(clearDouyinReplyDraft(), /先到抖音核对/);
  await assert.rejects(resolveDouyinReply('stale-id', false), /已变化/);
  await resolveDouyinReply('review-one', false);
  assert.equal(kvGetJson('douyin:reply-draft').state, 'resolved_not_sent');
  assert.equal(beginEffect(key).started, true);

  const second = { ...draft, id: 'review-two', commentId: '888888' };
  kvSetJson('douyin:reply-draft', second);
  const secondKey = reserveDouyinReplyAttempt(second, '2026-01-02');
  await resolveDouyinReply('review-two', true);
  assert.equal(beginEffect(secondKey).receipt.manuallyVerified, true);
});

test('每小时回复次数有上限，拒绝时不会留下发送记录', () => {
  const draft = { id: 'hour-limit', account: 'hour-account', videoId: '123456', commentId: '123456', state: 'ready' };
  kvSet('douyin:reply-hour:hour-account:2026-01-01 12', '2');
  assert.throws(() => reserveDouyinReplyAttempt(draft, '2026-01-01', '2026-01-01 12'), /本小时/);
  assert.equal(kvGetJson('effect:douyin:reply:hour-account:123456:123456', null), null);
  assert.equal(kvGet('douyin:reply-count:hour-account:2026-01-01', '0'), '0');
});

test('回执必须是目标楼层中本账号新增的唯一回复', () => {
  const draft = { commentId: '111111', text: '你好' };
  const before = [{ id: '222222' }];
  const valid = { id: '333333', parentId: '111111', authorId: 'self-id', text: '自己\n你好' };
  assert.deepEqual(findDouyinReplyReceipt(before, [valid], draft, 'self-id'), { commentId: '333333' });
  assert.equal(findDouyinReplyReceipt([...before, valid], [valid], draft, 'self-id'), null);
  assert.equal(findDouyinReplyReceipt(before, [{ ...valid, authorId: 'other' }], draft, 'self-id'), null);
  assert.equal(findDouyinReplyReceipt(before, [{ ...valid, parentId: '999999' }], draft, 'self-id'), null);
  assert.equal(findDouyinReplyReceipt(before, [valid, { ...valid, id: '444444' }], draft, 'self-id'), null);
  assert.equal(findDouyinReplyReceipt(before, [valid], draft, ''), null);
});
