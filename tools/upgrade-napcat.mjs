// NapCat 升级：把今天手工做过并验证过的那串步骤固化成一条命令。
// 之所以不让她自己在定时器里跑：装第三方二进制是"代价大、出问题不容易看出来"的那类动作，得有人点头。
// 用法：node tools/upgrade-napcat.mjs [--check | --apply --from-cache | --rollback <备份目录>]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { paths } from '../src/config.js';
import { compareVersions, fetchLatestTag, installedRelease, qqVersions, RELEASE_DOWNLOAD, UPGRADE_COMMAND } from '../src/napcat-versions.js';

const API = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases';
const ASSET = 'NapCat.Shell.zip';
const PRESERVE = ['config', 'cache'];
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const napcatDir = path.join(root, 'napcat');
const releaseFile = path.join(napcatDir, '.napcat-release');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function die(message) {
  console.log(`✗ ${message}`);
  console.log('RESULT fail');
  process.exit(1);
}
function ok(message) {
  console.log(`✓ ${message}`);
}

function run(file, args, { timeout = 300000, quiet = false } = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 });
  if (!quiet && r.stdout) process.stdout.write(r.stdout);
  if (r.error) return { code: -1, stderr: String(r.error.message) };
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function extract(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const r = run('unzip', ['-qq', '-o', zip, '-d', dest], { timeout: 180000 });
  if (r.code === 0) return;
  const p = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { timeout: 300000 });
  if (p.code !== 0) die(`解压失败：unzip(${r.stderr.slice(0, 60)}) / Expand-Archive(${p.stderr.slice(0, 60)})`);
}
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function countTree(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else { files += 1; bytes += fs.statSync(full).size; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}
// 官方接口在共享出口 IP 上经常限流（这台机器实测 403）。版本号还能从订阅源拿到，
// 只是拿不到"官方标的大小"，这时如实说明并按包内结构校验——不许假装校验过。
async function release(tag) {
  const r = run('curl.exe', ['-s', '--proto=https', '--connect-timeout', '8', '--max-time', '25',
    `${API}${tag ? `/tags/${tag}` : '/latest'}`, '-H', 'accept: application/vnd.github+json'], { quiet: true });
  let data = null;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    data = null;
  }
  if (!data || !data.tag_name) {
    const apiWhy = r.code !== 0 ? `curl 退出 ${r.code}` : String((data && data.message) || '返回里没有 tag_name').slice(0, 50);
    let t2 = tag;
    if (!t2) {
      try {
        t2 = await fetchLatestTag();
      } catch (error) {
        die(`GitHub 没读到（API：${apiWhy}；订阅源：${error.message}）——先别动手装，等网络能通再跑`);
      }
    }
    return { tag: t2, url: RELEASE_DOWNLOAD(t2), bytes: 0, name: ASSET, via: `订阅源拼下载地址（官方大小未知，API 那次是 ${apiWhy}）` };
  }
  const asset = (data.assets || []).find((a) => a.name === ASSET);
  if (!asset) die(`${data.tag_name} 没有 ${ASSET} 这个安装包`);
  return { tag: data.tag_name, url: asset.browser_download_url, bytes: asset.size, name: asset.name, via: '官方 API' };
}
function cacheFile(tag) {
  return path.join(paths.data, `napcat-${tag}-${ASSET}`);
}

