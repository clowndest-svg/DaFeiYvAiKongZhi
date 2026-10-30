import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSettings } from '../src/config.js';
import { closeDb, kvSet, kvSetJson } from '../src/db.js';
import { saveQzoneCookie, getQzoneCookie, clearQzoneCookie, getQzoneFeedCache } from '../src/channels/qzone.js';

test.after(closeDb);
test('错误账号 Cookie 不覆盖原来的机器人登录态', () => {
  saveSettings({ qq: { botAccount: '10000001' } });
  kvSet('qq_owner_id', '10000002');
  saveQzoneCookie('uin=o10000001; p_skey=correct');
  assert.throws(() => saveQzoneCookie('uin=o10000002; p_skey=wrong'), /主人|机器人/);
  assert.equal(getQzoneCookie().uin, '10000001');
  assert.equal(getQzoneCookie().pSkey, 'correct');
  kvSetJson('qzone_feed', { uin: '10000001', posts: [{ tid: 'old' }] });
  clearQzoneCookie();
  assert.equal(getQzoneFeedCache(), null);
});
