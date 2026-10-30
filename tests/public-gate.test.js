import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', `test-public-gate-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    companion: { name: '小知', nickname: '笨蛋', userName: '阿明' },
    qq: { enabled: false, botAccount: '0123456789' },
    social: { enabled: true, xhsEnabled: true, qzoneAutoPost: true, xhsDailyCommentMax: 4 },
  }),
  'utf8',
);
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { assertPublicContent, bannedWords, privacyProblems } = await import('../src/privacy.js');
const { fillXhsNote, listXhsImages, publishFilledXhsNote, resolveXhsImage } = await import('../src/channels/xhs.js');
const { searchStickerImages } = await import('../src/sticker-search.js');
const { sendQzoneComment, saveQzoneCookie } = await import('../src/channels/qzone.js');
const { tryAutoPublish } = await import('../src/social.js');
const { kvGetJson, kvSet, kvSetJson, listEvents, closeDb } = await import('../src/db.js');

test('私称不只靠写死的词表，设置里对他的称呼也算禁词', () => {
  const words = bannedWords({ companion: { nickname: '笨蛋', userName: '阿明' } });
  assert.ok(words.includes('笨蛋'), '昵称要进禁词表');
  assert.ok(words.includes('阿明'), '真名要进禁词表');
  assert.equal(assertPublicContent('阿明今天也想要抱抱', { settings: { companion: { userName: '阿明' } } }).ok, false);
  assert.equal(assertPublicContent('今天的云很好看', { settings: { companion: { userName: '阿明' } } }).ok, true);
  assert.equal(privacyProblems('今天的云很好看').length, 0, '不传设置时行为不变');
});

test('私聊原话会被滑窗比对拦下', () => {
  const his = ['我今天在三元桥那边加班到很晚才走'];
  const result = assertPublicContent('记录一下在三元桥那边加班到很晚才走的日子', { hisMessages: his });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'echo');
});

test('笔记正文私密：在碰浏览器之前就拦下，也不留下可发布的稿子', async () => {
  kvSetJson('xhs_last_fill', null);
  await assert.rejects(
    () => fillXhsNote({ images: ['whatever.png'], title: '我们的约定', body: '主人今天说想我了' }),
    /这条不能公开写/,
  );
  assert.equal(kvGetJson('xhs_last_fill', null), null, '被拦下不该记下这稿');
  assert.ok(listEvents(20).some((e) => e.type === 'xhs_note_blocked'), '拦截要落事件');
});

test('发布只认她刚填好的稿子：没记录/太旧/冷却中/内容私密都不动', async () => {
  kvSet('xhs_cooldown_until', '');
  kvSetJson('xhs_last_fill', null);
  await assert.rejects(() => publishFilledXhsNote(), /没有她刚填好的稿子/);

  kvSetJson('xhs_last_fill', {
    title: '今天的云',
    body: '路过看一眼',
    at: new Date(Date.now() - 40 * 60000).toISOString(),
  });
  await assert.rejects(() => publishFilledXhsNote(), /半小时/);

  kvSetJson('xhs_last_fill', { title: '今天的云', body: '路过看一眼', at: new Date().toISOString() });
  kvSet('xhs_cooldown_until', new Date(Date.now() + 3600000).toISOString());
  await assert.rejects(() => publishFilledXhsNote(), /冷却/);

  kvSet('xhs_cooldown_until', '');
  kvSetJson('xhs_last_fill', { title: '我们的约定', body: '笨蛋说他等我', at: new Date().toISOString() });
  await assert.rejects(() => publishFilledXhsNote(), /这条不能公开写/);
});

test('空间回复与自动发说说也走同一道闸（发之前不落网络）', async () => {
  saveQzoneCookie('uin=o0123456789; skey=@fakeskey1; ptcz=fakeptcz');
  await assert.rejects(() => sendQzoneComment({ tid: '900', content: '主人，我们的约定' }), /这条不能公开写/);
  assert.ok(listEvents(20).some((e) => e.type === 'qzone_reply_blocked'), '空间拦截要落事件');

  const blocked = await tryAutoPublish({ id: 1, kind: 'qzone', title: '随手', content: '笨蛋今天也想要抱抱' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /这条不能公开写/);
  assert.ok(listEvents(20).some((e) => e.type === 'post_blocked'), '说说拦截要落事件');
});

test('找图的关键词也不会随手外发', async () => {
  await assert.rejects(() => searchStickerImages('笨蛋 表情包'), /这个关键词我不往外发/);
  assert.ok(listEvents(20).some((e) => e.type === 'sticker_query_blocked'));
});

test('截图和语音产物不会被当成笔记图', () => {
  const media = path.join(dataDir, 'media');
  fs.mkdirSync(media, { recursive: true });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  fs.writeFileSync(path.join(media, 'xhs-shot-1.png'), png);
  fs.writeFileSync(path.join(media, 'voice-1.wav'), png);
  fs.writeFileSync(path.join(dataDir, 'public-media', 'note-ok.png'), png);
  const names = listXhsImages().map((item) => item.name);
  assert.ok(names.includes('note-ok.png'), '正常图要可选');
  assert.equal(names.includes('xhs-shot-1.png'), false, '截图不能进选图列表');
  assert.equal(names.includes('voice-1.wav'), false);
  assert.throws(() => resolveXhsImage('xhs-shot-1.png'), /不能当笔记图/);
});

test.after(() => {
  try {
    closeDb();
  } catch {
    // 没开过库
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
