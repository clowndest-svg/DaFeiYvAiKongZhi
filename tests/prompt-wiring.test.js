import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', `test-prompt-wiring-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_SETTINGS_FILE = path.join(dataDir, 'settings.json');
fs.writeFileSync(process.env.BIZHI_SETTINGS_FILE, JSON.stringify({ companion: { name: '小知' } }), 'utf8');

const bs = String.fromCharCode(92);
const nl = String.fromCharCode(10);

const { buildDreamPrompt, buildXhsNoteWillPrompt, buildXhsProfilePrompt } = await import('../src/prompt.js');
const { TOPIC_HINTS } = await import('../src/privacy.js');
const { closeDb } = await import('../src/db.js');

const settings = { companion: { name: '小知' } };
const mood = { valence: 0.2, energy: 0.5, affection: 3 };
const block = {
  dailyRecent: [
    { date: '2026-10-29', digest: '他把耳机落在我这儿了' },
    { date: '2026-10-28', digest: '我一个人刷到很晚' },
  ],
  core: [{ content: '他上班的楼在三元桥' }, { content: '他不喜欢被催' }],
};

test('公开选题白名单真的进了"要不要发笔记"的提示词', () => {
  const text = buildXhsNoteWillPrompt({
    settings,
    mood,
    block,
    activity: [{ type: 'like', text: '点了个赞' }, { type: 'comment', text: '评论了一句' }],
    intentions: [{ text: '问他耳机拿到没有' }],
    topics: TOPIC_HINTS,
  });
  assert.ok(text.includes(TOPIC_HINTS.slice(0, 12)), '话题清单要被注入');
  assert.equal(text.includes('${TOPICS}'), false, '不能留字面量占位符');
});

test('公开笔记提示词只带公开信息，不喂私聊记忆', () => {
  const text = buildXhsNoteWillPrompt({
    settings,
    mood,
    block,
    activity: [{ type: 'like', text: '点了个赞' }, { type: 'comment', text: '评论了一句' }],
    intentions: [{ text: '问他耳机拿到没有' }],
    topics: TOPIC_HINTS,
  });
  assert.equal(text.includes(bs + 'n'), false, `提示词里出现了字面 ${bs}n`);
  assert.ok(text.includes('点了个赞'), '公开活动要进提示词');
  assert.ok(text.includes(TOPIC_HINTS.slice(0, 12)), '公开话题要进提示词');
  assert.equal(text.includes('他把耳机落在我这儿了'), false, '日记不能喂给公开账号');
  assert.equal(text.includes('三元桥'), false, '核心档案不能喂给公开账号');
  assert.equal(text.includes('问他耳机拿到没有'), false, '她惦记的私事不能喂给公开账号');
  assert.equal(text.includes('2026-10-29：'), false, '公开提示词不该带日记条目');
  assert.ok(text.split(nl).length > 10, '整段应该是多行的');
});

test('空清单不会被拼成一行，也不会漏掉提示', () => {
  const text = buildXhsNoteWillPrompt({ settings, mood, block: { dailyRecent: [], core: [] }, activity: [], intentions: [], topics: '' });
  assert.ok(text.includes('（这几天没在平台上做事）'), text.slice(0, 200));
  assert.ok(text.includes('心情、学到或看到的东西'), '不传 topics 时要用内置清单');
});

test('睡前反思能拿到日记，资料文案不会拼成一行', () => {
  const dream = buildDreamPrompt({ settings, mood, diary: '2026-10-29：他把耳机落在我这儿了', intentions: [{ text: '问他耳机' }], recent: '他：今天累不累' });
  assert.ok(dream.includes('他把耳机落在我这儿了'), '日记要进睡前反思');
  assert.equal(dream.includes(bs + 'n'), false);
  const profile = buildXhsProfilePrompt({ settings, mood, current: { name: '旧昵称', desc: '旧简介' }, memories: [{ content: '她喜欢蓝鲸鱼' }, { content: '她讨厌被叫宝宝' }] });
  assert.equal(profile.includes('她喜欢蓝鲸鱼'), false, '公开资料不应使用私人记忆');
  assert.equal(profile.includes('她讨厌被叫宝宝'), false);
});

test.after(() => {
  try {
    closeDb();
  } catch {
    // 没开过库
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
