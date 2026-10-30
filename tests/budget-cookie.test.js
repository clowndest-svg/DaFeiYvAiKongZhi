import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', `test-budget-cookie-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_NO_BACKUP = '1';
const settingsFile = path.join(dataDir, 'settings.json');
process.env.BIZHI_SETTINGS_FILE = settingsFile;
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    cost: { lowBalanceCny: 5, stopBalanceCny: 1.5, maxDailyCostCny: 3 },
    qq: { enabled: false, botAccount: '123456789' },
    social: { enabled: false, xhsEnabled: false },
    proactive: { enabled: true },
  }),
  'utf8',
);

/* 空间请求都打到这台本地假服务器：Cookie 里没有 p_skey=GOOD 就当被踢回登录页 */
let hits = 0;
let serverMode = 'expired';
const server = http.createServer((req, res) => {
  hits += 1;
  const cookie = String(req.headers.cookie || '');
  const good = serverMode === 'good' || cookie.includes('p_skey=GOOD');
  if (good) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': ['p_skey=ROTATED001; Path=/; Domain=.qq.com', 'skey=ROTATEDSKEY; Path=/; Domain=.qq.com'],
    });
    res.end(JSON.stringify({ code: 0, msglist: [] }));
    return;
  }
  res.writeHead(302, { Location: 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin?ptlang=2052' });
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.QZONE_BASE_URL = `http://127.0.0.1:${server.address().port}`;

const { addCost, kvGet, kvSet, listEvents, closeDb } = await import('../src/db.js');
const { evaluateBudget, writeCostState, readCostState, costBlocked, noteCostSkip, COST_FEATURES } = await import('../src/budget.js');
const qz = await import('../src/channels/qzone.js');
const { Scheduler } = await import('../src/scheduler.js');
const { loadSettings } = await import('../src/config.js');

const settings = loadSettings();

test('余额没读到就照原样跑，不许猜一个数把人停掉', () => {
  const state = evaluateBudget({ balanceCny: null, todayCostCny: 0, settings });
  assert.equal(state.level, 'unknown');
  assert.deepEqual(state.blocked, []);
  assert.match(state.reasons.join(''), /还没读到/);
});

test('到熔断线：所有花钱的动作全停；到警戒线：只停烧钱的那几件，主动找你还留着', () => {
  const stop = evaluateBudget({ balanceCny: 1.0, todayCostCny: 0, settings });
  assert.equal(stop.level, 'stop');
  assert.deepEqual([...stop.blocked].sort(), [...COST_FEATURES].sort(), '熔断要把每个花钱功能都点名');

  const low = evaluateBudget({ balanceCny: 4, todayCostCny: 0, settings });
  assert.equal(low.level, 'low');
  assert.equal(costBlocked('proactive', low), false, '低余额不该连“主动找你”都停');
  for (const feature of ['voice', 'xhsAuto', 'qzoneAuto', 'dream', 'weekly']) {
    assert.equal(costBlocked(feature, low), true, `${feature} 应该先被停掉`);
  }

  const ok = evaluateBudget({ balanceCny: 30, todayCostCny: 0.2, settings });
  assert.equal(ok.level, 'normal');
  assert.deepEqual(ok.blocked, []);
});

test('边界值算哪一档要说清：等于警戒线就省，等于熔断线就停', () => {
  assert.equal(evaluateBudget({ balanceCny: 5, todayCostCny: 0, settings }).level, 'low');
  assert.equal(evaluateBudget({ balanceCny: 5.01, todayCostCny: 0, settings }).level, 'normal');
  assert.equal(evaluateBudget({ balanceCny: 1.5, todayCostCny: 0, settings }).level, 'stop');
  assert.equal(evaluateBudget({ balanceCny: 1.51, todayCostCny: 0, settings }).level, 'low');
});

test('今天花超了自己设的上限，也按停处理（余额充足也一样）', () => {
  const state = evaluateBudget({ balanceCny: 40, todayCostCny: 3, settings });
  assert.equal(state.level, 'stop');
  assert.equal(costBlocked('proactive', state), true);
  assert.match(state.reasons.join(''), /今天已经花了/);
  const under = evaluateBudget({ balanceCny: 40, todayCostCny: 2.9, settings });
  assert.equal(under.level, 'normal', '没到上限就别挡');
});

test('没存过状态时读出来是 unknown，不是“一切正常”', () => {
  kvSet('cost_state', '');
  const state = readCostState();
  assert.equal(state.level, 'unknown');
  assert.deepEqual(state.blocked, []);
});

test('同一个动作一天只播报一次挡了它', () => {
  writeCostState({ level: 'stop', blocked: ['voice'], reasons: ['余额到线'], balanceCny: 1, todayCostCny: 0 });
  assert.equal(noteCostSkip('发语音', '余额到线'), true, '第一次要落下来');
  assert.equal(noteCostSkip('发语音', '余额到线'), false, '同一件事不该反复刷');
  assert.equal(noteCostSkip('写周记', '余额到线'), true, '不同动作各记各的');
  const events = listEvents(40).filter((e) => e.type === 'cost_blocked');
  assert.equal(events.length, 2, `挡下来的动作要看得见，且不许重复：${events.length}`);
});

test('余额掉到线下：调度器自己降级、只提醒一次，并且后面真的挡住动作', async () => {
  kvSet('cost_state', '');
  kvSet('cost_state_checked_at', '');
  let notified = 0;
  const scheduler = new Scheduler({
    llm: { balance: async () => ({ total: 1.0, currency: 'CNY' }) },
    companion: {},
    sendToOwner: async () => {
      notified += 1;
      return true;
    },
  });
  const state = await scheduler.refreshCostState();
  assert.equal(state.level, 'stop');
  assert.equal(notified, 1, '降级要主动跟主人说一声');
  assert.ok(listEvents(30).some((e) => e.type === 'cost_degraded'), '还得留一条事件');

  const again = await scheduler.refreshCostState();
  assert.equal(again.level, 'stop', '第二次拿到的还是同一份状态');
  assert.equal(notified, 1, '20 分钟节流内不该再轰炸一次');

  assert.equal(scheduler.costGate('voice', '发语音'), true, '闸门要真的拦得住');
  assert.equal(scheduler.costGate('proactive', '主动找你'), true, '熔断档连主动也拦');
  assert.equal(scheduler.costGate('不存在的功能'), false, '没点名的功能不许被顺带拦掉');
  scheduler.destroy?.();
});

test('余额读不到就留着原样跑，别把上一次的状态当真', async () => {
  kvSet('cost_state', '');
  kvSet('cost_state_checked_at', '');
  const scheduler = new Scheduler({
    llm: { balance: async () => { throw new Error('401 key 失效'); } },
    companion: {},
    sendToOwner: async () => true,
  });
  const state = await scheduler.refreshCostState();
  assert.equal(state.level, 'unknown');
  assert.equal(scheduler.costGate('voice'), false, '没读数不该拦动作');
});

test('空间 Cookie 过期：先自己从 NapCat 重取一份，取回来就能继续用', async () => {
  qz.saveQzoneCookie('uin=o123456789; skey=abc; p_skey=EXPIRED; p_uin=o123456789');
  kvSet('qzone_cookie_checked_at', '');
  kvSet('qzone_cookie_bad', '');
  kvSet('qzone_cookie_alert_at', '');
  serverMode = 'expired';
  const scheduler = new Scheduler({
    llm: { balance: async () => ({ total: 30 }) },
    companion: {},
    refreshQzoneCookie: () => {
      qz.saveQzoneCookie('uin=o123456789; skey=GOOD; p_skey=GOOD; p_uin=o123456789');
      return Promise.resolve({ uin: '123456789' });
    },
  });
  const result = await scheduler.checkQzoneCookie();
  assert.equal(result.ok, true, `重取成功就该认定还能用：${result.reason || ''}`);
  assert.equal(kvGet('qzone_cookie_bad'), '', '恢复了要把坏标记清掉');
  assert.ok(listEvents(30).some((e) => e.type === 'qzone_cookie_autorenew'), '自动重取要留事件');
  const stored = qz.getQzoneCookie();
  assert.equal(stored.pSkey, 'ROTATED001', '成功那次响应头里的新 p_skey 也应被吸收');
});

test('重取也救不回来：记下原因、提醒主人一次，六小时内不轰炸', async () => {
  qz.saveQzoneCookie('uin=o123456789; skey=abc; p_skey=EXPIRED; p_uin=o123456789');
  kvSet('qzone_cookie_checked_at', '');
  kvSet('qzone_cookie_bad', '');
  kvSet('qzone_cookie_alert_at', '');
  serverMode = 'expired';
  let alerts = 0;
  const scheduler = new Scheduler({
    llm: { balance: async () => ({ total: 30 }) },
    companion: {},
    refreshQzoneCookie: () => Promise.reject(new Error('小号不在线')),
    sendToOwner: async () => {
      alerts += 1;
      return true;
    },
  });
  const first = await scheduler.checkQzoneCookie();
  assert.equal(first.ok, false);
  assert.ok(kvGet('qzone_cookie_bad'), '要落下坏标记，界面才报得出来');
  assert.equal(alerts, 1, '第一次要告诉主人');
  assert.ok(listEvents(30).some((e) => e.type === 'qzone_cookie_expired'));

  kvSet('qzone_cookie_checked_at', '');
  const second = await scheduler.checkQzoneCookie();
  assert.equal(second.ok, false);
  assert.equal(alerts, 1, '6 小时冷却内不该再提醒第二次');
});

test('花费台账真的累加到“今天”，熔断用的就是这个数', () => {
  const before = evaluateBudget({
    balanceCny: 40,
    todayCostCny: 0,
    settings,
  }).level;
  assert.equal(before, 'normal');
  addCost({ kind: 'chat', model: 'mock', promptTokens: 1000, completionTokens: 500, cacheHitTokens: 0, costCny: 3.2 });
  const state = evaluateBudget({ balanceCny: 40, todayCostCny: 3.2, settings });
  assert.equal(state.level, 'stop', '到今天上限就该停');
});

test.after(() => {
  qz.clearQzoneCookie();
  closeDb();
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
