import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_MOCK = '1';

const { chooseDouyinBrowseVideo, storeDouyinVideoNote, douyinVideoNotes, summarizeDouyinVideo } = await import('../src/channels/douyin.js');
const { Scheduler } = await import('../src/scheduler.js');
const { DeepSeek } = await import('../src/llm.js');
const { closeDb, kvSet, kvSetJson, kvGetJson } = await import('../src/db.js');
const { shanghaiDayKey } = await import('../src/util.js');

test.after(closeDb);

test('自动选视频：看过的、没有 ID 或地址的卡片都跳过，全部看过就等下一批', () => {
  const items = [
    { id: '', url: '', title: '只有文字的卡片' },
    { id: '111111', url: '', title: '没有地址' },
    { id: '222222', url: 'https://www.douyin.com/video/222222', title: '看过了' },
    { id: '333333', url: 'https://www.douyin.com/video/333333', title: '新的' },
  ];
  const notes = [{ videoId: '222222' }];
  assert.equal(chooseDouyinBrowseVideo(items, notes).id, '333333');
  assert.equal(chooseDouyinBrowseVideo(items, [...notes, { videoId: '333333' }]), null);
  assert.equal(chooseDouyinBrowseVideo([], notes), null);
  assert.equal(chooseDouyinBrowseVideo(null, null), null);
});

test('理解笔记按视频去重、新的在前、最多留 30 条，且按账号分开', () => {
  storeDouyinVideoNote('acct-a', { videoId: '111111', summary: '旧' });
  storeDouyinVideoNote('acct-a', { videoId: '222222', summary: '新' });
  storeDouyinVideoNote('acct-a', { videoId: '111111', summary: '重写' });
  let notes = kvGetJson('douyin:video-notes:acct-a', []);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].videoId, '111111', '重写的笔记排最前');
  assert.equal(notes[0].summary, '重写');
  assert.equal(notes[1].videoId, '222222');
  for (let i = 0; i < 35; i += 1) storeDouyinVideoNote('acct-a', { videoId: String(700000 + i), summary: `第${i}` });
  notes = kvGetJson('douyin:video-notes:acct-a', []);
  assert.equal(notes.length, 30);
  assert.equal(notes[0].videoId, '700034');
  storeDouyinVideoNote('acct-b', { videoId: '999999', summary: '别的账号' });
  kvSet('douyin:account', 'acct-b');
  assert.deepEqual(douyinVideoNotes().map(note => note.videoId), ['999999']);
  kvSet('douyin:account', '');
});

test('内容理解真的把画面帧发给模型：标题简介进文字，两帧进 image_url', async () => {
  const seen = [];
  const llm = { chat: async (messages, opts) => { seen.push({ messages, opts }); return { content: JSON.stringify({ summary: '在做菜', topics: ['美食', '厨房'], tone: '轻松' }) }; } };
  const frames = ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'];
  const result = await summarizeDouyinVideo(llm, { title: '家常菜教程', desc: '三步做好', frames, audio: { status: 'transcribed', text: '先把鸡蛋炒熟', startSeconds: 4, durationSeconds: 15 } });
  assert.equal(result.ok, true);
  assert.equal(result.summary, '在做菜');
  assert.deepEqual(result.topics, ['美食', '厨房']);
  assert.equal(seen.length, 1);
  const parts = seen[0].messages[1].content;
  assert.equal(parts.filter(part => part.type === 'image_url').length, 2);
  assert.match(parts[0].text, /家常菜教程/);
  assert.match(parts[0].text, /三步做好/);
  assert.match(parts[0].text, /先把鸡蛋炒熟/);
  assert.match(parts[0].text, /起点 4 秒，长度 15 秒/);
  assert.match(parts[0].text, /采样不代表整段音轨/);
  assert.equal(seen[0].opts.thinking, false);
  assert.deepEqual(seen[0].opts.responseFormat, { type: 'json_object' });
});

test('理解失败要如实返回：没画面、模型胡说、空摘要都不许落成笔记', async () => {
  let calls = 0;
  const llm = { chat: async () => { calls += 1; return { content: '这不是 JSON' }; } };
  assert.equal((await summarizeDouyinVideo(llm, { title: 't', desc: 'd', frames: [] })).ok, false);
  assert.equal(calls, 0, '没有画面就不该花模型钱');
  assert.equal((await summarizeDouyinVideo(llm, { title: 't', desc: 'd', frames: ['data:image/jpeg;base64,AAA'] })).ok, false);
  const empty = { chat: async () => ({ content: JSON.stringify({ summary: '  ' }) }) };
  assert.equal((await summarizeDouyinVideo(empty, { title: 't', desc: 'd', frames: ['data:image/jpeg;base64,AAA'] })).ok, false);
});

test('测试模式走 mock 也能产出理解结果（验收链路不依赖真模型）', async () => {
  const result = await summarizeDouyinVideo(new DeepSeek(), { title: 't', desc: 'd', frames: ['data:image/jpeg;base64,AAA'] });
  assert.equal(result.ok, true);
  assert.match(result.summary, /测试视频/);
});

test('关闭刷视频、维护中、退避期、当天到顶时都不会启动浏览器', async () => {
  const scheduler = new Scheduler({ llm: {}, companion: {} });
  kvSetJson('douyin:browse-enabled', false);
  assert.equal(await scheduler.pollDouyinBrowse(), null);
  kvSetJson('douyin:browse-enabled', true);
  kvSetJson('qq_maintenance', true);
  assert.equal(await scheduler.pollDouyinBrowse(), null);
  kvSetJson('qq_maintenance', false);
  kvSet('douyin:browse-next', String(Date.now() + 3600000));
  assert.equal(await scheduler.pollDouyinBrowse(), null);
  kvSet('douyin:browse-next', '0');
  kvSet(`douyin:browse-count:${shanghaiDayKey()}`, '6');
  assert.equal(await scheduler.pollDouyinBrowse(), null);
  kvSet(`douyin:browse-count:${shanghaiDayKey()}`, '0');
  kvSetJson('douyin:browse-enabled', false);
});
