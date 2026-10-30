import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', `test-qq-robust-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ qq: { enabled: true, maxRepliesPerHour: 8 }, tts: { enabled: false } }), 'utf8');
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { OneBotChannel, assertSafeImageUrl, imageDataUrlFromPath } = await import('../src/channels/onebot.js');
const { splitForQQ } = await import('../src/util.js');
const { closeDb } = await import('../src/db.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

let channel = null;

test('内网和变形写法都当不到图：SSRF 判定逐条钉住', () => {
  const blocked = [
    'http://127.0.0.1:7788/api/status',
    'http://localhost/a.png',
    'http://10.1.2.3/a.png',
    'http://192.168.0.9/a.png',
    'http://172.16.5.5/a.png',
    'http://169.254.1.1/a.png',
    'http://100.64.1.1/a.png',
    'http://100.127.255.1/a.png',
    'http://198.18.0.1/a.png',
    'http://2130706433/a.png',
    'http://0x7f000001/a.png',
    'http://[::1]/a.png',
    'http://[fe80::1]/a.png',
    'http://user:pass@127.0.0.1/a.png',
    'file:///C:/Windows/win.ini',
  ];
  for (const url of blocked) {
    assert.throws(() => assertSafeImageUrl(url), /本机|内网|协议|账号|变形|不合法/, `应该拦住：${url}`);
  }
  const allowed = [
    'https://pic1.example.com/a.png',
    'http://88.13.43.90/x.jpg',
    'https://a.example.com/pic?id=1',
    'http://evil.example.com:8080/@127.0.0.1/',
  ];
  for (const url of allowed) {
    assert.equal(assertSafeImageUrl(url).hostname.includes('example') || url.includes('88.13'), true, `不该误杀：${url}`);
  }
});

test('同一会话不并发回两轮；正在回时来的消息排到下一轮', async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  channel = new OneBotChannel({ server, companion: {} });
  let drains = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  channel.drainBuffer = async (key) => {
    drains += 1;
    if (drains === 1) await gate;
  };
  const seed = (text) => {
    channel.buffers.set('private:123', {
      texts: [text],
      images: [],
      voices: [],
      target: { type: 'private', userId: '123' },
      nickname: '',
      guest: false,
      sessionId: 's',
      timer: null,
    });
  };

  seed('第一轮');
  const first = channel.flushBuffer('private:123');
  await tick();
  seed('第二轮');
  const second = channel.flushBuffer('private:123');
  assert.equal(drains, 1, '上一轮还没回完，不能开第二轮');
  release();
  await first;
  await second;
  await tick();
  assert.equal(drains, 2, '上一轮结束后要补上这一轮');

  channel.destroy();
  server.close();
});

test('限流分桶：群刷屏不能吃掉主人私聊的额度', () => {
  const settings = { qq: { maxRepliesPerHour: 8 } };
  channel.markReply('group');
  channel.markReply('group');
  channel.markReply('group');
  const group = channel.replyBucket('group', settings);
  assert.equal(group.limit, 3, '群/陌生人一路只给约四分之一，且不低于 3');
  assert.equal(group.ok, false, `群里回满就该停：${JSON.stringify(group)}`);
  const owner = channel.replyBucket('owner', settings);
  assert.equal(owner.ok, true, '主人私聊这一路还要能回');
  assert.equal(owner.limit, 8, '主人一路吃全额');
  for (let i = 0; i < 8; i += 1) channel.markReply('owner');
  assert.equal(channel.replyBucket('owner', settings).ok, false, '全局硬顶还是要挡');
  assert.match(channel.replyBucket('owner', settings).reason, /总共回了/);
});

test('长回复拆成多条短气泡，一个字都不丢', () => {
  const long = `${'前面这段够长了，故意写满来试探分条。'.repeat(90)}最后这段是最要紧的结论，不能丢。`;
  assert.ok(long.length > 1000, `样本要足够长才测到分条：${long.length}`);
  const chunks = splitForQQ(long, 180);
  assert.ok(chunks.length > 1, '长回复应该分成多条，而不是一整段');
  assert.ok(chunks.length <= 12, '不该超过程序分条上限');
  assert.ok(chunks.every((chunk) => chunk.length <= 220), '单条气泡不该过长');
  const joined = chunks.join('').replace(/\s+/g, '');
  const normalized = long.replace(/\s+/g, '');
  assert.equal(joined, normalized, '分条后不该丢字，也不该出现“还有 N 字没发完”这种系统提示');
  assert.ok(!/没发完/.test(chunks.join('')), '真人不会在消息里报告内部截断');
});

test('图片只给本地路径时也真去读，读不到就不谎称看见了', () => {
  const dir = path.join(dataDir, 'img-probe');
  fs.mkdirSync(dir, { recursive: true });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  const good = path.join(dir, 'good.png');
  const fake = path.join(dir, 'fake.png');
  fs.writeFileSync(good, png);
  fs.writeFileSync(fake, Buffer.from('这不是图片，可能是 QQ 的加密缓存'));

  assert.match(imageDataUrlFromPath(good), /^data:image\/png;base64,/, '本地真图要读成 data URL');
  assert.equal(imageDataUrlFromPath(fake), null, '内容不是图片就别硬当图片');
  assert.equal(imageDataUrlFromPath(path.join(dir, '不存在.png')), null, '文件不在就说不在');
  assert.equal(imageDataUrlFromPath('https://example.com/a.png'), null, '网络地址不该由这条路处理');
});

test.after(() => {
  try {
    closeDb();
  } catch {
    // 已关闭
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
