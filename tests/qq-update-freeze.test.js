// QQ 热更新冻结工具的判据：只拦 versions/ 这一层的「新建」，不碰已有文件、不继承到现役版本目录，
// 回退要精确删自己加的那条规则，读不到版本时要如实报 error 而不是当成「没有待装包」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 工具会 import src/processes.js，先把它的数据目录隔离掉；测试本身不调用 qqInstallDir，不碰注册表。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizhi-freeze-test-'));
process.env.BIZHI_DATA_DIR = dataDir;
process.env.BIZHI_SETTINGS_FILE = path.join(dataDir, 'settings.json');

const tool = await import('../tools/freeze-qq-update.mjs');

function fakeVersions(entries = {}) {
  const dir = fs.mkdtempSync(path.join(dataDir, 'versions-'));
  if (Object.hasOwn(entries, 'config.json')) {
    fs.writeFileSync(path.join(dir, 'config.json'), entries['config.json'], 'utf8');
  }
  for (const [name, kind] of Object.entries(entries)) {
    if (name === 'config.json') continue;
    const full = path.join(dir, name);
    if (kind === 'dir') fs.mkdirSync(full, { recursive: true });
    else fs.writeFileSync(full, 'x', 'utf8');
  }
  return dir;
}

test('PowerShell 单引号转义：路径里的单引号翻倍，不产生可注入的引号', () => {
  assert.equal(tool.psQuote("D:\\RuanJian\\qq"), "'D:\\RuanJian\\qq'");
  assert.equal(tool.psQuote("a'b"), "'a''b'");
  assert.equal(tool.psQuote("'; Remove-Item C:\\ -Recurse; #"), "'''; Remove-Item C:\\ -Recurse; #'");
});

test('规则只作用于 versions/ 这一层：Everyone 拒绝、不继承、只禁新建文件与目录', () => {
  const script = tool.buildFreezeScript({ mode: 'freeze', target: 'D:\\RuanJian\\qq\\versions' });
  assert.match(script, /S-1-1-0/);
  assert.match(script, /CreateFiles, CreateDirectories/);
  assert.match(script, /InheritanceFlags\]::None/);
  assert.match(script, /PropagationFlags\]::None/);
  assert.match(script, /AccessControlType\]::Deny/);
  // 不能出现继承标志，否则会连现役 9.9.28-46928/ 里的写入一起挡掉。
  assert.doesNotMatch(script, /InheritanceFlags\]::ContainerInherit/);
  assert.doesNotMatch(script, /InheritanceFlags\]::ObjectInherit/);
  // 只拒绝 CreateFiles/CreateDirectories，不能把 Write / Delete / FullControl 一起拒了。
  assert.doesNotMatch(script, /'Write, /);
  assert.doesNotMatch(script, /'FullControl'/);
});

test('三种模式：show 只读、freeze 新增、unfreeze 用实际读到的规则精确移除', () => {
  const show = tool.buildFreezeScript({ mode: 'show', target: 'X' });
  assert.match(show, /\$Mode = 'show'/);
  // 脚本里带着两个分支，但写操作全都被 mode 条件守住；show 不会走到任何一条 Set-Acl。
  assert.match(show, /if \(\$Mode -eq 'freeze' -and \$null -eq \$existing\) \{\s*\n\s*\$acl\.AddAccessRule/);
  assert.match(show, /\} elseif \(\$Mode -eq 'unfreeze' -and \$null -ne \$existing\) \{/);
  assert.equal((show.match(/Set-Acl/g) || []).length, 2, '写操作只能出现在那两个分支里');

  const freeze = tool.buildFreezeScript({ mode: 'freeze', target: 'X' });
  assert.match(freeze, /\$Mode = 'freeze'/);
  assert.match(freeze, /\$acl\.AddAccessRule/);
  assert.match(freeze, /\$Mode -eq 'freeze' -and \$null -eq \$existing/);

  const unfreeze = tool.buildFreezeScript({ mode: 'unfreeze', target: 'X' });
  assert.match(unfreeze, /\$Mode = 'unfreeze'/);
  assert.match(unfreeze, /\$acl\.RemoveAccessRuleSpecific\(\$existing\)/);
  assert.doesNotMatch(unfreeze, /RemoveAccessRuleSpecific\(\(New-FreezeRule\)\)/);
});

test('规则识别按 SID 翻译，不看显示名（Everyone 可能被规范化成别的写法）', () => {
  const script = tool.buildFreezeScript({ mode: 'show', target: 'X' });
  assert.match(script, /Translate\(\[System\.Security\.Principal\.SecurityIdentifier\]\)\.Value/);
  assert.match(script, /\$who -eq \$sid\.Value/);
  assert.match(script, /\(\$entry\.FileSystemRights -band \$rights\) -ne \$rights/);
});

test('readQqVersions：现役版本、readyVersion、待装包、已扣住分开读', () => {
  const dir = fakeVersions({
    'config.json': JSON.stringify({ curVersion: '9.9.28-46928', readyVersion: '' }),
    '9.9.28-46928': 'dir',
    '9.9.36-53644.zip': 'file',
    '9.9.35-50000.zip.held-2026-11-03': 'file',
  });
  const info = tool.readQqVersions(dir);
  assert.equal(info.curVersion, '9.9.28-46928');
  assert.equal(info.readyVersion, '');
  assert.deepEqual(info.pending, ['9.9.36-53644']);
  assert.deepEqual(info.held, ['9.9.35-50000.zip.held-2026-11-03']);
  assert.equal(info.error, '');
});

test('readQqVersions：config.json 读不到要报 error，不能把 readyVersion 当成确实空着', () => {
  const dir = fakeVersions({ '9.9.28-46928': 'dir' });
  const info = tool.readQqVersions(dir);
  assert.match(info.error, /config\.json 读不到/);
  assert.equal(info.curVersion, '');
  assert.equal(info.readyVersion, '');
});

test('readQqVersions：腾讯云控已经排期换装时要读得出来（冻结也拦不住这种情况，得如实报）', () => {
  const dir = fakeVersions({
    'config.json': JSON.stringify({ curVersion: '9.9.28-46928', readyVersion: '9.9.36-53644' }),
  });
  assert.equal(tool.readQqVersions(dir).readyVersion, '9.9.36-53644');
});

test('脚本路径参数走单引号插值，不拼进命令行', () => {
  const target = "D:\\qq with space\\it's here\\versions";
  const script = tool.buildFreezeScript({ mode: 'show', target });
  assert.match(script, /\$Target = 'D:\\qq with space\\it''s here\\versions'/);
  assert.match(script, /Get-Acl -LiteralPath \$Target/);
});
