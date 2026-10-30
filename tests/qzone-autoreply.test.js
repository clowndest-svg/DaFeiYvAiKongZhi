import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(process.cwd(), 'data', `test-qzone-autoreply-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;

const sent = [];
let decisionAnswer = true;
let decisionCalls = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (req.url.includes('emotion_cgi_re_feeds')) {
      sent.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 0 }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.QZONE_BASE_URL = `http://127.0.0.1:${server.address().port}`;

const db = await import('../src/db.js');
db.kvSet('qq_owner_id', '2000000002');
db.kvSet('qq_self_id', '123456789');
const qz = await import('../src/channels/qzone.js');
const { saveSettings } = await import('../src/config.js');
saveSettings({ qq: { botAccount: '123456789' } });
qz.saveQzoneCookie('uin=o123456789; skey=abc; p_skey=xyz; p_uin=o123456789');
const { Scheduler } = await import('../src/scheduler.js');

const llm = {
  async chat(_messages, options) {
    if (options.kind === 'qzone_decision') {
      decisionCalls += 1;
      return { content: JSON.stringify({ reply: decisionAnswer }) };
    }
    return { content: '谢谢你呀' };
  },
};
const scheduler = new Scheduler({ llm, companion: {} });

function feedWith(comment) {
  return {
    uin: '123456789',
    posts: [{ tid: `tid-${comment.id}`, content: '今天天气不错', comments: [{ replies: [], ...comment }] }],
  };
}

test('主人的空间评论必回，不经过判断', async () => {
  decisionAnswer = false;
  decisionCalls = 0;
  const result = await scheduler.processQzoneAutoReplies(
    feedWith({ id: 'owner-1', uin: '2000000002', nickname: '主人', content: '去你的' }),
    { force: true },
  );
  assert.equal(result.replied.length, 1);
  assert.equal(decisionCalls, 0);
  assert.equal(sent.length, 1);
  assert.match(decodeURIComponent(sent[0]), /谢谢你呀/);
});

test('其他人评论判断为不回时，不发回复', async () => {
  decisionAnswer = false;
  decisionCalls = 0;
  const result = await scheduler.processQzoneAutoReplies(
    feedWith({ id: 'other-1', uin: '999', nickname: '路人', content: '路过看看' }),
    { force: true },
  );
  assert.equal(result.replied.length, 0);
  assert.equal(decisionCalls, 1);
  assert.equal(sent.length, 1);
});

test('其他人评论判断为回时才发，已回的评论不会重复', async () => {
  decisionAnswer = true;
  decisionCalls = 0;
  const feed = feedWith({ id: 'other-2', uin: '999', nickname: '路人', content: '写得真好' });
  const first = await scheduler.processQzoneAutoReplies(feed, { force: true });
  assert.equal(first.replied.length, 1);
  assert.equal(decisionCalls, 1);
  assert.equal(sent.length, 2);

  const second = await scheduler.processQzoneAutoReplies(feed, { force: true });
  assert.equal(second.replied.length, 0);
  assert.equal(decisionCalls, 1);
  assert.equal(sent.length, 2);
});

test.after(() => {
  qz.clearQzoneCookie();
  server.close();
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
