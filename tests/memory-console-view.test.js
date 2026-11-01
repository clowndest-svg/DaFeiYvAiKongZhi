// 「记忆」这一屏的判据：控制台必须看到全部记忆，而不是这次进提示词的切片；
// 日记 / 周记 / 交接信 是三件不同的东西，不许再混在一个「信」标签里。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addMemory, closeDb } from '../src/db.js';
import { getMemoryOverview, memoryLayerCounts } from '../src/memory.js';
import { paths } from '../src/config.js';

test.after(closeDb);

const html = fs.readFileSync(path.join(paths.root, 'web', 'index.html'), 'utf8').split(String.fromCharCode(13)).join(String.fromCharCode(10));
const app = fs.readFileSync(path.join(paths.root, 'web', 'app.js'), 'utf8').split(String.fromCharCode(13)).join(String.fromCharCode(10));

test('重点记忆超过提示词切片条数时，控制台仍然全部返回，角标用库里的真数', () => {
  for (let i = 0; i < 13; i += 1) {
    addMemory({ layer: 'mid', content: `第 ${i} 件不同的事：编号 ${1000 + i} 的独立条目，彼此不重复。`, importance: 3, mergeSimilar: false });
  }
  const overview = getMemoryOverview({ query: '' });
  assert.ok(overview.mid.length >= 13, `只返回了 ${overview.mid.length} 条 —— 又拿提示词切片当完整列表了`);
  assert.equal(overview.counts.mid, memoryLayerCounts().mid);
  assert.ok(overview.counts.mid >= 13, 'counts 没给出真实条数');
  assert.ok(overview.counts.mid > 10, 'counts 若等于 10，说明还在用 retrieveCount 的切片数当总数');
});

test('日记、周记、交接信按 kind 分开，周记里小红书那一份要能认出来', () => {
  fs.mkdirSync(paths.daily, { recursive: true });
  fs.mkdirSync(paths.weekly, { recursive: true });
  fs.writeFileSync(path.join(paths.daily, 'DAILY-2025-01-02.md'), '那天的小事。');
  fs.writeFileSync(path.join(paths.weekly, 'WEEKLY-2025-01-05.md'), '她自己写的一周。');
  fs.writeFileSync(path.join(paths.weekly, 'XHSWEEK-2025-01-05.md'), '小红书那一周。');
  const kinds = getMemoryOverview({ query: '' }).letters.map((item) => `${item.kind}:${item.name}`);
  assert.ok(kinds.includes('日记:DAILY-2025-01-02.md'), `日记没归到日记：${kinds.join(' | ')}`);
  assert.ok(kinds.includes('周记:WEEKLY-2025-01-05.md'), '周记没归到周记');
  assert.ok(kinds.includes('周记:XHSWEEK-2025-01-05.md'), '小红书周记丢了');
});

test('标签栏把六类分开，长期记忆不再和周记挤一个名字', () => {
  for (const tab of ['core', 'mid', 'long', 'diary', 'weekly', 'letters']) {
    assert.ok(html.includes(`data-tab="${tab}"`), `少了 ${tab} 标签`);
  }
  assert.ok(!/长期 \/ 周记/.test(html), '「长期 / 周记」这种混称还在');
  assert.match(html, /data-tab="letters">\s*交接信/, 'letters 标签还叫「信」，里面其实混着日记和周记');
});

test('前端按 kind 过滤文件类标签，并把 DAILY-/XHSWEEK- 翻成人话', () => {
  assert.match(app, /const FILE_KIND = \{ diary: '日记', weekly: '周记', letters: '交接信' \}/);
  assert.match(app, /function fileTitle/);
  assert.match(app, /XHSWEEK/, '小红书周记要单独标来源');
  assert.match(app, /\$\{date\}那天/, '日记标题要能读出日期');
});

test('私信回复表单默认收起，点了某条私信才展开', () => {
  assert.match(html, /<details class="dm-reply">/, '回复私信的表单又摊在页面上了');
  assert.match(app, /document\.querySelector\('\.dm-reply'\)/, '点私信某一行没有替用户展开回复表单');
});

test('睡前反思收成一行可展开，不再把整段铺在列表上方', () => {
  assert.match(html, /<details class="dream-note">/);
  assert.ok(html.includes('id="dreamSummary"'), '展开前的那一行摘要没了');
  assert.ok(!/睡前想过：\$\{dream\.dream\}/.test(app), '整段反思又被塞进一行文本里了');
});
