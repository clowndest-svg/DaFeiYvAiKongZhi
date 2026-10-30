import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/runtime.js';

test('对象原型上的名字不能冒充控制台登录会话', async (t) => {
  const app = await startTestServer(t, { password: 'test-password' });
  for (const name of ['constructor', 'toString', '__proto__']) {
    const response = await fetch(`${app.base}/api/status`, { headers: { Cookie: `bz_session=${name}` } });
    assert.equal(response.status, 401, name);
  }
});
