import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', `test-xhs-dm-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_NO_BACKUP = '1';
process.env.LLM_MOCK = '1';
const settingsFile = path.join(dataDir, 'settings.json');
process.env.BIZHI_SETTINGS_FILE = settingsFile;

function writeSettings(overrides = {}) {
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      social: {
        xhsEnabled: true,
        xhsDmReply: true,
        xhsDmMaxPerDay: 5,
        xhsDmMaxPerTarget: 1,
        xhsDailyCommentMax: 6,
        xhsDailyReplyMax: 15,
        xhsDailyActionMax: 0,
        xhsHourlyActionMax: 20,
        ...overrides,
      },
      qq: { enabled: false },
    }),
    'utf8',
  );
}

writeSettings();

const { kvGet, kvSet, listEvents, closeDb } = await import('../src/db.js');
const actions = await import('../src/channels/xhs-actions.js');
const { sendXhsDirectMessage } = await import('../src/channels/xhs.js');

function todayKey(prefix) {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  return `${prefix}:${day}`;
}

test('私信开关没打开就是不发，并且说清楚是哪里的关', () => {
  writeSettings({ xhsDmReply: false });
  const gate = actions.canSendXhsDm('小雅');
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /允许回私信/);
});

test('同一个人一天只回一条：第二条被挡，换成别的人还能回', () => {
  writeSettings({ xhsDmMaxPerDay: 5, xhsDmMaxPerTarget: 1 });
  kvSet(todayKey('xhs_dm_day'), '0');
  const first = actions.canSendXhsDm('小雅');
  assert.equal(first.ok, true, `第一次应该放行：${first.reason || ''}`);
  actions.noteXhsDmSent('小雅', first.keys);
  const second = actions.canSendXhsDm('小雅');
  assert.equal(second.ok, false, '同一个人第二条必须挡住');
  assert.match(second.reason, /小雅/);
  assert.match(second.reason, /每天最多 1 条/);
  assert.equal(actions.canSendXhsDm('阿哲').ok, true, '换个人不该被上一个人拖累');
});

test('全账号每天封顶：到数以后谁来都挡', () => {
  writeSettings({ xhsDmMaxPerDay: 2, xhsDmMaxPerTarget: 5 });
  kvSet(todayKey('xhs_dm_day'), '2');
  const gate = actions.canSendXhsDm('路人甲');
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /私信已达上限（2 条）/);
});

test('风控冷却中不许回私信（读得到也要停手）', () => {
  writeSettings({ xhsDmMaxPerDay: 5, xhsDmMaxPerTarget: 5 });
  kvSet(todayKey('xhs_dm_day'), '0');
  actions.triggerXhsCooldown(6, '访问频繁');
  const gate = actions.canSendXhsDm('小雅');
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /冷却/);
  kvSet('xhs_cooldown_until', '');
});

test('私信要计入“今天所有动作加起来”的总数（别让它成了漏计的那一格）', () => {
  writeSettings({ xhsDmMaxPerDay: 9, xhsDmMaxPerTarget: 9, xhsDailyActionMax: 3 });
  kvSet(todayKey('xhs_dm_day'), '0');
  kvSet(todayKey('xhs_comment_day'), '1');
  kvSet(todayKey('xhs_reply_day'), '1');
  const first = actions.canSendXhsDm('小雅');
  assert.equal(first.ok, true, '1+1 再加一条私信还没到 3');
  actions.noteXhsDmSent('小雅', first.keys);
  assert.equal(Number(kvGet(todayKey('xhs_dm_day'), '0')), 1, '发成功要真的记进当天私信数');
  const next = actions.canSendXhsDm('阿哲');
  assert.equal(next.ok, false, '评论 1 + 回复 1 + 私信 1 已经等于总数上限 3');
  assert.match(next.reason, /加起来/);
});

test('额度状态给界面看得懂：总数、上限、每个人今天回了几条', () => {
  writeSettings({ xhsDmMaxPerDay: 4, xhsDmMaxPerTarget: 2 });
  kvSet(todayKey('xhs_dm_day'), '1');
  const status = actions.xhsDmStatus(['小雅', '阿哲', '小雅']);
  assert.equal(status.enabled, true);
  assert.equal(status.todayTotal, 1);
  assert.equal(status.dailyMax, 4);
  assert.equal(status.perTargetMax, 2);
  assert.deepEqual(Object.keys(status.perTargetUsed).sort(), ['小雅', '阿哲'], '重复的人名不该出现两格');
});

test('想发出去的那句话碰到私密称呼，浏览器都不用打开就被拦下', async () => {
  await assert.rejects(
    () => sendXhsDirectMessage({ target: '小雅', text: '这是我男朋友让我回的' }),
    /不能发/,
    '私密称呼应在动浏览器之前就挡掉',
  );
  const event = listEvents(30).find((e) => e.type === 'xhs_dm_gate');
  assert.ok(event, '拦下要留一条能看见的事件');
  assert.match(event.data.reason, /男朋友/);
});

test('空话和超长话直接拒绝，不去碰页面', async () => {
  await assert.rejects(() => sendXhsDirectMessage({ target: '小雅', text: '   ' }), /空的/);
  await assert.rejects(() => sendXhsDirectMessage({ target: '小雅', text: '好'.repeat(201) }), /200 字/);
});

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
