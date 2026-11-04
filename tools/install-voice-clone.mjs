// GPT-SoVITS（本地音色克隆引擎）安装器。一切落 E 盘，不碰 C。
// 用法：node tools/install-voice-clone.mjs --check   只看磁盘/网络/目标目录
//       node tools/install-voice-clone.mjs --install 下载官方整合包（GB 级，可能要几小时）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TARGET = 'E:/RuanJian/GPT-SoVITS';
const die = (m) => { console.log('✗ ' + m); console.log('RESULT fail'); process.exit(1); };
const ok = (m) => console.log('✓ ' + m);

// 剩余空间用 Node 自带的 statfs 量。之前调 PowerShell 的 Get-PSDrive "E:" 会报"找不到驱动器"
// （PSDrive 的名字不带冒号），拿不到数就当 0 GB，于是明明还有 138 GB 却每次都拒绝安装。
function diskFreeGb(dir) {
  try {
    const s = fs.statfsSync(dir.slice(0, 2) === '..' ? process.cwd() : `${dir.slice(0, 2)}/`);
    return Math.floor((s.bavail * s.bsize) / 1e9);
  } catch {
    return -1;
  }
}
function run(file, args, opts = {}) {
  const r = spawnSafe(file, args, opts);
  return r;
}
function spawnSafe(file, args, opts) {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: opts.timeout || 60000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error) return { code: -1, stdout: '', stderr: String(r.error.message) };
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const argv = process.argv.slice(2);
const mode = argv.includes('--install') ? 'install' : 'check';

fs.mkdirSync(TARGET, { recursive: true });
const free = diskFreeGb(TARGET);
console.log(`目标目录：${TARGET}（E 盘剩余约 ${free} GB）`);
if (free < 0) die('量不到目标盘剩余空间，先确认目录能访问');
if (free < 20) die('目标盘剩余不足 20 GB（实测 ' + free + ' GB），先腾地方（整合包解压后约 10–15 GB）');

if (mode === 'check') {
  console.log('下一步：--install 会从 GitHub 下载官方整合包（约 3–6 GB），只下载、不自动解压不自动运行。');
  console.log('RESULT pass');
  process.exit(0);
}

const rel = run('curl.exe', ['-s', '--connect-timeout', '10', '--max-time', '30',
  'https://api.github.com/repos/RVC-Boss/GPT-SoVITS/releases/latest'], { timeout: 60000 });
let asset = null;
try {
  const data = JSON.parse(rel.stdout);
  asset = (data.assets || []).find((a) => /GPT-SoVITS.*win.*\.(7z|zip)$/i.test(a.name));
  if (!asset) console.log('· 最新版没找到 Windows 整合包，改从 Release 页手挑：' + (data.html_url || ''));
} catch {
  console.log('· GitHub 没读到（限流/断网）：' + rel.stderr.slice(0, 80));
}
if (!asset) { console.log('RESULT fail'); process.exit(1); }
const dest = path.join(TARGET, asset.name);
console.log(`· 下载 ${asset.name}（${(asset.size / 1073741824).toFixed(2)} GB）→ ${dest}`);
const r = run('curl.exe', ['-fL', '--connect-timeout', '15', '--retry', '5', '--retry-delay', '5', '-o', dest, asset.browser_download_url], { timeout: 6 * 3600000 });
if (r.code !== 0 || !fs.existsSync(dest)) die(`下载没成（curl 退出 ${r.code}）`);
const size = fs.statSync(dest).size;
if (Math.abs(size - asset.size) > asset.size * 0.02) die(`下下来的文件 ${(size / 1048576).toFixed(0)} MB 和官方标的 ${(asset.size / 1048576).toFixed(0)} MB 对不上，删掉重下`);
ok(`下载完成 ${(size / 1073741824).toFixed(2)} GB`);
console.log('接下来（需要你动手）：用 7-Zip 解压到 ' + TARGET + '，运行 go-api-v2.bat，然后在控制台设置里填：');
console.log('  克隆引擎地址 http://127.0.0.1:9880 ｜ 参考音频路径 ｜ 参考文本（参考音频必须是你有权使用的那个人、10 秒左右、干净人声）');
console.log('RESULT pass');
