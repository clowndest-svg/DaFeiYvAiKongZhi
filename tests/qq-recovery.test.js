// 开机自愈判据 + "运行期不碰进程"的结构闸门。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-qq-recovery-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
const settingsFile = path.join(dataDir, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ qq: { enabled: true } }), 'utf8');
process.env.BIZHI_SETTINGS_FILE = settingsFile;

const { OneBotChannel, shouldBootStartNapCat } = await import('../src/channels/onebot.js');
const { closeDb } = await import('../src/db.js');
const { countQqProcesses } = await import('../src/processes.js');

const ok = {
  enabled: true,
  connected: false,
  everConnected: false,
  withinWindow: true,
  qqProcessState: 'absent',
  launcherCount: 0,
};

test('开机自愈：四个条件同时成立才启动，少一条都不动', () => {
  assert.equal(shouldBootStartNapCat(ok).start, true);
  assert.equal(shouldBootStartNapCat({ ...ok, alreadyTried: true }).start, false, '一个进程生命周期只能试一次');
  assert.equal(shouldBootStartNapCat({ ...ok, enabled: false }).start, false, '通道关着还要启动');
  assert.equal(shouldBootStartNapCat({ ...ok, connected: true }).start, false, '已经连上还要启动');
  assert.equal(shouldBootStartNapCat({ ...ok, everConnected: true }).start, false, '连过一次就不算"没起来"');
  assert.equal(shouldBootStartNapCat({ ...ok, withinWindow: false }).start, false, '过了 3 分钟窗口还补启动');
  assert.equal(shouldBootStartNapCat({ ...ok, qqProcessState: 'present' }).start, false, 'QQ 还在就要抢着启动');
  assert.equal(shouldBootStartNapCat({ ...ok, launcherCount: 1 }).start, false, '启动器还在就要再起一个');
});

test('查不到 QQ 进程状态时必须不动手（unknown 绝不能当成"没在跑"）', () => {
  for (const state of ['unknown', '', 'error', undefined]) {
    const decision = shouldBootStartNapCat({ ...ok, qqProcessState: state });
    assert.equal(decision.start, false, `状态 ${JSON.stringify(state)} 被判成了可以启动`);
    assert.match(decision.reason, /查不到|不动/);
  }
  // 隔离测试/非 Windows 下探测函数就应当返回 unknown，而不是 0 个进程
  const probe = countQqProcesses();
  assert.equal(probe.state, 'unknown', `测试环境里进程探测不该给结论：${JSON.stringify(probe)}`);
  assert.equal(probe.count, null);
});

test('运行期代码里不许再有碰进程的路径（旧版每 20 分钟杀一次就是这么来的）', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'channels', 'onebot.js'), 'utf8');
  for (const banned of ['startNapCat', 'stopOwned', 'taskkill', 'killNapCatTree', 'execFileSync']) {
    assert.ok(!source.includes(banned), `onebot.js 里还留着 ${banned}：通道不该控制进程`);
  }
  const entry = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  assert.ok(!entry.includes('onNeedRecover'), 'index.js 还把自动恢复挂回通道上');
  assert.match(entry, /shouldBootStartNapCat/, '开机自愈没走那个可单测的判据函数');
});

test('发现新鲜二维码 → 挂扫码锁；码是旧的 → 不挂锁；文件不存在 → 不崩', async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const qrFile = path.join(dataDir, 'qr-fake.png');
  const channel = new OneBotChannel({ server, companion: {}, qrPath: qrFile });
  try {
    channel.refreshQrSignal();
    assert.equal(channel.recovery.qrSeenAt, null, '没有二维码文件却记了时间');

    fs.writeFileSync(qrFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    channel.refreshQrSignal();
    assert.ok(channel.recovery.qrSeenAt, '刚写出来的码没被发现');
    assert.ok(channel.scanLocked(), '发现新码却没挂扫码锁');

    channel.recovery.scanLockUntil = 0;
    channel.recovery.qrMtime = null;
    const old = new Date(Date.now() - 30 * 60000);
    fs.utimesSync(qrFile, old, old);
    channel.refreshQrSignal();
    assert.equal(channel.scanLocked(), false, '半小时前的旧码还挂锁，等于承诺了一个不存在的扫码窗口');

    fs.rmSync(qrFile, { force: true });
    assert.doesNotThrow(() => channel.refreshQrSignal());
  } finally {
    channel.destroy();
    server.close();
  }
});

test('NapCat 登录被拒要能读出来（ErrType/ErrCode 埋在 napcat.out 里，界面不该靠猜）', async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const channel = new OneBotChannel({ server, companion: {} });
  try {
    const { paths } = await import('../src/config.js');
    fs.mkdirSync(paths.logs, { recursive: true });
    const file = path.join(paths.logs, 'napcat.out');
    fs.writeFileSync(file, [
      '11-03 01:10:58 warn 二维码已保存',
      '11-03 01:12:59 error [Core] [Login] Login Error,ErrType:  1  ErrCode: 3',
      '11-03 01:14:59 error [Core] [Login] Login Error,ErrType:  1  ErrCode: 3',
    ].join('\n'), 'utf8');
    channel.loginLogAt = 0;
    const health = channel.napcatLoginHealth();
    assert.equal(health.count, 2, `登录错误条数不对：${health.count}`);
    assert.equal(health.errType, 1);
    assert.equal(health.errCode, 3);
    // 30 秒缓存：改文件后不该立刻重读（避免状态轮询狂读 1.7MB 日志）
    fs.appendFileSync(file, '\n11-03 01:16:59 error Login Error,ErrType: 1 ErrCode: 9\n');
    assert.equal(channel.napcatLoginHealth().count, 2, '缓存没生效，状态轮询会反复读日志');
    channel.loginLogAt = 0;
    assert.equal(channel.napcatLoginHealth().errCode, 9, '缓存过期后应读到最新一条');
  } finally {
    channel.destroy();
    server.close();
  }
});

test('通道连着但账号离线，要落一条可追溯的事件（这种"假活"之前只存在内存里）', async () => {
  const { listEvents } = await import('../src/db.js');
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const channel = new OneBotChannel({ server, companion: {} });
  try {
    // 伪装一次成功的 get_status：账号离线
    channel.sendAction = async () => ({ status: 'ok', data: { online: false, good: true } });
    channel.accountProbeAt = 0;
    channel.probeAccount();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const events = listEvents(30).filter((e) => e.type === 'qq_account_offline');
    assert.equal(events.length, 1, `账号离线没落事件（${events.length} 条）`);
    // 连续两次离线只记一条，别刷屏
    channel.accountProbeAt = 0;
    channel.probeAccount();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(listEvents(30).filter((e) => e.type === 'qq_account_offline').length, 1, '离线事件重复刷屏');
  } finally {
    channel.destroy();
    server.close();
  }
});

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
