// 花费闸门的判据。这里钉的是"名单"和"消费点"必须两边对上——
// 漏注册会让熔断线形同虚设（X 自动互动就一直没进名单，余额 3.61 元还在照常花钱），
// 注册了没人查则是名单上写着暂停、实际没人执行（search 就是这样）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', `test-budget-gate-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_NO_BACKUP = '1';
const settingsFile = path.join(dataDir, 'settings.json');
process.env.BIZHI_SETTINGS_FILE = settingsFile;
fs.writeFileSync(settingsFile, JSON.stringify({
  cost: { lowBalanceCny: 5, stopBalanceCny: 1.5, maxDailyCostCny: 3 },
  search: { enabled: true, dailyMax: 20 },
  qq: { enabled: false },
  social: { enabled: false, xhsEnabled: false, xEnabled: false },
  proactive: { enabled: false },
}), 'utf8');

const { COST_FEATURES, LOW_BALANCE_PAUSE, evaluateBudget, readCostState } = await import('../src/budget.js');
const { kvSetJson, kvGet, closeDb } = await import('../src/db.js');
const { searchWeb } = await import('../src/search.js');
const { Scheduler } = await import('../src/scheduler.js');

test.after(closeDb);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

// 只看真正的代码行：注释里写 costBlocked('x') 不该被当成消费点。
function codeLines() {
  return walk(path.join(ROOT, 'src'))
    .filter((file) => file.endsWith('.js'))
    .flatMap((file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line, index) => ({
      file: path.relative(ROOT, file), line: index + 1, text: line.replace(/\/\/.*$/, ''),
    })));
}

const consumed = new Set();
for (const row of codeLines()) {
  for (const match of row.text.matchAll(/costBlocked\(\s*'([A-Za-z]+)'|costGate\(\s*'([A-Za-z]+)'/g)) {
    consumed.add(match[1] || match[2]);
  }
}

test('每个消费点都在花费名单里：漏一个就等于熔断线对它不生效', () => {
  const strays = [...consumed].filter((feature) => !COST_FEATURES.includes(feature));
  assert.deepEqual(strays, [], `这些功能在查闸门，但闸门名单里没有它们：${strays.join('、')}`);
});

test('名单上每个功能都必须真的有人查：不然写的是"暂停"，做的是"没停"', () => {
  const idle = COST_FEATURES.filter((feature) => !consumed.has(feature));
  assert.deepEqual(idle, [], `这些功能注册了却没人查：${idle.join('、')}`);
});

test('低余额暂停清单必须是花费名单的子集', () => {
  const strays = LOW_BALANCE_PAUSE.filter((feature) => !COST_FEATURES.includes(feature));
  assert.deepEqual(strays, [], `低余额清单里有没注册的功能：${strays.join('、')}`);
});

test('余额低时 X 自动互动和小红书/空间一样停下来，但回他、查资料照旧', () => {
  const settings = { cost: { lowBalanceCny: 5, stopBalanceCny: 1.5, maxDailyCostCny: 3 } };
  const low = evaluateBudget({ balanceCny: 3.61, todayCostCny: 0, settings });
  assert.equal(low.level, 'low');
  for (const feature of ['xhsAuto', 'xAuto', 'qzoneAuto', 'voice']) {
    assert.ok(low.blocked.includes(feature), `余额 3.61 元时 ${feature} 应该停：自动运营不能只有小红书和空间停`);
  }
  for (const feature of ['search', 'look', 'proactive']) {
    assert.ok(!low.blocked.includes(feature), `${feature} 是跟他互动用的，低余额不该停`);
  }
});

test('余额到熔断线或当天花超上限时，连搜索和看图一起停', () => {
  const settings = { cost: { lowBalanceCny: 5, stopBalanceCny: 1.5, maxDailyCostCny: 3 } };
  for (const state of [
    evaluateBudget({ balanceCny: 1.0, todayCostCny: 0, settings }),
    evaluateBudget({ balanceCny: 99, todayCostCny: 3.2, settings }),
  ]) {
    assert.equal(state.level, 'stop');
    for (const feature of ['search', 'look', 'xAuto']) {
      assert.ok(state.blocked.includes(feature), `到线时 ${feature} 必须停，否则"上限"只是个数字`);
    }
  }
});

test('到线后联网搜索直接返回花费熔断，不会先发一次请求再报错', async () => {
  kvSetJson('cost_state', { balanceCny: 0.5, at: new Date().toISOString() });
  assert.ok(readCostState().blocked.includes('search'), '种子没生效：读到的状态里 search 还是通的');
  const result = await searchWeb('今天的天气怎么样');
  assert.equal(result.ok, false);
  assert.equal(result.costBlocked, true);
  assert.ok(!result.items?.length, '被熔断就不该带任何结果回来');
});

test('读余额失败不能记成"刚核查过"：否则旧读数会再压住一个窗口', async () => {
  kvSetJson('cost_state', { balanceCny: 0.5, at: new Date().toISOString() });
  const { kvSet } = await import('../src/db.js');
  kvSet('cost_state_checked_at', new Date(Date.now() - 30 * 60000).toISOString());
  const scheduler = new Scheduler({
    llm: { balance: async () => { throw new Error('upstream down'); } },
    companion: {},
  });
  await scheduler.refreshCostState();
  const elapsed = Date.now() - new Date(kvGet('cost_state_checked_at')).getTime();
  assert.ok(elapsed >= 2 * 60000, `失败后把"上次核查"记成了现在（${Math.round(elapsed / 60000)} 分钟前）：下一轮会被节流挡住，继续拿旧读数做决定`);
});
