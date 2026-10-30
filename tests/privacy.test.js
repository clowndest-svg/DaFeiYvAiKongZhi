import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-privacy-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;

const { privacyProblems, leaksFromChat, TOPIC_HINTS } = await import('../src/privacy.js');
const { parseOwnerCommand } = await import('../src/channels/onebot.js');
const { buildSystemPrompt } = await import('../src/prompt.js');
const { loadSettings } = await import('../src/config.js');
const { getMomLetter } = await import('../src/config.js');
const { closeDb } = await import('../src/db.js');

test('私密称呼和恋爱关系不许出现在公开内容里', () => {
  assert.ok(privacyProblems('主人今天好乖').length >= 1);
  assert.ok(privacyProblems('我男朋友又熬夜了').length >= 1);
  assert.ok(privacyProblems('我们的约定他还记得').length >= 1);
  assert.deepEqual(privacyProblems('今天学到一个新词，AI 又离谱了'), []);
  assert.match(TOPIC_HINTS, /心情/);
});

test('他聊天里说过的原话，不许被她搬到公开笔记里', () => {
  const hits = leaksFromChat('过年前110我信你能行', ['过年前110，我信你能行吗']);
  assert.ok(hits.length >= 1, '要能抓出照搬的私聊原话');
  assert.deepEqual(leaksFromChat('凌晨三点的屏幕真的很安静', ['过年前110，我信你能行吗']), []);
});

test('妈妈的话进了她的脑子，QQ 口令能认出来', () => {
  assert.ok(getMomLetter().includes('广场'), '信里要有“广场/家里”那条');
  const system = buildSystemPrompt({
    settings: loadSettings(),
    mood: { valence: 0.3, energy: 0.6, affection: 30, label: '还行' },
    block: { core: [], long: [], mid: [], innerThoughts: [], dailyRecent: [], diaryMatches: [] },
  });
  assert.match(system, /妈妈留给你的话/);
  assert.match(system, /家里说的话，留在家里|私聊是.*家里|广场/);
  assert.equal(parseOwnerCommand('状态'), 'status');
  assert.equal(parseOwnerCommand('自动运营 关'), 'auto_off');
  assert.equal(parseOwnerCommand('逛一下'), 'browse');
  assert.equal(parseOwnerCommand('发一条'), 'publish');
  assert.equal(parseOwnerCommand('今天做了啥'), 'today');
  assert.equal(parseOwnerCommand('你今天好不好'), null, '普通聊天不能被当口令');
});

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
