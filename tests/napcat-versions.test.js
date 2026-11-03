// QQ 会自动升级 → 版本对账的判据：能不能发现、发现后说不说得清、查不到时老不老实报"未测"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-napcat-versions-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_SETTINGS_FILE = path.join(dataDir, 'settings.json');

const v = await import('../src/napcat-versions.js');
const { kvGetJson, listEvents, closeDb } = await import('../src/db.js');

const HOUR = 3600000;

function fakeRoot(tag) {
  const root = fs.mkdtempSync(path.join(dataDir, 'root-'));
  fs.mkdirSync(path.join(root, 'napcat'), { recursive: true });
  if (tag) {
    fs.writeFileSync(path.join(root, 'napcat', '.napcat-release'), JSON.stringify({ tag, at: '2026-11-03T06:29:00.114Z' }), 'utf8');
  }
  return root;
}

function fakeQqDir(entries) {
  const dir = fs.mkdtempSync(path.join(dataDir, 'qq-'));
  const versions = path.join(dir, 'versions');
  fs.mkdirSync(versions, { recursive: true });
  for (const entry of entries) {
    const full = path.join(versions, entry);
    if (entry.endsWith('.zip')) fs.writeFileSync(full, 'x', 'utf8');
    else fs.mkdirSync(full, { recursive: true });
  }
  return dir;
}

function countType(type) {
  return listEvents(500).filter((e) => e.type === type).length;
}

test('版本号比对：带不带 v 都比、认不出格式返回 null、相等返回 0', () => {
  assert.equal(v.compareVersions('v4.18.42', 'v4.18.41'), 1);
  assert.equal(v.compareVersions('4.18.42', 'v4.19.0'), -1);
  assert.equal(v.compareVersions('v4.18.42', '4.18.42'), 0);
  assert.equal(v.compareVersions('9.9.36-0', '9.9.9-0'), 1, '两位数小版本不能被当成字符串比');
  assert.equal(v.compareVersions('latest', 'v4.18.42'), null);
  assert.equal(v.compareVersions('', 'v1.0.0'), null);
});

test('升级结论：只有真查到更新版才说"要升"，查不到一律 unknown', () => {
  assert.equal(v.decideUpgrade({ napcatInstalled: 'v4.18.42', napcatLatest: 'v4.18.43' }).needsUpgrade, true);
  assert.equal(v.decideUpgrade({ napcatInstalled: 'v4.18.43', napcatLatest: 'v4.18.42' }).needsUpgrade, false);
  assert.equal(v.decideUpgrade({ napcatInstalled: 'v4.18.42', napcatLatest: 'v4.18.42' }).needsUpgrade, false);
  assert.equal(v.decideUpgrade({ napcatInstalled: '', napcatLatest: 'v4.18.43' }).needsUpgrade, 'unknown', '本地没记录就猜不了');
  assert.equal(v.decideUpgrade({ napcatInstalled: 'v4.18.42', napcatLatest: '' }).needsUpgrade, 'unknown', '官方没查到就不许报警');
});

test('QQ 安装目录：已装版本和"已下载待装"分开，倒序，杂项忽略', () => {
  const dir = fakeQqDir(['9.9.36-0', '9.9.37-0', '9.9.37-0.zip', 'QQ.exe', 'resources']);
  const got = v.qqVersions(dir);
  assert.deepEqual(got.installed, ['9.9.37-0', '9.9.36-0']);
  assert.deepEqual(got.pendingUpdate, ['9.9.37-0']);
  assert.equal(got.error, '');
});

test('读不到 QQ 目录必须报 error，不能报"没有待更新的包"', () => {
  const empty = v.qqVersions('');
  assert.ok(empty.error, '空目录要留下原因');
  assert.match(empty.error, /没读到/);
  const missing = v.qqVersions(path.join(dataDir, 'nope-not-here'));
  assert.ok(missing.error, '目录不存在也要留下原因');
});

test('订阅源解析：只认 entry 里的正式版，feed 级 id 和预发布都不当版本号', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'napcat-releases.sample.atom'), 'utf8');
  assert.equal(v.tagFromAtom(fixture), 'v4.18.42', '第一个正式版必须解析出来');
  assert.equal(v.tagFromAtom('<feed><id>tag:github.com,2008:https://github.com/NapNeko/NapCatQQ/releases</id></feed>'), '', 'feed 自己的 id 不是版本号');
  assert.equal(v.tagFromAtom('<feed><entry><id>tag:github.com,2008:Repository/1/v4.18.41</id></entry></feed>'), 'v4.18.41', '没有 link 形态时还得能从 Repository id 里取');
  assert.equal(v.tagFromAtom('<feed><entry><id>tag:github.com,2008:Repository/1/v9.9.9-beta</id><category term="Prerelease"/></entry></feed>'), '', '预发布版不能当成可升的正式版');
  assert.equal(v.tagFromAtom(''), '');
});

