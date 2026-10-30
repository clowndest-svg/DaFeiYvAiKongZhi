import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let calls = 0;
let unknown = false;
const server = http.createServer((_req, res) => {
  calls += 1;
  setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(unknown ? {} : { code: 0, tid: 'test-post-id' })); }, 20);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.QZONE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const { saveSettings } = await import('../src/config.js');
const { addPost, closeDb, getPost, kvSet } = await import('../src/db.js');
const { saveQzoneCookie } = await import('../src/channels/qzone.js');
const { approvePost, tryAutoPublish } = await import('../src/social.js');
saveSettings({ qq: { botAccount: '10000001' }, social: { qzoneAutoPost: true } });
kvSet('qq_owner_id', '10000002');
saveQzoneCookie('uin=o10000001; p_skey=test');
test.after(async () => { closeDb(); await new Promise((resolve) => server.close(resolve)); });

test('同一动态并发/重试只发布一次，已发布状态不能回退批准', async () => {
  const post = addPost({ kind: 'qzone', content: '今天的云很好看' });
  approvePost(post.id);
  await Promise.allSettled([tryAutoPublish(post), tryAutoPublish(post)]);
  assert.equal(calls, 1);
  assert.equal(getPost(post.id).status, 'posted');
  assert.equal((await tryAutoPublish(post)).already, true);
  assert.equal(calls, 1);
  assert.throws(() => approvePost(post.id), /不能重复/);
});

test('缺少发布回执按未知处理，不允许自动重发', async () => {
  unknown = true;
  const post = addPost({ kind: 'qzone', content: '看到一只路过的小猫' });
  const result = await tryAutoPublish(post);
  assert.equal(result.uncertain, true);
  assert.equal(getPost(post.id).status, 'unknown');
  await assert.rejects(() => tryAutoPublish(post), /未知/);
  assert.equal(calls, 2);
});
