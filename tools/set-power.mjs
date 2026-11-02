// 接通电源时不再睡眠（NapCat/QQ 一睡就断，醒了还得扫码）。
// 只改 AC 两项：standby-timeout-ac、hibernate-timeout-ac → 0；电池一律不动；合盖动作只读不改。
// 用法：node tools/set-power.mjs          改并校验
//       node tools/set-power.mjs --show   只读现状
//       node tools/set-power.mjs --revert 用上次存的值改回去
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
// 能用别名的就用别名：这台机器上按 GUID 查休眠项会报"设置不存在"（实测踩过）。
const SUB_SLEEP = 'SUB_SLEEP';
const SUB_PCIEXPRESS = 'SUB_PCIEXPRESS';
const SUB_USB = '2a737441-1930-4402-8d77-b2bebba308a3';
const STANDBY_IDLE = 'STANDBYIDLE';
const HIBERNATE_IDLE = 'HIBERNATEIDLE';
const ASPM = 'ee12f906-d277-404b-b6da-e5fa1a576df5';            // PCI Express 链接状态电源管理
const USB_SUSPEND = '48e6b7a6-50f5-4782-a5d4-53bb8f07e226';     // USB 选择性暂停
const LID_SUBGROUP = '4f971e89-eebd-4455-ade9-76a5cb94e668';
const LID_ACTION = '5ca83367-6e45-459f-a27b-476b130170a7';
const STATE_FILE = path.join(ROOT, 'data', 'power-before.json');

const run = (args) => execFileSync('powercfg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
// 中文系统的标签是"当前交流电源设置索引"，英文是 "Current AC Power Setting Index"，两种都要认。
const AC_RE = /(?:当前交流电源设置索引|Current AC Power Setting Index)\s*[:：]\s*0x([0-9a-f]{8})/i;
const DC_RE = /(?:当前直流电源设置索引|Current DC Power Setting Index)\s*[:：]\s*0x([0-9a-f]{8})/i;

function readSetting(sub, setting) {
  let out;
  try {
    out = run(['/q', 'SCHEME_CURRENT', sub, setting]);
  } catch (error) {
    // 这台机器没启用休眠时，powercfg 直接报"设置不存在"——那是"无需改"，不是失败。
    if (/不存在|does not exist/i.test(String(error.stdout || '') + String(error.message || ''))) return null;
    throw error;
  }
  const ac = AC_RE.exec(out);
  const dc = DC_RE.exec(out);
  if (!ac || !dc) throw new Error(`读不到 ${setting} 的 AC/DC 值（powercfg 输出格式没认出来）`);
  return { ac: parseInt(ac[1], 16), dc: parseInt(dc[1], 16) };
}

const TARGETS = [
  { name: 'standby-timeout-ac', sub: SUB_SLEEP, setting: STANDBY_IDLE, want: 0, required: true, note: '接通电源后不睡眠' },
  { name: 'hibernate-timeout-ac', sub: SUB_SLEEP, setting: HIBERNATE_IDLE, want: 0, required: false, note: '接通电源后不休眠' },
  { name: 'aspm-ac', sub: SUB_PCIEXPRESS, setting: ASPM, want: 0, required: false, note: 'PCIe 链接省电关掉（网卡省电会掉线）' },
  { name: 'usb-suspend-ac', sub: SUB_USB, setting: USB_SUSPEND, want: 0, required: false, note: 'USB 选择性暂停关掉' },
];

function snapshot() {
  const values = {};
  for (const target of TARGETS) {
    values[target.name] = readSetting(target.sub, target.setting);
  }
  values['lid-action(只读)'] = readSetting(LID_SUBGROUP, LID_ACTION);
  return values;
}

if (process.platform !== 'win32') {
  console.log('不是 Windows，跳过电源设置');
  process.exit(0);
}

if (process.argv.includes('--show')) {
  console.log(JSON.stringify(snapshot(), null, 1));
  process.exit(0);
}

if (process.argv.includes('--revert')) {
  if (!fs.existsSync(STATE_FILE)) {
    console.log('没有 data/power-before.json，不知道该恢复成什么——不动。');
    process.exit(1);
  }
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const done = [];
  for (const target of TARGETS) {
    const value = saved.values?.[target.name];
    if (!value) continue;
    run(['/setacvalueindex', 'SCHEME_CURRENT', target.sub, target.setting, String(value.ac)]);
    run(['/setactive', 'SCHEME_CURRENT']);
    done.push(`${target.name}=${value.ac}`);
  }
  console.log(`已按 ${saved.at} 存的值恢复：${done.join('，')}`);
  console.log(JSON.stringify(snapshot(), null, 1));
  process.exit(0);
}

const before = snapshot();
fs.writeFileSync(STATE_FILE, JSON.stringify({ at: new Date().toISOString(), before }, null, 2));
console.log('改前的值已存进 data/power-before.json：');
console.log(JSON.stringify(before, null, 1));

for (const target of TARGETS) {
  if (!before[target.name]) {
    console.log(`跳过 ${target.name}：这台机器上没有这个设置（未启用休眠）`);
    continue;
  }
  run(['/setacvalueindex', 'SCHEME_CURRENT', target.sub, target.setting, String(target.want)]);
}
run(['/setactive', 'SCHEME_CURRENT']);

const after = snapshot();
let ok = true;
if (!after['standby-timeout-ac']) {
  console.log('✗ 读不到 standby-timeout-ac：这台机器连睡眠设置都没有，改动无从校验');
  ok = false;
}
for (const target of TARGETS) {
  if (!before[target.name] || !after[target.name]) continue;
  const pass = after[target.name].ac === target.want;
  if (!pass) ok = false;
  console.log(`${pass ? '✓' : '✗'} ${target.name}: ${before[target.name].ac} → ${after[target.name].ac}（要 ${target.want}）`);
}
for (const target of TARGETS) {
  if (!before[target.name] || !after[target.name]) continue;
  if (after[target.name].dc !== before[target.name].dc) {
    ok = false;
    console.log(`✗ ${target.name} 的电池值被改了：${before[target.name].dc} → ${after[target.name].dc}（不该动）`);
  }
}
const battery = TARGETS.filter((t) => after[t.name]).map((t) => `${t.name} dc=${after[t.name].dc}`);
console.log(`电池项一律没动：${battery.join('、') || '（都没读到）'} —— 拔电后仍会按这些时间睡眠`);
console.log(after['lid-action(只读)']
  ? `合盖动作（没改）：AC=${after['lid-action(只读)'].ac} DC=${after['lid-action(只读)'].dc} —— 合上盖子仍会睡`
  : '合盖动作：这个方案里读不到该项（OEM 精简），合盖行为由固件决定');
console.log('回退命令：node tools/set-power.mjs --revert');
console.log(ok ? 'RESULT pass' : 'RESULT fail');
process.exit(ok ? 0 : 1);
