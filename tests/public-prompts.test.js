import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPostPrompt, buildXhsProfilePrompt, buildXhsCommentPrompt, buildQzoneCommentReplyPrompt } from '../src/prompt.js';

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
