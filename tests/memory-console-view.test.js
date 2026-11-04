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

test('列表筛选用的 kind 必须就是后端发出来的那几个（角标有数、列表空着就是这么来的）', () => {
  fs.mkdirSync(paths.weekly, { recursive: true });
  fs.mkdirSync(paths.letters, { recursive: true });
  fs.writeFileSync(path.join(paths.weekly, 'WEEKLY-2025-03-09.md'), '她自己写的一周。');
  fs.writeFileSync(path.join(paths.letters, 'HANDOVER-2025-03-09.md'), '给未来自己的信。');
  const real = new Set(getMemoryOverview({ query: '' }).letters.map((item) => item.kind));
  assert.ok(real.has('周记'), '后端这周就没发过「周记」这个 kind，判据要换个方向查');
  // FILE_KIND 是前端唯一的口径来源：标签页 -> 后端 kind
  const mapLine = /const FILE_KIND = \{([^}]+)\}/.exec(app);
  assert.ok(mapLine, '前端没有 FILE_KIND 这张口径表');
  const map = {};
  for (const pair of mapLine[1].split(',')) {
    const m = /(\w+):\s*'([^']+)'/.exec(pair.trim());
    if (m) map[m[1]] = m[2];
  }
  assert.equal(map.weekly, '周记', 'FILE_KIND.weekly 不是后端那个 kind');
  // 每一处 fileRows(...) 调用都要落到真 kind 上：写英文 'weekly' 会让角标显示 3 条、列表空着。
  const calls = [...app.matchAll(/(?<!function )fileRows\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 2, `只找到 ${calls.length} 处筛选调用，判据没覆盖到`);
  for (const arg of calls) {
    const literal = /^'([^']+)'$/.exec(arg);
    const keyed = /^FILE_KIND\.(\w+)$/.exec(arg);
    // FILE_KIND[state.memoryTab] 这种动态取值：整张表的值都必须是后端真发出来的 kind，
    // 否则任何一页都可能筛出空列表——这正是角标有数、列表空着的那种错。
    const resolved = literal ? literal[1] : keyed ? map[keyed[1]] : /^FILE_KIND\[[^\]]+\]$/.test(arg) ? 'ALL' : null;
    assert.ok(resolved, `fileRows(${arg}) 的参数不是可核对的口径`);
    if (resolved === 'ALL') {
      for (const [tab, kind] of Object.entries(map)) assert.ok(real.has(kind), `FILE_KIND.${tab} 的「${kind}」后端根本不发`);
      continue;
    }
    assert.ok(real.has(resolved), `fileRows(${arg}) 用的「${resolved}」后端根本不发，列表会永远空着`);
  }
  // 角标和列表必须同口径：三个文件类标签都过一遍
  for (const tab of ['diary', 'weekly', 'letters']) {
    assert.ok(app.includes(`$('#count${tab[0].toUpperCase()}${tab.slice(1)}')`), `${tab} 的角标没渲染`);
    assert.ok(real.has(map[tab]), `${tab} 角标用的 kind「${map[tab]}」不是后端口径`);
  }
});
