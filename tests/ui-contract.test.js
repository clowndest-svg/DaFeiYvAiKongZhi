import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CR = String.fromCharCode(13);
const BS = String.fromCharCode(92);
// 判据一律按 LF 匹配，免得样式文件的行尾影响正则
const read = (name) => fs.readFileSync(path.join(ROOT, 'web', name), 'utf8').split(CR).join('');
const CSS = read('style.css');
const HTML = read('index.html');
const APP = read('app.js');

const escapeRe = (text) => text.replace(/[^a-zA-Z0-9_]/g, (ch) => BS + ch);
// 传裸选择器（不带左花括号），并要求它同一行紧跟花括号：
// 否则 `.msg.user` 会先撞上 `.msg:not(.user) + .msg.user` 这类兄弟选择器，读到别人的规则体。
const rule = (selector) => {
  const pattern = '^' + escapeRe(selector) + '[ ' + BS + 't]*' + BS + '{';
  const match = new RegExp(pattern, 'm').exec(CSS);
  assert.ok(match, `找不到规则 ${selector}`);
  const start = match.index + match[0].length - 1;
  const end = CSS.indexOf('}', start);
  return CSS.slice(start, end + 1);
};
const blockFrom = (marker) => {
  const at = CSS.lastIndexOf(marker);
  assert.ok(at >= 0, `找不到 ${marker}`);
  return CSS.slice(at);
};

test('设计 token 成了体系：间距、字阶、表面层级、控件高度都有变量', () => {
  for (const token of ['--space-1', '--space-4', '--space-7', '--font-xs', '--font-md', '--font-2xl',
    '--surface-1', '--surface-2', '--surface-3', '--bubble-her', '--bubble-me',
    '--radius-sm', '--radius-md', '--header-h', '--rail-h', '--control-h', '--avatar', '--chat-max']) {
    assert.ok(CSS.includes(token + ':'), `缺 token ${token}`);
  }
  assert.match(CSS, /color-scheme: dark/);
});

test('次要文字用实色，不用半透明白：否则对比度会随背景漂移', () => {
  const root = rule(':root');
  assert.match(root, /--muted: #[0-9a-f]{6}/);
  assert.match(root, /--faint: #[0-9a-f]{6}/);
  assert.doesNotMatch(root, /--(?:muted|faint): rgba/, '不许退回 rgba 半透明文字色');
});

test('聊天气泡是 Grid 双列：头像与气泡顶对齐，列序靠 grid 不靠 row-reverse', () => {
  const msg = rule('.msg');
  assert.match(msg, /display: grid/);
  assert.match(msg, /grid-template-columns: var\(--avatar\) minmax\(0, 1fr\)/);
  assert.match(msg, /align-items: start/, '顶对齐，不能再把头像甩到气泡底下');
  assert.doesNotMatch(msg, /align-items: flex-end/);
  assert.match(rule('.msg.user'), /grid-template-columns: minmax\(0, 1fr\) var\(--avatar\)/);
  assert.doesNotMatch(CSS, /\.msg\.user \{ flex-direction: row-reverse/);
  assert.match(rule('.msg-avatar'), /align-self: start/);
  assert.match(rule('.bubble-wrap'), /max-width: min\(76%, var\(--chat-max\)\)/);
  assert.match(rule('.msg.user .bubble-wrap'), /grid-column: 1/);
});

test('连续同一人的消息收紧间距，头像留位不隐藏（防气泡左右跳）', () => {
  assert.match(CSS, /\.msg \+ \.msg \{ margin-top: 6px; \}/);
  const grouping = blockFrom('.msg.user + .msg.user .msg-avatar,').slice(0, 220);
  assert.match(grouping, /visibility: hidden/);
  assert.doesNotMatch(grouping, /display: none/);
});

test('toast 挪到顶部通知轨，不再压在输入区、保存栏和底部导航上', () => {
  const toast = rule('.toast');
  assert.match(toast, /top: calc\(var\(--header-h\)/);
  assert.doesNotMatch(toast, /bottom:/, 'toast 不许再锚在底部');
  assert.match(toast, /pointer-events: none/, '提示不能挡住点击');
});

test('设置页分区跳转是换行而不是横向滚动，窄屏每个都点得到', () => {
  const jump = rule('.settings-jump');
  assert.match(jump, /flex-wrap: wrap/);
  assert.doesNotMatch(jump, /overflow-x: auto/, '横向滚动会把链接推到看不见的地方');
});

test('控件有统一最小可点尺寸，勾选框整行都能点', () => {
  assert.match(rule('button'), /min-height: var\(--control-h\)/);
  assert.match(rule('input, textarea, select'), /min-height: var\(--control-h\)/);
  assert.match(rule('.settings-grid label.check, .check'), /min-height: var\(--control-h\)/);
  assert.match(rule('input[type=checkbox], input[type=radio]'), /width: 18px/);
});

test('窄屏给滚动视图留底部净空，最后一行不会被浮动导航吃掉', () => {
  const block = blockFrom('@media (max-width: 860px)');
  assert.match(block, /\.view \{ padding-bottom: calc\(var\(--rail-h\) \+ 30px \+ env\(safe-area-inset-bottom, 0px\)\); \}/);
  assert.match(block, /#view-chat\.active \{ padding-bottom: 0; \}/, '聊天页自己滚，不能再叠一层底部留白');
  assert.match(block, /\.save-bar \{ bottom: calc\(var\(--rail-h\)/, '保存栏要让开底部导航');
});

test('路径这类必须读全的文本允许换行，不用省略号藏起来', () => {
  assert.match(rule('.stat-row code'), /overflow-wrap: anywhere/);
  assert.doesNotMatch(rule('.stat-row code'), /text-overflow: ellipsis/);
  const code = rule('code');
  assert.match(code, /overflow-wrap: anywhere/);
  assert.doesNotMatch(code, /word-break: break-all/, 'break-all 会把 CONSOLE_PASSWORD 从中间拆成两截');
});

test('陪伴视图共用同一套 token，不可逆操作改用暖金而不是高饱和粉', () => {
  assert.doesNotMatch(rule('.quick-grid .warn'), /255, 122, 144/);
  assert.match(rule('.quick-grid .warn'), /color: var\(--warn\)/);
  assert.match(blockFrom('@media (max-width: 900px)'), /\.presence-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
});

test('聊天滚动节点仍然是 #messages，JS 的自动滚底没被换掉', () => {
  assert.match(APP, /const box = \$\('#messages'\)/);
  assert.match(APP, /box\.scrollHeight - box\.scrollTop - box\.clientHeight/);
  assert.match(rule('.messages'), /overflow-y: auto/);
  assert.equal(HTML.split('class="messages"').length - 1, 1, '消息容器只能有一个，别多套一层滚动容器');
});

test('页面仍然没有内联样式（CSP 会整条忽略它们）', () => {
  const inline = [...HTML.matchAll(/style="[^"]*"/g)].map((m) => m[0]);
  assert.deepEqual(inline, [], `内联样式在 CSP 下不生效：${inline.join(' ')}`);
});
