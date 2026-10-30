import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/runtime.js';

 test('隔离实例使用动态端口，停用 QQ 不控制真实进程', async (t) => {
  const app = await startTestServer(t, { settings: { qq: { enabled: true } } });
  assert.ok(app.port > 0 && app.port !== 7788);
  const stopped = await fetch(`${app.base}/api/qq/stop`, { method: 'POST' });
  assert.equal(stopped.status, 200);
  const result = await stopped.json();
  assert.equal(result.simulated, true);
  assert.equal(result.exited, false);
  const status = await (await fetch(`${app.base}/api/status`)).json();
  assert.equal(status.scheduler.running, false);
  assert.match(status.qq.wsUrl, new RegExp(`:${app.port}/onebot$`));
});
