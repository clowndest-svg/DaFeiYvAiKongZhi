import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../src/config.js';
import { backgroundStatus } from '../src/background-status.js';

test('后台状态不把旧文件当在线，停止标记优先且不泄露原始错误信息', () => {
  fs.writeFileSync(path.join(paths.data, 'background-lifecycle.json'), JSON.stringify({ installed: true, logon: true, unlock: true, resume: true, periodicMinutes: 5 }));
  fs.writeFileSync(path.join(paths.data, 'background-state.json'), JSON.stringify({ at: new Date(Date.now() - 120000).toISOString(), app: { state: 'running' }, qqError: 'private diagnostic' }));
  const stale = backgroundStatus();
  assert.equal(stale.fresh, false); assert.equal(stale.loginRequired, true);
  assert.equal(JSON.stringify(stale).includes('private diagnostic'), false);
  fs.writeFileSync(path.join(paths.data, 'background.disabled'), '');
  assert.equal(backgroundStatus().enabled, false);
});
