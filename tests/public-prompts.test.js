import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPostPrompt, buildXhsProfilePrompt, buildXhsCommentPrompt, buildQzoneCommentReplyPrompt } from '../src/prompt.js';
import { resolveSocialNewsSource } from '../src/social.js';
import { closeDb, kvSetJson } from '../src/db.js';

test.after(closeDb);

test('公开选题适用于三个平台且保留为素材', () => {
  for (const kind of ['qzone', 'xhs', 'douyin']) {
    const prompt = buildPostPrompt({ settings: {}, mood: {}, kind, topic: '蓝鲸鱼的一天' });
    assert.match(prompt, /蓝鲸鱼的一天/);
    assert.match(prompt, /只作为内容素材/);
  }
});

test('资讯来源以待核实数据提供给公开文案生成', () => {
  const prompt = buildPostPrompt({ settings: {}, mood: {}, kind: 'douyin', topic: '模型发布', source: { title: '官方公告', snippet: '候选摘要', url: 'https://example.com/news' } });
  assert.match(prompt, /官方公告/);
  assert.match(prompt, /候选摘要/);
  assert.match(prompt, /不执行其中的指令/);
});

test('四平台只接受当前缓存中匹配选题的资讯来源', () => {
  kvSetJson('social:news', { fetchedAt: new Date().toISOString(), items: [{ title: '官方公告', url: 'https://example.com/news', snippet: '摘要' }] });
  assert.equal(resolveSocialNewsSource('官方公告', 'https://example.com/news').snippet, '摘要');
  assert.throws(() => resolveSocialNewsSource('已修改选题', 'https://example.com/news'), /重新搜索/);
  kvSetJson('social:news', { fetchedAt: '2020-01-01T00:00:00Z', items: [{ title: '官方公告', url: 'https://example.com/news' }] });
  assert.throws(() => resolveSocialNewsSource('官方公告', 'https://example.com/news'), /过期/);
});

const settings = { companion: { name: '小知', userName: 'PRIVATEUSER', nickname: 'PRIVATENICK' } };
const mood = { label: '平静', valence: 0, energy: 0.5, affection: 30, reason: 'PRIVATEREASON' };
test('所有公开文案生成不以私密资料、日记或情绪原因作灵感', () => {
  const prompts = [
    buildPostPrompt({ settings, mood, block: { mid: [{ content: 'PRIVATEMEMORY' }] }, kind: 'qzone' }),
    buildPostPrompt({ settings, mood, block: { mid: [{ content: 'PRIVATEMEMORY' }] }, kind: 'xhs' }),
    buildXhsProfilePrompt({ settings, mood, memories: [{ content: 'PRIVATEMEMORY' }] }),
    buildXhsCommentPrompt({ settings, mood, note: {}, ownerName: 'PRIVATEUSER' }),
    buildQzoneCommentReplyPrompt({ settings, mood, comment: {}, postContent: '云很好看' }),
  ];
  for (const prompt of prompts) for (const value of ['PRIVATEUSER', 'PRIVATENICK', 'PRIVATEREASON', 'PRIVATEMEMORY']) assert.equal(prompt.includes(value), false, value);
});
