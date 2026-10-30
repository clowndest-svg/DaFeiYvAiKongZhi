import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(process.cwd(), 'data', `test-qzone-read-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;

let captured = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (req.url.includes('emotion_cgi_msglist_v6')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          code: 0,
          msglist: [
            {
              tid: 'tid1',
              content: '今天天气不错',
              created_time: 1793190000,
              likenum: 2,
              cmtnum: 1,
              likes: [{ uin: 111, nickname: '小明' }],
              conlist: [
                { commentid: 'c1', uin: 222, nickname: '小红', content: '好看', createTime: 1793190100 },
              ],
            },
          ],
        }),
      );
      return;
    }
    if (req.url.includes('emotion_cgi_re_feeds')) {
      captured = { url: req.url, body };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 0 }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
process.env.QZONE_BASE_URL = `http://127.0.0.1:${port}`;

const qz = await import('../src/channels/qzone.js');
const { saveSettings } = await import('../src/config.js');
saveSettings({ qq: { botAccount: '123456789' } });
qz.saveQzoneCookie('uin=o123456789; skey=abc; p_skey=xyz; p_uin=o123456789');

test('能读自己的说说、点赞列表和评论', async () => {
  const feed = await qz.fetchQzonePosts({ num: 10 });
  assert.equal(feed.uin, '123456789');
  assert.equal(feed.posts.length, 1);
  const post = feed.posts[0];
  assert.equal(post.tid, 'tid1');
  assert.equal(post.likeCount, 2);
  assert.equal(post.likes[0].nickname, '小明');
  assert.equal(post.comments[0].nickname, '小红');
  assert.equal(post.comments[0].content, '好看');
});

test('评论回复会带上 topicId / 评论 id / 内容', async () => {
  const result = await qz.sendQzoneComment({
    tid: 'tid1',
    content: '谢谢你呀',
    commentId: 'c1',
    replyUin: '222',
  });
  assert.equal(result.ok, true);
  assert.ok(captured);
  assert.match(captured.body, /topicId=123456789_tid1/);
  assert.match(captured.body, /commentId=c1/);
  assert.match(captured.body, /content=/);
});

test('feeds3 转义 HTML 能解析、去重评论和制表符', () => {
  const block = String.raw`name=\x22feed_data\x22 data-tid=\x22tid1\x22 data-uin=\x22123456789\x22 data-abstime=\x221793246331\x22></i><p class=\x22txt-box-title\x22><a class=\x22nickname\x22>鲸鲸</a><span class=\x22state\x22>：</span>\t\t今天不错\t</p><li data-type=\x22commentroot\x22 data-tid=\x22c1\x22 data-uin=\x22222\x22 data-nick=\x22主人\x22><a class=\x22nickname\x22>主人</a>：去你的<div class=\x22comments-op\x22><span class=\x22state\x22>30分钟前</span></div><div class=\x22comments-list mod-comments-sub\x22><ul><li data-type=\x22replyroot\x22 data-tid=\x22c1\x22 data-uin=\x22333\x22 data-nick=\x22鲸鲸\x22><a class=\x22nickname\x22>鲸鲸</a>：我错啦<div class=\x22comments-op\x22></div></li></ul></div></li>`;
  const posts = qz.parseFeeds3Posts(`${block}${block}`);
  assert.equal(posts.length, 1);
  assert.match(posts[0].content, /^今天不错$/);
  assert.equal(posts[0].comments.length, 1);
  assert.equal(posts[0].commentCount, 2);
  assert.equal(posts[0].comments[0].content, '去你的');
  assert.equal(posts[0].comments[0].nickname, '主人');
  assert.ok(posts[0].comments[0].createdAt, '相对时间应解析成时间戳');
  assert.equal(posts[0].comments[0].replies.length, 1);
  assert.equal(posts[0].comments[0].replies[0].uin, '333');
  assert.equal(posts[0].comments[0].replies[0].content, '我错啦');
});

test.after(async () => {
  qz.clearQzoneCookie();
  server.close();
  const { closeDb } = await import('../src/db.js');
  try {
    closeDb();
  } catch {
    // 这个测试没开过库
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
