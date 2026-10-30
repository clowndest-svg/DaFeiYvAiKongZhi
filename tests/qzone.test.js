import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(process.cwd(), 'data', `test-qzone-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;

let captured = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    captured = { url: req.url, headers: req.headers, body };
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('frameElement.callback({"code":0,"tid":"tid_test_123","t1_tid":"tid_test_123"});');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
process.env.QZONE_BASE_URL = `http://127.0.0.1:${port}`;

const qz = await import('../src/channels/qzone.js');
const { saveSettings } = await import('../src/config.js');
saveSettings({ qq: { botAccount: '123456789' } });
const { closeDb, kvSet, listEvents } = await import('../src/db.js');

test('Cookie 解析能剥掉 uin 前缀并找到关键字段', () => {
  const parsed = qz.parseCookieString('Cookie: uin=o123456789; skey=abc; p_skey=xyz; p_uin=o123456789');
  assert.equal(parsed.uin, '123456789');
  assert.equal(parsed.pSkey, 'xyz');
  assert.equal(parsed.skey, 'abc');
  assert.throws(() => qz.parseCookieString('foo=bar'), /uin/);
});

test('腾讯在响应头里换的新 p_skey 会自动吸收进本地 Cookie，不用人手抄', () => {
  qz.saveQzoneCookie('uin=o123456789; skey=abc; p_skey=xyz; p_uin=o123456789');
  const fakeRes = {
    headers: {
      getSetCookie: () => [
        'p_skey=NEWPSKEY; Path=/; Domain=.qq.com',
        'skey=NEWSKEY; Path=/',
        'wxlogin_key=SHOULD_IGNORE; Path=/',
        'p_skey=; Path=/',
      ],
    },
  };
  assert.equal(qz.absorbSetCookie(fakeRes, '测试'), 2, '只该吸收 p_skey 和 skey 两个');
  const stored = qz.getQzoneCookie();
  assert.equal(stored.pSkey, 'NEWPSKEY');
  assert.equal(stored.skey, 'NEWSKEY');
  assert.equal(stored.cookie.includes('SHOULD_IGNORE'), false, '白名单外的键不许被塞进 Cookie');
  assert.equal(qz.absorbSetCookie(fakeRes, '测试'), 0, '值没变就不该再写一遍、再报一次续期');
  assert.ok(listEvents(20).some((e) => e.type === 'qzone_cookie_renewed'), '续期要留下能看见的事件');
  qz.clearQzoneCookie();
});

test('Cookie 健康：多久没成功请求过要能读出来，不是猜', () => {
  qz.saveQzoneCookie('uin=o123456789; skey=abc; p_skey=xyz; p_uin=o123456789');
  kvSet('qzone_cookie_ok_at', '');
  const justSaved = qz.qzoneCookieHealth();
  assert.equal(justSaved.configured, true);
  assert.equal(justSaved.uin, '123456789');
  assert.equal(justSaved.stale, false, '刚存下的不该一上来就报过期');

  kvSet('qzone_cookie_ok_at', new Date(Date.now() - 72 * 3600000).toISOString());
  const rotten = qz.qzoneCookieHealth();
  assert.equal(rotten.stale, true, '三天没成功请求过要标 stale');
  assert.ok(rotten.ageHours >= 70, `小时数要真实：${rotten.ageHours}`);

  kvSet('qzone_cookie_ok_at', new Date().toISOString());
  assert.equal(qz.qzoneCookieHealth().stale, false);
  kvSet('qzone_cookie_ok_at', '');
  qz.clearQzoneCookie();
});

test('g_tk 是稳定的 31 位整数', () => {
  const a = qz.calcGtk('p_skey_demo');
  const b = qz.calcGtk('p_skey_demo');
  assert.equal(a, b);
  assert.ok(a >= 0 && a <= 0x7fffffff);
  assert.notEqual(a, qz.calcGtk('another'));
});

test('发布表单带齐 hostuin / con / format', () => {
  const form = qz.buildPublishForm({ content: '今天有点想你', uin: '123456789' });
  assert.equal(form.get('con'), '今天有点想你');
  assert.equal(form.get('hostuin'), '123456789');
  assert.equal(form.get('format'), 'fs');
  assert.match(form.get('qzreferrer'), /123456789\/main/);
});

test('没配置 Cookie 时明确拒绝，而不是假装发布', async () => {
  qz.clearQzoneCookie();
  await assert.rejects(() => qz.publishQzone({ content: '不该发出去' }), /Cookie/);
});

test('能通过 HTTP 发布说说并解析 JSONP 返回 tid', async () => {
  qz.saveQzoneCookie('uin=o123456789; skey=abc; p_skey=xyz; p_uin=o123456789');
  const result = await qz.publishQzone({ content: '今天心情不错，想出去走走。' });
  assert.equal(result.tid, 'tid_test_123');
  assert.ok(captured);
  assert.match(captured.url, /emotion_cgi_publish_v6\?g_tk=\d+/);
  assert.equal(captured.headers.cookie, 'uin=o123456789; skey=abc; p_skey=xyz; p_uin=o123456789');
  assert.match(captured.body, /con=/);
  assert.match(captured.body, /hostuin=123456789/);
  const status = qz.qzoneStatus();
  assert.equal(status.configured, true);
  assert.equal(status.uin, '123456789');
});

test.after(() => {
  qz.clearQzoneCookie();
  server.close();
  closeDb(); // 状态读取会开库：Windows 上不先关掉就删不掉这个目录
  fs.rmSync(dataDir, { recursive: true, force: true });
});
