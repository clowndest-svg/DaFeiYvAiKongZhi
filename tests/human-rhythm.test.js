import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const dataDir = path.join(process.cwd(), 'data', `test-human-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_SETTINGS_FILE = path.join(dataDir, 'settings.json');

const { checkBotIdentity, OneBotChannel } = await import('../src/channels/onebot.js');
const { getMood } = await import('../src/mood.js');
const { addMood, closeDb, getDb, createSession, addMessage, listEvents, listMemories, kvSet, kvSetJson } = await import('../src/db.js');
const { reflect } = await import('../src/reflect.js');
const { addIntention, listIntentions, pickDueIntention } = await import('../src/intentions.js');
const { findQuotedLines } = await import('../src/db.js');
const { assertPublicContent } = await import('../src/privacy.js');

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('NapCat 挂主人号或挂错号时必须拒绝发送', () => {
  assert.equal(checkBotIdentity({ selfId: '2000000002', ownerId: '2000000002', botAccount: '2000000001' }).ok, false);
  assert.match(checkBotIdentity({ selfId: '2000000002', ownerId: '2000000002', botAccount: '2000000001' }).reason, /主人号/);
  assert.equal(checkBotIdentity({ selfId: '123456', ownerId: '2000000002', botAccount: '2000000001' }).ok, false);
  assert.equal(checkBotIdentity({ selfId: '2000000001', ownerId: '2000000002', botAccount: '2000000001' }).ok, true);
});

test('真的要走发送时也会被拦下，而不是只靠状态里的红字', async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const channel = new OneBotChannel({ server, companion: {} });
  channel.selfId = '2000000002';
  kvSet('qq_owner_id', '2000000002');
  const sent = [];
  channel.clients.add({
    readyState: 1,
    isAlive: true,
    ping() {},
    on() {},
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  });
  await assert.rejects(() => channel.sendToTarget({ type: 'private', userId: '123456789' }, '这句不能发'), /主人号/);
  assert.equal(sent.length, 0, '不应该有任何一个包发到 NapCat');
  assert.ok(listEvents(20).some((e) => e.type === 'qq_identity_mismatch'), '必须留下事件，不能静默');
  channel.destroy();
  server.close();
});

test('旧心情会随时间回落，不再把昨晚的 reason 当成现在', () => {
  const row = addMood({ valence: 0.9, energy: 0.9, affection: 50, label: '开心得冒泡', reason: '他说晚安' });
  getDb().prepare('UPDATE moods SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 13 * 3600000).toISOString(), row.id);
  const mood = getMood();
  assert.equal(mood.reason, '', '超过两小时的旧原因不该继续注入');
  assert.ok(mood.valence < 0.9, `valence 应该回落：${mood.valence}`);
  assert.ok(mood.energy < 0.9, `energy 应该回落：${mood.energy}`);
});

test('过期、提过两次、提过不久的惦记不再进入提示词', () => {
  const now = Date.now();
  kvSetJson('open_intentions', [
    { id: 'stale', text: '十一点半查他睡没睡', createdAt: new Date(now - 2 * 3600000).toISOString(), dueAt: new Date(now - 48 * 3600000).toISOString(), tries: 0 },
    { id: 'old', text: '五天前想做的事', createdAt: new Date(now - 5 * 86400000).toISOString(), dueAt: new Date(now - 5 * 86400000).toISOString(), tries: 0 },
    { id: 'tried', text: '已经提过两次的事', createdAt: new Date().toISOString(), dueAt: new Date(now - 3600000).toISOString(), tries: 2 },
    { id: 'recent', text: '刚提过的事', createdAt: new Date().toISOString(), dueAt: new Date(now - 3600000).toISOString(), tries: 1, lastMentionedAt: new Date(now - 3600000).toISOString() },
    { id: 'yesterday', text: '昨晚十一点半查他睡没睡', createdAt: new Date(now - 86400000).toISOString(), dueAt: new Date(now - 24 * 3600000).toISOString(), tries: 0 },
    { id: 'due', text: '想问他体检结果', createdAt: new Date().toISOString(), dueAt: new Date(now - 3600000).toISOString(), tries: 0 },
  ]);
  const promptList = listIntentions({ limit: 10, forPrompt: true });
  assert.deepEqual(promptList.map((x) => x.id), ['due']);
  const all = listIntentions({ limit: 10 });
  assert.ok(all.some((x) => x.id === 'recent'), '界面还能看到她刚提过的事');
  assert.equal(pickDueIntention()?.id, 'due');
  assert.equal(addIntention({ text: '想问他体检结果', dueInHours: 1 }), null, '语义重复的惦记不该再加一条');
});

test('反思只有在他原话能对上时才写核心档案', async () => {
  const settings = { companion: { name: '鲸鲸', userName: '主人', nickname: '笨蛋' }, model: { reflectEvery: 1, reflectMaxTokens: 450 } };
  const session = createSession('测试反思');
  addMessage({ sessionId: session.id, role: 'user', content: '今天有点累，晚上想早点睡' });
  addMessage({ sessionId: session.id, role: 'assistant', content: '那就早点躺下，我陪你。' });
  const before = listMemories({ layer: 'core', limit: 100 }).length;
  const fake = (payload) => ({ chat: async () => ({ content: JSON.stringify(payload) }) });
  await reflect({
    llm: fake({ inner_thought: '他累了。', profile_updates: [{ content: '他叫小明', evidence: '我叫小明' }] }),
    sessionId: session.id,
    assistantMessageId: null,
    settings,
  });
  assert.equal(listMemories({ layer: 'core', limit: 100 }).length, before, '对不上原话的档案不能写');
  assert.ok(listEvents(20).some((e) => e.type === 'reflect_profile_rejected'));

  const session2 = createSession('测试反思2');
  addMessage({ sessionId: session2.id, role: 'user', content: '我最近在学做饭' });
  addMessage({ sessionId: session2.id, role: 'assistant', content: '那我等着吃。' });
  await reflect({
    llm: fake({ inner_thought: '他想学做饭。', profile_updates: [{ content: '他最近在学做饭', evidence: '我最近在学做饭' }] }),
    sessionId: session2.id,
    assistantMessageId: null,
    settings,
  });
  assert.ok(
    listMemories({ layer: 'core', limit: 100 }).some((m) => m.content.includes('学做饭')),
    '能对上原话的档案应该写进去',
  );
});

test('公开闸门拦住旧泄露原话、主人小红书昵称和具体时间', () => {
  const settings = { companion: { userName: '主人', nickname: '笨蛋' }, social: { xhsOwnerName: '测试主人昵称' } };
  const blocked = [
    '被关注的感觉还挺让人小欢喜的，不过日记这种私密的东西，想看得先报篇目，最多商量一篇哦',
    '别得意，十一点半我还是会去查岗的。哼，睡前记得叫那声说好的称呼。',
    '测试主人昵称今天也没来找我',
    '他今天下午来接我下班',
    '10月30日晚上十一点半的约定',
  ];
  for (const text of blocked) {
    assert.equal(assertPublicContent(text, { settings, hisMessages: [] }).ok, false, `应该拦下：${text}`);
  }
  const ok = assertPublicContent('今天下班路上看到一只蓝鲸鱼，心情忽然变好了，晚上要早点睡。', {
    settings,
    hisMessages: [],
  });
  assert.equal(ok.ok, true, `正常公开内容不该误伤：${ok.reason}`);
});

test('短原话也能查到，但群聊/访客的话不算他原话', () => {
  const session = createSession('测试原话');
  addMessage({ sessionId: session.id, role: 'user', content: '我不吃香菜', channel: 'web' });
  addMessage({ sessionId: session.id, role: 'user', content: '我不吃香菜啊', channel: 'qq-group' });
  const found = findQuotedLines('不吃香菜', { skipRecent: 0, days: 2 });
  assert.ok(found.length >= 1, '三四个字的短句也要能搜到');
  assert.ok(found.every((x) => x.channel === 'web'), `群聊不该混进来：${JSON.stringify(found)}`);
  assert.ok(found.some((x) => x.text === '我不吃香菜'));
});
