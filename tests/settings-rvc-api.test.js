import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/runtime.js';

test('RVC 独立变更返回同一设置快照和版本；过期写入不会覆盖它', async t => {
  const app = await startTestServer(t);
  const headers = { origin: app.base, 'x-bizhi-request': '1', 'content-type': 'application/json' };
  const before = await (await fetch(app.base + '/api/settings')).json();
  const selected = await fetch(app.base + '/api/voice/rvc/select', { method: 'POST', headers: { ...headers, 'If-Match': before.revision }, body: JSON.stringify({ enabled: false, transpose: 3 }) });
  assert.equal(selected.status, 200);
  const saved = await selected.json();
  assert.equal(saved.rvc.transpose, 3);
  assert.equal(saved.settings.tts.rvc.transpose, 3);
  assert.notEqual(saved.revision, before.revision);
  const stale = await fetch(app.base + '/api/settings', { method: 'PUT', headers: { ...headers, 'If-Match': before.revision }, body: JSON.stringify({ tts: before.settings.tts }) });
  assert.equal(stale.status, 409);
  const staleRvc = await fetch(app.base + '/api/voice/rvc/select', { method: 'POST', headers: { ...headers, 'If-Match': before.revision }, body: JSON.stringify({ transpose: 0 }) });
  assert.equal(staleRvc.status, 409);
  const next = await fetch(app.base + '/api/settings', { method: 'PUT', headers: { ...headers, 'If-Match': saved.revision }, body: JSON.stringify({ tts: { maxPerDay: 3 } }) });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).settings.tts.rvc.transpose, 3);
});
