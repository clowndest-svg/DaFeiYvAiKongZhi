import test from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../src/logger.js';

test('日志隐藏凭据但不破坏普通 JSON 分隔符', () => {
  const ordinary = JSON.stringify({ keys: 'p_skey,skey', via: 'test' });
  assert.equal(logger.redact(ordinary), ordinary);
  const secret = logger.redact(JSON.stringify({ password: 'secret', token: 'secret-token', p_skey: 'secret-cookie', note: 'safe' }));
  assert.deepEqual(JSON.parse(secret), { password: '***', token: '***', p_skey: '***', note: 'safe' });
  assert.equal(logger.redact('p_skey=abc; skey=def'), 'p_skey=***; skey=***');
});
