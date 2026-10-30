import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-xhs-guard-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    social: {
      enabled: false,
      xhsEnabled: true,
      xhsAutoBrowse: false,
      xhsDailyActionMax: 12,
      xhsDailyCommentMax: 4,
      xhsHourlyActionMax: 2,
    },
  }),
  'utf8',
);
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { triggerXhsCooldown, xhsCooldownUntil } = await import('../src/channels/xhs-actions.js');
const { kvGet, kvSet, closeDb } = await import('../src/db.js');
const { loadSettings } = await import('../src/config.js');

test('风控冷却：一旦触发，所有动作（包括手动）都被挡住并写事件', async () => {
  const { processXhsExplore } = await import('../src/channels/xhs-actions.js');
  assert.equal(xhsCooldownUntil(), '');
  triggerXhsCooldown(6, '测试：访问频繁');
  assert.ok(xhsCooldownUntil(), '要记下冷却截止时间');
  const result = await processXhsExplore({ llm: {}, force: true });
  assert.match(result.reason, /风控冷却/);
  const { listEvents } = await import('../src/db.js');
  assert.ok(listEvents(20).some((e) => e.type === 'xhs_cooldown'), '冷却要写事件让人看见');
});

test('冷却过期后自动恢复；总动作上限单独卡', async () => {
  const { canAct } = await import('../src/channels/xhs-actions.js');
  kvSet('xhs_cooldown_until', new Date(Date.now() - 1000).toISOString());
  const open = canAct('comment');
  assert.ok(!/风控冷却/.test(open.reason || ''), '过期后不该再被冷却挡住');
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  kvSet(`xhs_comment_day:${day}`, '12');
  const capped = canAct('comment');
  assert.match(capped.reason, /上限/, '总数到顶要单独拦：' + JSON.stringify(capped));
  assert.equal(loadSettings().social.xhsDailyActionMax, 12);
  kvSet(`xhs_comment_day:${day}`, '1');
  const ok = canAct('comment');
  assert.equal(ok.ok, true, '没到上限就放行');
});

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
});
