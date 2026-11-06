import test from 'node:test';
import assert from 'node:assert/strict';
import { restartDecision } from '../src/background-policy.js';

test('未知或仍存活的进程不强杀也不重复拉起，人工停止优先', () => {
  for (const probe of ['present', 'unknown']) assert.equal(restartDecision({ probe }).start, false);
  assert.equal(restartDecision({ probe: 'present', healthy: true }).state, 'running');
  assert.equal(restartDecision({ probe: 'absent', disabled: true }).state, 'stopped');
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
