import test from 'node:test';
import assert from 'node:assert/strict';
import { restartDecision, resumeGrace } from '../src/background-policy.js';

test('未知或仍存活的进程不强杀也不重复拉起，人工停止优先', () => {
  for (const probe of ['present', 'unknown']) assert.equal(restartDecision({ probe }).start, false);
  assert.equal(restartDecision({ probe: 'present', healthy: true }).state, 'running');
  assert.equal(restartDecision({ probe: 'absent', disabled: true }).state, 'stopped');
});

test('长时间暂停后先等网络恢复，期间不计重启次数，也不强杀仍在的进程', () => {
  const grace = resumeGrace(1000, 301000);
  assert.equal(grace.detected, true);
  assert.equal(grace.until, 331000);
  const waiting = restartDecision({ probe: 'absent', now: 301000, notBefore: grace.until, attempts: [300000] });
  assert.equal(waiting.state, 'resume_wait');
  assert.deepEqual(waiting.attempts, [300000]);
  assert.equal(restartDecision({ probe: 'present', healthy: true, now: 301000, notBefore: grace.until }).state, 'running');
  assert.equal(restartDecision({ probe: 'absent', now: 301000, notBefore: grace.until, disabled: true }).state, 'stopped');
  assert.equal(restartDecision({ probe: 'absent', now: 331000, notBefore: grace.until }).start, true);
  assert.equal(resumeGrace(301000, 316000, grace.until).until, grace.until);
  assert.equal(resumeGrace(0, 301000).detected, false);
});
test('退出重启有退避与十五分钟三次上限，窗口过期后可恢复', () => {
  let result = restartDecision({ probe: 'absent', now: 1000 });
  assert.equal(result.start, true);
  assert.equal(restartDecision({ probe: 'absent', attempts: result.attempts, now: 2000 }).state, 'backoff');
  result = restartDecision({ probe: 'absent', attempts: result.attempts, now: 16000 });
  result = restartDecision({ probe: 'absent', attempts: result.attempts, now: 46000 });
  assert.equal(result.start, true);
  assert.equal(restartDecision({ probe: 'absent', attempts: result.attempts, now: 100000 }).state, 'cooldown');
  assert.equal(restartDecision({ probe: 'absent', attempts: result.attempts, now: 1000000 }).start, true);
});