test('GitHub API 限流就退到订阅源：版本号还是要如实拿到', async () => {
  // 拿真实订阅源样本喂进去：上一版判据用的是我凭空写的 /tags/ 形态，代码跟着样本一起错，两边自洽却永远对不上 GitHub。
  const atom = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'napcat-releases.sample.atom'), 'utf8');
  const calls = [];
  const tag = await v.fetchLatestTag({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return String(url).includes('api.github.com')
        ? { ok: false, status: 403, json: async () => ({ message: 'API rate limit exceeded' }) }
        : { ok: true, text: async () => atom };
    },
  });
  assert.equal(tag, 'v4.18.42', '限流不该变成查不到，样本里的正式版就是它');
  assert.equal(calls.length, 2, 'API 失败后必须真去读订阅源');
});

test('两条路都不通才认输，并把两边的原因都留下', async () => {
  let err = null;
  await v.fetchLatestTag({ fetchImpl: async () => { throw new Error('连不上'); } }).catch((e) => { err = e; });
  assert.ok(err, '两条路都不通必须抛错，不能返回空串假装查到了');
  assert.match(err.message, /API/);
  assert.match(err.message, /订阅源/);
});

test('顶栏门槛：QQ 有包等着换但 NapCat 已是官方最新 → 不占顶栏，只在面板说', () => {
  assert.deepEqual(v.versionAlerts(null), []);
  assert.deepEqual(v.versionAlerts({ needsUpgrade: 'unknown', qqPendingUpdate: ['9.9.36-53644'] }), [], '查不到不报警');
  assert.deepEqual(v.versionAlerts({ needsUpgrade: false, qqPendingUpdate: ['9.9.36-53644'], napcatLatest: 'v4.18.42' }), [], '没有可动的动作就别占顶栏');
  const warn = v.versionAlerts({
    needsUpgrade: true,
    qqPendingUpdate: ['9.9.36-53644'],
    napcatLatest: 'v4.18.50',
    napcatInstalled: 'v4.18.42',
    upgradeCommand: 'UPCMD',
  });
  assert.equal(warn.length, 1);
  assert.equal(warn[0].level, 'warn');
  assert.match(warn[0].text, /9\.9\.36-53644/);
  assert.match(warn[0].text, /v4\.18\.50/);
  assert.match(warn[0].text, /UPCMD$/);
  const info = v.versionAlerts({ needsUpgrade: true, qqPendingUpdate: [], napcatLatest: 'v4.18.50', napcatInstalled: 'v4.18.42', upgradeCommand: 'UPCMD' });
  assert.equal(info.length, 1);
  assert.equal(info[0].level, 'info');
});

test('扣住的包不能被判成"没有待更新"：heldUpdate 单独列，pendingUpdate 里不许留', () => {
  const only = v.qqVersions(fakeQqDir(['9.9.28-46928', '9.9.36-53644.zip.held-2026-11-03T07-00-00']));
  assert.deepEqual(only.pendingUpdate, []);
  assert.deepEqual(only.heldUpdate, ['9.9.36-53644']);
  const both = v.qqVersions(fakeQqDir(['9.9.28-46928', '9.9.36-53644.zip', '9.9.40-1.zip.held-x']));
  assert.deepEqual(both.pendingUpdate, ['9.9.36-53644']);
  assert.deepEqual(both.heldUpdate, ['9.9.40-1']);
});

test('换装排期照实读 config.json：读不到是未读到，不是"没排期"', () => {
  const dir = fakeQqDir(['9.9.28-46928']);
  fs.writeFileSync(path.join(dir, 'versions', 'config.json'), JSON.stringify({ curVersion: '9.9.28-46928', readyVersion: '9.9.36-53644' }), 'utf8');
  const got = v.qqVersions(dir);
  assert.equal(got.curVersion, '9.9.28-46928');
  assert.equal(got.readyVersion, '9.9.36-53644');
  const empty = v.qqVersions(fakeQqDir(['9.9.28-46928']));
  assert.equal(empty.readyVersion, null, '这个目录里根本没有 config.json，只能是未读到');
  assert.equal(empty.curVersion, null, 'curVersion 也一样：读不到不等于"没装版本"');
  const written = fakeQqDir(['9.9.28-46928']);
  fs.writeFileSync(path.join(written, 'versions', 'config.json'), JSON.stringify({ curVersion: '9.9.28-46928', readyVersion: '' }), 'utf8');
  assert.equal(v.qqVersions(written).readyVersion, '', '读到了、确实空着——这个空是有意义的');
});