async function check() {
  const current = installedRelease(root);
  const latest = await release('');
  const { qqInstallDir } = await import('../src/processes.js');
  const qq = qqVersions(process.env.BIZHI_QQ_DIR || await qqInstallDir());
  console.log(`在用 NapCat：${current.tag || '未记录'}（装于 ${current.at ? current.at.slice(0, 16) : '未知时间'}）`);
  console.log(`官方最新：${latest.tag}（${latest.name} ${latest.bytes ? (latest.bytes / 1048576).toFixed(1) + ' MB' : '大小未取到'}｜来源：${latest.via}）`);
  const order = compareVersions(latest.tag, current.tag);
  if (current.tag && order === 0) ok('版本号和官方一致，需要重装再用 --apply');
  if (order === -1) ok(`在用的比官方新（${current.tag} > ${latest.tag}），确认一下是不是记录写错了`);
  if (order === 1) console.log(`有新版可升：跑 ${UPGRADE_COMMAND}`);
  console.log(`QQ：已装 ${qq.installed.join(' / ') || '未读到'}${qq.error ? `（${qq.error}）` : ''}${qq.pendingUpdate.length ? `｜已下载待装 ${qq.pendingUpdate.join('、')}` : ''}`);
  console.log('RESULT pass');
  return latest;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--check')) { await check(); return; }

  const { listOwned, stopOwned, startNapCat, qqInstallDir } = await import('../src/processes.js');
  const { addEvent } = await import('../src/db.js');

  if (argv.includes('--rollback')) {
    const target = argv[argv.indexOf('--rollback') + 1];
    if (!target || !path.isAbsolute(target)) die('--rollback 需要备份目录的绝对路径');
    const from = path.resolve(target);
    if (!fs.existsSync(path.join(from, 'napcat.mjs'))) die(`备份里没有 napcat.mjs，看着不是一次 NapCat 备份：${from}`);
    const now = countTree(napcatDir);
    const prev = countTree(from);
    if (now.files < prev.files * 0.5) die(`现役只剩 ${now.files} 个文件、备份有 ${prev.files} 个，差距太大，先人工看一眼`);
    const dir = napcatDir;
    for (const name of fs.readdirSync(dir)) {
      if (PRESERVE.includes(name)) continue;
      fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    fs.cpSync(from, dir, { recursive: true, filter: (src) => !PRESERVE.includes(path.relative(from, src).split(path.sep)[0]) });
    fs.copyFileSync(path.join(from, '.napcat-release'), releaseFile);
    console.log(`已回滚到 ${from}`);
    console.log('下一步：重启 NapCat 并确认她能收发（控制台「用机器人小号重新登录」会自己拉起来）');
    addEvent('napcat_rollback', `已把 NapCat 回滚到 ${path.basename(from)}`, { from });
    console.log('RESULT pass');
    return;
  }

  if (!argv.includes('--apply')) die('没看懂参数：可选 --check / --apply [--from-cache] / --rollback <备份目录>');
  const fromCache = argv.includes('--from-cache');
  const wantTag = argv.includes('--tag') ? argv[argv.indexOf('--tag') + 1] : '';

  // 先备份再停 QQ：备份阶段绝不能有文件被占用（那会静默少拷几个文件）。
  if (!fs.existsSync(napcatDir) || !fs.readdirSync(napcatDir).length) die('napcat/ 目录是空的，没什么可备份');
  const current = installedRelease(root);
  const backup = path.join(paths.data, `napcat-backup-${stamp()}`);
  fs.cpSync(napcatDir, backup, { recursive: true });
  const copied = countTree(backup);
  const source = countTree(napcatDir);
  if (copied.files < source.files) die(`备份只拷到 ${copied.files}/${source.files} 个文件，停在备份这一步（现役目录没动）`);
  ok(`已备份 ${copied.files} 个文件 ${(copied.bytes / 1048576).toFixed(0)} MB → ${backup}`);

  const target = await release(wantTag);
  const order = compareVersions(target.tag, current.tag);
  if (current.tag && order === 0) console.log(`· 在用的就是 ${target.tag}，这次是重装同一版`);
  if (order === -1) die(`在用的 ${current.tag} 比目标 ${target.tag} 新，降级请显式 --tag ${current.tag} 并自己想清楚`);

  const zip = cacheFile(target.tag);
  if (fromCache) {
    if (!fs.existsSync(zip)) die(`--from-cache 但本地没有 ${zip}`);
  } else {
    console.log(`· 下载 ${target.url}`);
    fs.mkdirSync(paths.data, { recursive: true });
    const r = run('curl.exe', ['-fL', '--proto=https', '--connect-timeout', '10', '--retry', '3', '--retry-delay', '2',
      '-o', zip, target.url], { timeout: 600000, quiet: true });
    if (r.code !== 0 || !fs.existsSync(zip)) die(`下载失败（curl 退出 ${r.code}）：${r.stderr.slice(0, 80)}；现役 NapCat 没动`);
  }
  const size = fs.statSync(zip).size;
  if (target.bytes && size !== target.bytes) die(`下载文件 ${(size / 1048576).toFixed(1)} MB 和 GitHub 标的 ${(target.bytes / 1048576).toFixed(1)} MB 不符，不装`);
  if (!target.bytes) console.log(`· 官方大小没取到（${target.via}），只校验包内结构与指纹；下载 ${(size / 1048576).toFixed(1)} MB`);
  const hash = sha256(zip);
  ok(`包 ${(size / 1048576).toFixed(1)} MB，sha256 ${hash}`);

  const stage = path.join(paths.data, `napcat-stage-${stamp()}`);
  extract(zip, stage);
  const incoming = countTree(stage);
  if (!fs.existsSync(path.join(stage, 'napcat.mjs')) || !fs.existsSync(path.join(stage, 'NapCatWinBootHook.dll'))) {
    die('解压后没看到 napcat.mjs / NapCatWinBootHook.dll，包结构不对，现役目录没动');
  }
  if (incoming.files < source.files * 0.5) die(`新版只有 ${incoming.files} 个文件，现役有 ${source.files} 个，差太多不敢覆盖`);
  ok(`新版 ${incoming.files} 个文件 ${(incoming.bytes / 1048576).toFixed(0)} MB`);

  const stopped = await stopOwned('napcat');
  console.log(`· 停掉现役 NapCat/QQ（确认 ${stopped.stopped} 个进程，模拟=${stopped.simulated}）`);
  const qqDir = await qqInstallDir();
  if (!qqDir) console.log('· 提醒：QQ 安装位置没读到，重启这一步会失败——按备份原样跑 node tools/upgrade-napcat.mjs --rollback 即可');

  for (const name of fs.readdirSync(napcatDir)) {
    if (PRESERVE.includes(name)) continue;
    fs.rmSync(path.join(napcatDir, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  fs.cpSync(stage, napcatDir, { recursive: true });
  const after = countTree(napcatDir);
  if (after.files < incoming.files) die(`合并后只有 ${after.files}/${incoming.files} 个文件，请立刻回滚：${backup}`);
  for (const name of PRESERVE) {
    if (!fs.existsSync(path.join(napcatDir, name))) die(`配置目录 ${name}/ 没了，请立刻回滚：${backup}`);
  }
  const oldRelease = JSON.parse(fs.readFileSync(path.join(backup, '.napcat-release'), 'utf8'));
  fs.writeFileSync(releaseFile, JSON.stringify({
    tag: target.tag,
    sha256: hash,
    bytes: size,
    source: target.url,
    at: new Date().toISOString(),
    installedBy: 'tools/upgrade-napcat.mjs',
    backup,
    previous: oldRelease,
  }, null, 2), 'utf8');
  ok(`已装 ${target.tag}（${after.files} 个文件 ${(after.bytes / 1048576).toFixed(0)} MB），config/ 与 cache/ 原样保留`);
  fs.rmSync(stage, { recursive: true, force: true });

  if (process.env.BIZHI_UPGRADE_NO_START !== '1') {
    try {
      const started = await startNapCat();
      console.log(`· 启动：${JSON.stringify(started)}`);
    } catch (error) {
      console.log(`⚠ 自动启动没成：${error.message}——去控制台点「用机器人小号重新登录」，或者再跑一次本命令的 --rollback 回原样`);
    }
  } else {
    console.log('· 按 BIZHI_UPGRADE_NO_START=1 的要求，没启动（现役文件已经是新版）');
  }
  addEvent('napcat_upgrade', `NapCat 已从 ${current.tag || '未记录'} 升到 ${target.tag}`, { backup, sha256: hash, bytes: size });
  console.log(`回滚命令：node tools/upgrade-napcat.mjs --rollback "${backup}"`);
  console.log('RESULT pass');
}

main().catch((error) => die(error.stack || error.message));
