// 桌面通知（服务端弹 Windows 气泡）。判据钉四件事：注入面、只弹一次、关掉就彻底不动、失败要留痕。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-qq-notify-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_SETTINGS_FILE = path.join(dataDir, 'settings.json');
fs.writeFileSync(process.env.BIZHI_SETTINGS_FILE, JSON.stringify({ qq: { desktopNotify: true } }), 'utf8');

const notify = await import('../src/notify.js');
const { addEvent, kvGetJson, listEvents, closeDb } = await import('../src/db.js');

const QUOTE = String.fromCharCode(39);
const BACKTICK = String.fromCharCode(96);
const okRun = () => ({ ok: true, exitCode: 0, error: '' });

function countFailed() {
  return listEvents(500).filter((e) => e.type === 'qq_notify_failed').length;
}

test('气泡脚本里正文不许多出引号：那等于把 PowerShell 的字符串闭合掉', () => {
  const evil = '); ' + BACKTICK + 'Start-Process calc' + BACKTICK + ' # ' + QUOTE + '$(rm -rf)';
  const script = notify.toastScript(evil, evil);
  const quotes = script.split(QUOTE).length - 1;
  assert.equal(quotes, 4, '只允许标题和正文各一对单引号，正文里多一个都是注入面');
  assert.ok(!script.includes(BACKTICK), '反引号在 PowerShell 里是转义符，必须剥掉');
  assert.ok(!script.includes('$('), '美元符加括号会被当子表达式执行');
  assert.equal(script.split(String.fromCharCode(10)).length, 1, '一条语句一行，正文换行不许撑出第二条语句');
  const normal = notify.toastScript('小知的 QQ 断了', '断了 5 分钟，她收不到也发不出消息');
  assert.ok(normal.includes('小知的 QQ 断了'), '正常中文要原样出现在气泡里');
  assert.match(normal, /ShowBalloonTip/);
});

test('同一件事只弹一次；换了新一轮断连才重新弹', async () => {
  let calls = 0;
  const run = async () => { calls += 1; return okRun(); };
  await notify.maybeNotify('down', { stamp: 'outage-A', title: 't', body: 'b', run });
  await notify.maybeNotify('down', { stamp: 'outage-A', title: 't', body: 'b', run });
  await notify.maybeNotify('down', { stamp: 'outage-A', title: 't', body: 'b', run });
  assert.equal(calls, 1, '看门狗每分钟读到同一次断连，不能每分钟弹一次');
  await notify.maybeNotify('down', { stamp: 'outage-B', title: 't', body: 'b', run });
  assert.equal(calls, 2, '新一次断连必须重新提醒');
});

test('弹不成要进事件表，并且不许记成"已经通知过"', async () => {
  const before = countFailed();
  let calls = 0;
  const result = await notify.maybeNotify('scan', {
    stamp: 'qr-X',
    title: '小知在等你扫码',
    body: 'b',
    run: async () => { calls += 1; return { ok: false, exitCode: 1, error: 'Add-Type 找不到程序集' }; },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.ok(countFailed() > before, '失败必须留痕，不能静默');
  assert.ok(!kvGetJson('qq_desktop_notify_sent', {})['scan:qr-X'], '记成已通知＝下次真断了就再也不弹');
});

test('设置里关掉后一条都不弹（也不留失败痕迹）', async () => {
  fs.writeFileSync(process.env.BIZHI_SETTINGS_FILE, JSON.stringify({ qq: { desktopNotify: false } }), 'utf8');
  let calls = 0;
  const result = await notify.maybeNotify('need_human', { stamp: 'h1', title: 't', body: 'b', run: async () => { calls += 1; return okRun(); } });
  assert.equal(calls, 0);
  assert.match(String(result.skipped), /关/);
  fs.writeFileSync(process.env.BIZHI_SETTINGS_FILE, JSON.stringify({ qq: { desktopNotify: true } }), 'utf8');
  assert.equal(notify.desktopNotifyEnabled(), true, '没有这个设置项时默认是开的（他 2026-11-03 明确要开）');
});

test('接线：断线、要扫码、需要人出手三条路都挂了钩；页面不再自己弹重复的一份', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const onebot = read('src/channels/onebot.js');
  assert.equal(onebot.split('maybeNotify(').length - 1, 3, '三条路：down / scan / need_human');
  for (const kind of ['down', 'scan', 'need_human']) {
    assert.ok(onebot.includes('maybeNotify(' + QUOTE + kind + QUOTE), '少了 ' + kind + ' 这条');
  }
  const app = read('web/app.js');
  assert.ok(!app.includes('new Notification('), '页面再弹一份会和系统气泡重复');
  assert.ok(!app.includes('Notification.requestPermission'), '浏览器权限这条道已经不用了');
  assert.match(read('web/index.html'), /测试桌面通知/);
  assert.match(read('src/index.js'), /notify\/test/);
  assert.match(read('src/index.js'), /notify\/toggle/);
});

test('界面要说清通知的真实状态：没自检过就写没自检过', () => {
  const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /还没自检过/, '不能因为"开着"就假装弹过');
  assert.match(app, /上次自检没弹成/, '自检失败要在面板上看得见');
});

test.after(() => closeDb());
