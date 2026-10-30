import test from 'node:test';
import assert from 'node:assert/strict';
import { beginEffect, finishEffect, failEffect, DeliveryUnknownError } from '../src/effects.js';
import { closeDb } from '../src/db.js';

test.after(closeDb);
test('对外动作发送中及未知结果不重发，明确失败才可重试', () => {
  assert.equal(beginEffect('test-effect:one').started, true);
  assert.throws(() => beginEffect('test-effect:one'), /未知/);
  failEffect('test-effect:one', new DeliveryUnknownError('超时'));
  assert.throws(() => beginEffect('test-effect:one'), /未知/);
  assert.equal(beginEffect('test-effect:two').started, true);
  failEffect('test-effect:two', new Error('平台明确拒绝'));
  assert.equal(beginEffect('test-effect:two').started, true);
  finishEffect('test-effect:two', { id: 'receipt' });
  assert.deepEqual(beginEffect('test-effect:two'), { started: false, receipt: { id: 'receipt' } });
});