test('扣包命令：改名而不是删除、只扣比现役新的、改完必须复核、放行不许覆盖已有同名包', () => {
  const tool = fs.readFileSync(path.join(ROOT, 'tools', 'hold-qq-update.mjs'), 'utf8');
  assert.match(tool, /fs\.renameSync/, '删除就没法回退了');
  assert.match(tool, /--release/, '必须留一条放行的路');
  assert.match(tool, /compareVersions\(v, current\)/, '比现役旧的包不该扣');
  assert.match(tool, /if \(after\.pendingUpdate\.length\) die/, '改完不复核＝不知道有没有真扣住');
  assert.match(tool, /已经在了/, '放行时同名包已存在不能直接盖掉');
  assert.match(tool, /readyVersion/, 'QQ 已经排期换装时，改名拦不住，必须说出来');
});

test('对账：官方有更新版 → 记 kv、报事件、给出升级命令', async () => {
  const root = fakeRoot('v4.18.42');
  const qq = fakeQqDir(['9.9.36-0']);
  const before = countType('napcat_upgrade_available');
  const report = await v.checkNapcatVersions({
    fetchLatest: async () => 'v4.18.50',
    root,
    readQqDir: async () => qq,
  });
  assert.equal(report.needsUpgrade, true);
  assert.equal(report.napcatInstalled, 'v4.18.42');
  assert.equal(report.napcatLatest, 'v4.18.50');
  assert.equal(report.qqInstalled, '9.9.36-0');
  assert.match(report.upgradeCommand, /upgrade-napcat/);
  assert.equal(countType('napcat_upgrade_available'), before + 1);
  assert.equal(kvGetJson('napcat_versions', null).napcatLatest, 'v4.18.50');
});

test('对账：同一状态重复跑不许刷屏，版本一变就得立刻报', async () => {
  const root = fakeRoot('v4.18.42');
  const run = (latest, qqDir) => v.checkNapcatVersions({ fetchLatest: async () => latest, root, readQqDir: async () => qqDir });
  const qq = fakeQqDir(['9.9.36-0', '9.9.37-0.zip']);
  const upgrade = countType('napcat_upgrade_available');
  const pending = countType('qq_pending_update');
  await run('v4.18.60', qq);
  await run('v4.18.60', qq);
  assert.equal(countType('napcat_upgrade_available'), upgrade + 1, '官方版本没变，第二条不该再报');
  assert.equal(countType('qq_pending_update'), pending + 1, '待装包没变，第二条不该再报');
  await v.checkNapcatVersions({ fetchLatest: async () => 'v4.18.61', root, readQqDir: async () => qq });
  assert.equal(countType('napcat_upgrade_available'), upgrade + 2, '官方又出了新版，得报');
});

test('QQ 自己升完版本要说出来：这是" NapCat 该跟一版"的信号', async () => {
  const root = fakeRoot('v4.18.42');
  const before = fakeQqDir(['9.9.36-0']);
  await v.checkNapcatVersions({ fetchLatest: async () => 'v4.18.42', root, readQqDir: async () => before });
  const after = fakeQqDir(['9.9.36-0', '9.9.37-0']);
  const count = countType('qq_upgraded');
  const report = await v.checkNapcatVersions({ fetchLatest: async () => 'v4.18.42', root, readQqDir: async () => after });
  assert.equal(report.qqInstalled, '9.9.37-0');
  assert.equal(countType('qq_upgraded'), count + 1);
  const last = listEvents(20).find((e) => e.type === 'qq_upgraded');
  assert.match(last.message, /9\.9\.37/);
});

test('GitHub 查不到：如实留 lookupError，needsUpgrade 是 unknown，一条警报都不发', async () => {
  const root = fakeRoot('v4.18.42');
  const qq = fakeQqDir(['9.9.36-0']);
  const alerts = countType('napcat_upgrade_available') + countType('qq_pending_update') + countType('qq_upgraded');
  const report = await v.checkNapcatVersions({
    fetchLatest: async () => { throw new Error('Test attempted external request'); },
    root,
    readQqDir: async () => qq,
  });
  assert.ok(report.lookupError, '失败原因要留下');
  assert.equal(report.needsUpgrade, 'unknown');
  assert.equal(countType('napcat_upgrade_available') + countType('qq_pending_update') + countType('qq_upgraded'), alerts, '查不到不许报警');
});

