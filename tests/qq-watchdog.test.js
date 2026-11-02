// QQ 断线看门狗的新契约：运行期不碰进程，只观测、只说实话。
// 旧版"每 20 分钟杀一次 NapCat 重启登录"是这次要根除的行为（今天 22 次全空转，还把主人正扫的码换掉了）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-qq-watchdog-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ qq: { enabled: true } }), 'utf8');
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { OneBotChannel } = await import('../src/channels/onebot.js');
const { closeDb, kvGetJson, listEvents } = await import('../src/db.js');

const server = http.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const channel = new OneBotChannel({ server, companion: {} });
// 账号探测走真 ws，测试里不建连：一律"探不到"，正好验证 unknown 不会被当成在线。
channel.sendAction = async () => { throw new Error('测试里没有连接'); };

const fakeClient = { readyState: 1, isAlive: true, ping() {}, on() {}, selfId: '' };

test('刚断开只记账，不动任何进程', () => {
  const result = channel.checkConnectionHealth();
  assert.ok(channel.downSince, '要记下断开时间');
  assert.equal(result.downMinutes, 0);
  assert.ok(channel.recovery.outage, '断连要开一条记录');
  assert.equal(channel.recovery.outage.endedAt, null, '还没连上就闭合了？');
});

test('断了 6 分钟只报警，不再自动重启登录（旧版在这里杀 NapCat）', () => {
  channel.downSince = Date.now() - 6 * 60000;
  const result = channel.checkConnectionHealth();
  assert.ok(result.downMinutes >= 5);
  assert.equal(result.recovered, false, '运行期不许再声称"我自己恢复了"');
  const types = listEvents(50).map((e) => e.type);
  assert.ok(types.includes('qq_down'), '断了 5 分钟以上要在事件里留下"她收不到消息了"');
  assert.ok(!types.includes('qq_login_restart'), '还是自动重启了 NapCat');
  assert.ok(!types.includes('qq_auto_recover'), '还是走了旧的自动恢复');
});

test('断够 10 分钟升级成"需要人工处理"，半小时内不重复刷屏', () => {
  channel.downSince = Date.now() - 11 * 60000;
  channel.checkConnectionHealth();
  channel.checkConnectionHealth();
  channel.checkConnectionHealth();
  const needHelp = listEvents(80).filter((e) => e.type === 'qq_need_human');
  assert.equal(needHelp.length, 1, `需要人工处理的提示应当只有一条，实际 ${needHelp.length} 条`);
  assert.match(needHelp[0].message, /没去重启 NapCat/);
});

test('连回来时把这条断连闭合，并写进 7 天统计', async () => {
  channel.clients.add(fakeClient);
  const result = channel.checkConnectionHealth();
  assert.equal(result.downMinutes, 0);
  assert.equal(channel.downSince, null);
  const log = kvGetJson('qq_outage_log', []);
  assert.ok(Array.isArray(log) && log.length >= 1, '断连闭合后没落库');
  const last = log[log.length - 1];
  assert.ok(last.endedAt && last.minutes >= 1, `断连记录没闭合：${JSON.stringify(last)}`);
  const snapshot = channel.recoverySnapshot();
  assert.equal(snapshot.stats7d.count, log.filter((o) => o.endedAt).length, '界面统计和库里条数对不上');
  assert.equal(snapshot.connected, true);
  // 探不到 get_status 回执时只能报"未确认"，绝不能当成在线（NapCat 有过"假活"故障模型）
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(channel.recovery.account.state, 'unknown', `探测失败却报了：${channel.recovery.account.state}`);
  channel.clients.clear();
});

test('发现新鲜二维码就挂扫码锁；锁定期内界面承诺不再换码', () => {
  const before = channel.recovery.scanLockUntil;
  // 生产代码看的是 paths.root 下的 napcat/cache；这里直接调 noteScanLock 验证锁本身，
  // 文件路径那条理由 tests/qq-recovery.test.js 用真实路径覆盖。
  channel.noteScanLock(15, '测试：刚生成二维码');
  assert.ok(channel.recovery.scanLockUntil > before, '扫码锁没延长');
  assert.ok(channel.scanLocked());
  assert.ok(channel.recoverySnapshot().scanLocked, '快照没带扫码锁状态');
  channel.recovery.scanLockUntil = 0;
  assert.equal(channel.scanLocked(), false);
});

test('我们自己拒掉的握手要留痕（NapCat 敲门被拒≠它没重连）', () => {
  channel.noteRejected('bad token');
  channel.noteRejected('bad token');
  const snapshot = channel.recoverySnapshot();
  assert.equal(snapshot.rejected.count, 2);
  assert.equal(snapshot.rejected.lastReason, 'bad token');
});

test('心跳停了 4 分钟记成"监测中断"，原因不写成睡眠', () => {
  channel.recovery.lastTickAt = Date.now() - 4 * 60000;
  channel.downSince = Date.now() - 20 * 60000;
  channel.recovery.outage = { startedAt: new Date(Date.now() - 20 * 60000).toISOString(), endedAt: null, minutes: 0, cause: 'unknown', autoStarts: 0, scanned: false };
  channel.checkConnectionHealth();
  const gaps = channel.recovery.monitorGaps;
  assert.ok(gaps.length >= 1, '没记下监测中断');
  assert.ok(gaps[gaps.length - 1].minutes >= 3);
  assert.equal(channel.recovery.outage.cause, 'monitor_gap');
  assert.ok(!/睡眠/.test(channel.recoverySnapshot().policy), '策略文案里不许把猜测写成结论');
});

test.after(() => {
  channel.destroy();
  server.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
