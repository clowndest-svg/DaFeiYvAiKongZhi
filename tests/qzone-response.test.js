import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
let mode = 'empty';
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (mode === 'empty') res.end(JSON.stringify({ code: 0, msglist: [] }));
  else if (req.url.includes('msglist')) res.end(JSON.stringify({ code: -1 }));
  else res.end('<html><body>' + 'Unknown error page '.repeat(30) + '</body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.QZONE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const { saveSettings } = await import('../src/config.js');
const { closeDb, kvSetJson } = await import('../src/db.js');
const qz = await import('../src/channels/qzone.js');
saveSettings({ qq: { botAccount: '10000001' } });
qz.saveQzoneCookie('uin=o10000001; p_skey=test');
test.after(async () => { closeDb(); await new Promise((resolve) => server.close(resolve)); });

test('明确空列表是成功，长错误页面不能被当作空动态覆盖缓存', async () => {
  assert.equal((await qz.refreshQzoneFeed()).posts.length, 0);
  kvSetJson('qzone_feed', { uin: '10000001', posts: [{ tid: 'retained' }] });
  mode = 'bad';
  await assert.rejects(() => qz.refreshQzoneFeed(), /响应|读取|识别/);
  assert.equal(qz.getQzoneFeedCache().posts[0].tid, 'retained');
});
