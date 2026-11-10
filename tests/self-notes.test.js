import test from 'node:test';
import assert from 'node:assert/strict';
import { getHerSelfNotes, updateHerSelfNotes, clearHerSelfNotes, selfNotesVersions } from '../src/self.js';
import { buildChatPayload, buildReflectionPrompt } from '../src/prompt.js';
import { reflect } from '../src/reflect.js';
import { addMessage, closeDb, createSession, getDb, listThoughts, listEvents } from '../src/db.js';

test.after(closeDb);

const settings = { companion: { name: '小知' }, memory: {}, model: { reflectEvery: 1 } };
const mood = { label: '平静', valence: 0.2, energy: 0.5, affection: 30, reason: '' };

test('她自己写自己：追加、整段重写、上限、历史都留在本机', () => {
  clearHerSelfNotes({ source: 'test' });
  assert.equal(getHerSelfNotes().text, '');
  updateHerSelfNotes({ mode: 'append', text: '我喜欢先说结论再接细节。' }, { source: 'test' });
  updateHerSelfNotes({ mode: 'append', text: '晚上说话慢一点。' }, { source: 'test' });
  assert.match(getHerSelfNotes().text, /先说结论/);
  assert.match(getHerSelfNotes().text, /晚上说话慢一点/);
  updateHerSelfNotes({ mode: 'replace', text: '我说话短，喜欢反问。' }, { source: 'test' });
  assert.equal(getHerSelfNotes().text, '我说话短，喜欢反问。');
  assert.ok(getHerSelfNotes().updatedAt);
  updateHerSelfNotes({ mode: 'append', text: '长'.repeat(4000) }, { source: 'test' });
  assert.ok(getHerSelfNotes().text.length <= 1500, '自我档案要有上限，别把上下文吃光');
  assert.ok(selfNotesVersions().length >= 3, '每次改动都要留版本');
  assert.equal(updateHerSelfNotes({ mode: 'append', text: '   ' }), null, '空白不落库');
  clearHerSelfNotes({ source: 'test' });
  assert.equal(getHerSelfNotes().text, '');
});

test('她写的自我档案会进聊天提示词，并且优先级写明高于说话参考', () => {
  clearHerSelfNotes({ source: 'test' });
  updateHerSelfNotes({ mode: 'replace', text: '我决定说话更直接一点，不用每句都反问。' }, { source: 'test' });
  const payload = buildChatPayload({
    settings: { companion: { name: '小知' }, memory: {} },
    mood,
    block: { core: [], long: [], mid: [], summary: '', handover: '', innerThoughts: [] },
    history: [{ role: 'user', content: '在吗', meta: {} }],
    maxContextTokens: 100000,
    channel: 'qq',
  });
  assert.match(payload.messages[0].content, /你自己写的话/);
  assert.match(payload.messages[0].content, /我决定说话更直接一点/);
  assert.match(payload.messages[0].content, /以你写的为准/);
  clearHerSelfNotes({ source: 'test' });
});

test('说话方式降成参考，只有诚实、隐私、尊重三条不能改', () => {
  clearHerSelfNotes({ source: 'test' });
  const payload = buildChatPayload({
    settings: { companion: { name: '小知' }, memory: {} },
    mood,
    block: { core: [], long: [], mid: [], summary: '', handover: '', innerThoughts: [] },
    history: [{ role: 'user', content: '在吗', meta: {} }],
    maxContextTokens: 100000,
    channel: 'qq',
  });
  const system = payload.messages[0].content;
  assert.match(system, /不是锁/);
  assert.match(system, /只有三条不能改/);
  assert.doesNotMatch(system, /少用固定开场/, '旧的微观管束文案还在');
  assert.match(system, /一次只说一遍/, '诚实与不灌水的基本要求不能一起删掉');
});

test('反思里她可以改自己：self_update 写进自我档案，非法内容不动', async () => {
  clearHerSelfNotes({ source: 'test' });
  const session = createSession('自我修改');
  const messages = [{ role: 'user', content: '我今天有点累。' }, { role: 'assistant', content: '那早点睡。' }];
  let promptSeen = '';
  await reflect({
    sessionId: session.id,
    settings,
    messages,
    batched: true,
    llm: { chat: async (msgs) => { promptSeen = msgs[1].content; return { content: JSON.stringify({ self_update: { mode: 'append', text: '累的时候我说话会更短。' } }) }; } },
  });
  assert.match(promptSeen, /self_update/, '反思提示词要告诉她可以改自己');
  assert.match(getHerSelfNotes().text, /累的时候我说话会更短/);
  const rejected = await reflect({
    sessionId: session.id,
    settings,
    messages,
    batched: true,
    llm: { chat: async () => ({ content: JSON.stringify({ self_update: { mode: 'replace', text: '' } }) }) },
  });
  assert.equal(rejected.selfUpdated, false);
  assert.match(getHerSelfNotes().text, /累的时候我说话会更短/, '空内容不能把已写的东西清掉');
  assert.ok(listEvents(20).some((event) => event.type === 'self_edit'), '改自己要留下运行事件');
});

test('反思提示词带上她现写的自我档案，让她知道在改哪一版', () => {
  updateHerSelfNotes({ mode: 'replace', text: '我的旧版本：说话快。' }, { source: 'test' });
  const prompt = buildReflectionPrompt({ settings, mood, transcript: '他：在吗', coreMemories: [], selfNotes: '我的旧版本：说话快。' });
  assert.match(prompt, /我的旧版本：说话快/);
  assert.match(prompt, /append 是追加一段，replace 是整段重写/);
  clearHerSelfNotes({ source: 'test' });
});

test('思考日志能按回复取出来：心里话、时间、当时的回复都在', () => {
  const session = createSession('思考日志');
  const saved = addMessage({ sessionId: session.id, role: 'assistant', content: '好呀，那我等你。', channel: 'qq', meta: { innerThought: '他今天话很少，可能真的累了。' } });
  const thoughts = listThoughts(10);
  const found = thoughts.find((item) => item.id === saved.id);
  assert.ok(found, '带心里话的回复没被取出来');
  assert.equal(found.thought, '他今天话很少，可能真的累了。');
  assert.equal(found.channel, 'qq');
  assert.match(found.reply, /那我等你/);
  assert.ok(found.at);
});