test('没装过 NapCat（没有 .napcat-release）也不许猜版本', async () => {
  const report = await v.checkNapcatVersions({
    fetchLatest: async () => 'v4.18.70',
    root: fakeRoot(''),
    readQqDir: async () => fakeQqDir(['9.9.36-0']),
  });
  assert.equal(report.napcatInstalled, '');
  assert.equal(report.needsUpgrade, 'unknown');
});

test('对账节流：查到了半天一次，没查到两小时就再试', () => {
  const now = Date.now();
  assert.equal(v.versionCheckDue({ now, lastAttemptAt: 0 }).due, true);
  assert.equal(v.versionCheckDue({ now, lastAttemptAt: now - 3 * HOUR, report: { lookupError: '' } }).due, false);
  assert.equal(v.versionCheckDue({ now, lastAttemptAt: now - 13 * HOUR, report: { lookupError: '' } }).due, true);
  assert.equal(v.versionCheckDue({ now, lastAttemptAt: now - 3 * HOUR, report: { lookupError: 'GitHub 返回 500' } }).due, true, '上次没查到还等 12 小时＝一整天瞎着');
  assert.equal(v.versionCheckDue({ now, lastAttemptAt: now + 5 * HOUR }).due, false, '时钟回跳不许变成"该查了"');
});

test('断线横幅里的版本提示只在真落后时出现', () => {
  assert.equal(v.versionHintForOutage(null), '');
  assert.equal(v.versionHintForOutage({ needsUpgrade: 'unknown', qqInstalled: '9.9.37-0' }), '');
  assert.equal(v.versionHintForOutage({ needsUpgrade: false, qqInstalled: '9.9.37-0' }), '');
  const hint = v.versionHintForOutage({ needsUpgrade: true, qqInstalled: '9.9.37-0', napcatInstalled: 'v4.18.42', upgradeCommand: 'X' });
  assert.match(hint, /9\.9\.37-0/);
  assert.match(hint, /v4\.18\.42/);
  assert.match(hint, /X$/);
});

test('接线：对账真的挂进了她的日常、界面和状态接口（不是写了个没人调的函数）', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  assert.match(read('src/scheduler.js'), /tickStep\('版本对账', \(\) => this\.maybeVersionCheck\(\)\)/);
  assert.match(read('src/scheduler.js'), /await this\.tickStep\('版本对账', \(\) => this\.maybeVersionCheck\(\)\);/);
  assert.match(read('src/index.js'), /versions: lastVersionReport\(\)/);
  assert.ok(read('src/index.js').includes('/api/qq/versions/check'), '状态接口没挂上版本对账入口');
  assert.match(read('web/app.js'), /QQ 版本：未读到/);
  assert.match(read('web/app.js'), /还没跑过/);
  assert.match(read('src/index.js'), /versionHintForOutage\(lastVersionReport\(\)\)/);
});

test('回滚命令：装完必须留下能一条退回的备份路径', () => {
  const tool = fs.readFileSync(path.join(ROOT, 'tools', 'upgrade-napcat.mjs'), 'utf8');
  assert.match(tool, /--rollback/);
  assert.match(tool, /fs\.cpSync\(napcatDir, backup/);
  assert.match(tool, /if \(target\.bytes && size !== target\.bytes\)/, '不校验下载大小就是装个来历不明的包');
  assert.match(tool, /const hash = sha256\(zip\)/, '算了指纹却不比对，等于没算');
  assert.match(tool, /const PRESERVE = \['config', 'cache'\]/, 'config 与 cache 会被新版覆盖掉');
  assert.match(tool, /if \(after\.files < incoming\.files\)/, '拷完不数文件数，静默少一半也照样报成功');
  assert.match(tool, /for \(const name of PRESERVE\)/, '合并后没验证保留目录还在');
  assert.match(tool, /if \(copied\.files < source\.files\)/, '备份没拷全就继续动手，等于没有退路');
  // 这几条是静态闸门：钉住「该做的检查写在代码里」，不覆盖下载、解压、换文件的真链路（那要真跑一次 --apply）。
});

test.after(() => closeDb());
