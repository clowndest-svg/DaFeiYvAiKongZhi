// QQ 会自己升级（这台机器上它已经把新版本包下到 versions/ 里了），NapCat 得跟着版本走。
// 这个模块只做"发现 + 说清楚"：不自动下载执行第三方二进制，装哪一版由人点头（tools/upgrade-napcat.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { addEvent, kvGetJson, kvSetJson } from './db.js';
import { logger } from './logger.js';
import { qqInstallDir } from './processes.js';

const RELEASE_FILE = path.join('napcat', '.napcat-release');
const VERSION_REPORT_KEY = 'napcat_versions';
const QQ_VERSION_DIR = /^(\d+\.\d+\.\d+-\d+)$/;
export const UPGRADE_COMMAND = 'node tools/upgrade-napcat.mjs --apply';

export function compareVersions(a, b) {
  const parse = (value) => String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// 该不该提示升级：只有"确实查到官方更新版"才算需要，查不到一律 unknown（不许拿猜测报警）。
export function decideUpgrade({ napcatInstalled = '', napcatLatest = '' } = {}) {
  if (!napcatInstalled || !napcatLatest) return { needsUpgrade: 'unknown', reason: '没查到官方版本，或本地没记录装过哪一版' };
  const order = compareVersions(napcatLatest, napcatInstalled);
  if (order === null) return { needsUpgrade: 'unknown', reason: '版本号格式认不出来' };
  return order > 0
    ? { needsUpgrade: true, reason: `官方 ${napcatLatest} 比在用的 ${napcatInstalled} 新` }
    : { needsUpgrade: false, reason: `在用 ${napcatInstalled} 已是最新（官方 ${napcatLatest}）` };
}

export function installedRelease(root = paths.root) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, RELEASE_FILE), 'utf8'));
    return { tag: String(data.tag || ''), sha256: String(data.sha256 || ''), at: String(data.at || ''), backup: String(data.backup || '') };
  } catch {
    return { tag: '', sha256: '', at: '', backup: '' };
  }
}

// QQ 安装目录下的 versions/：每个 x.y.z-w 目录是一个已装版本，同名 .zip 是"已下载、等着自动升级"的包。
// 目录读不到就返回 error，绝不返回空列表——空列表会被读成"QQ 没有待更新的包"。
export function qqVersions(qqDir = '') {
  const result = { installed: [], pendingUpdate: [], error: '' };
  if (!qqDir) {
    result.error = '没读到 QQ 安装位置';
    return result;
  }
  const versionsDir = path.join(qqDir, 'versions');
  try {
    for (const entry of fs.readdirSync(versionsDir)) {
      const match = QQ_VERSION_DIR.exec(entry);
      if (match) result.installed.push(match[1]);
      else if (/^(\d+\.\d+\.\d+-\d+)\.zip$/.test(entry)) result.pendingUpdate.push(entry.replace(/\.zip$/, ''));
    }
    result.installed.sort((a, b) => (compareVersions(b, a) ?? 0));
    result.pendingUpdate.sort((a, b) => (compareVersions(b, a) ?? 0));
  } catch (error) {
    result.error = String(error.message || error).slice(0, 60);
  }
  return result;
}

// 拿"官方最新版"：GitHub API 在共享出口 IP 上很容易限流（这台机器实测就是 403），
// 所以 API 不通就退到 releases.atom 订阅源——它不占 API 限额，版本号照样拿得到。
const API_LATEST = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest';
const RELEASES_ATOM = 'https://github.com/NapNeko/NapCatQQ/releases.atom';
export const RELEASE_DOWNLOAD = (tag) => 'https://github.com/NapNeko/NapCatQQ/releases/download/' + tag + '/NapCat.Shell.zip';

export async function fetchLatestTag({ fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const headers = { 'user-agent': 'bizhi-version-check' };
  let apiError = '';
  try {
    const res = await fetchImpl(API_LATEST, { headers: { ...headers, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error('API 返回 ' + res.status);
    const data = await res.json();
    if (!data.tag_name) throw new Error('API 返回里没有 tag_name');
    return String(data.tag_name);
  } catch (error) {
    apiError = String(error.message || error).slice(0, 60);
  }
  try {
    const res = await fetchImpl(RELEASES_ATOM, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error('订阅源返回 ' + res.status);
    const match = String(await res.text()).match(/<id>[^<]*\/tags\/([A-Za-z0-9._-]+)<\/id>/);
    if (!match) throw new Error('订阅源里没找到版本号');
    return match[1];
  } catch (feedError) {
    throw new Error('API：' + apiError + '；订阅源：' + String(feedError.message || feedError).slice(0, 60));
  }
}

// 同一个状态只报一次：每天对账一次，同一条提示不许天天刷屏（但状态一变就得立刻报）。
function changed(previous, key, value) {
  const before = previous ? previous[key] : null;
  const same = Array.isArray(value) || Array.isArray(before)
    ? String(value) === String(before)
    : value === before;
  return !previous || !same;
}

export async function checkNapcatVersions({ now = new Date(), fetchLatest = fetchLatestTag, root = paths.root, readQqDir = qqInstallDir } = {}) {
  const installed = installedRelease(root);
  const dir = await readQqDir();
  const versions = qqVersions(dir);
  let latest = '';
  let lookupError = '';
  try {
    latest = await fetchLatest();
    if (!latest) lookupError = '官方版本返回空';
  } catch (error) {
    lookupError = String(error.message || error).slice(0, 80);
  }
  const decision = decideUpgrade({ napcatInstalled: installed.tag, napcatLatest: latest });
  const currentQq = versions.installed[0] || '';
  const pending = versions.pendingUpdate.filter((v) => (compareVersions(v, currentQq) ?? 0) > 0);
  const previous = lastVersionReport();
  const report = {
    at: now.toISOString(),
    napcatInstalled: installed.tag,
    napcatInstalledAt: installed.at,
    napcatBackup: installed.backup,
    napcatLatest: latest,
    lookupError,
    needsUpgrade: decision.needsUpgrade,
    upgradeReason: decision.reason,
    upgradeCommand: UPGRADE_COMMAND,
    qqInstalled: currentQq,
    qqInstalledAll: versions.installed,
    qqPendingUpdate: pending,
    qqVersionsError: versions.error,
  };
  kvSetJson(VERSION_REPORT_KEY, report);
  // 只认版本往上走：变低多半是回滚、或注册表指到了另一套安装，'QQ 自己升到了 X' 就成了假消息。
  if (previous && previous.qqInstalled && currentQq && (compareVersions(currentQq, previous.qqInstalled) ?? 0) > 0) {
    addEvent('qq_upgraded', `QQ 自己升到了 ${currentQq}（原来是 ${previous.qqInstalled}）；她目前还能收发，哪天连不上先怀疑 NapCat 版本`, {
      from: previous.qqInstalled,
      to: currentQq,
      napcat: installed.tag,
    });
  }
  if (pending.length && changed(previous, 'qqPendingUpdate', pending)) {
    addEvent('qq_pending_update', `QQ 已经下载了 ${pending.join('、')} 的更新包，装上后 NapCat 可能要跟一版`, { pending, napcat: installed.tag });
  }
  if (decision.needsUpgrade === true && changed(previous, 'napcatLatest', latest)) {
    addEvent('napcat_upgrade_available', `NapCat 有新版可升：${latest}（在用 ${installed.tag}）；跑 ${UPGRADE_COMMAND} 就行`, { latest, installed: installed.tag });
  }
  logger.info('NapCat/QQ 版本对账', {
    napcat: installed.tag || '未记录',
    latest: latest || '未查到',
    qq: currentQq || '未读到',
    pending: pending.join(',') || '无',
  });
  return report;
}

// 多久对一次账：上次真查到了就半天一次；上次有任一项没查到，两小时后再试，
// 免得 GitHub 抖一下就一整天瞎着（那段时间 QQ 悄悄升了版也没人知道）。
export function versionCheckDue({ now = Date.now(), lastAttemptAt = 0, report = null } = {}) {
  const hours = report && (report.lookupError || report.qqVersionsError) ? 2 : 12;
  if (!Number.isFinite(lastAttemptAt) || !lastAttemptAt) return { due: true, waitHours: hours, reason: '还没对过账' };
  const waited = now - lastAttemptAt;
  // 时间戳在未来＝时钟被往回调过。按原节奏等就行，判成该查了会在一片抖动里连打好几次网络。
  if (waited < 0) return { due: false, waitHours: hours, reason: '上次对账记录在未来（时钟被调过），按原节奏等' };
  return waited >= hours * 3600000
    ? { due: true, waitHours: hours, reason: `距上次 ${Math.floor(waited / 3600000)} 小时` }
    : { due: false, waitHours: hours, reason: `${Math.floor(waited / 60000)} 分钟前刚查过` };
}

// 断线时最想知道的就是"是不是版本又对不上了"，所以这条只在确实查出 NapCat 落后于官方时才拼进去。
export function versionHintForOutage(report) {
  if (!report || report.needsUpgrade !== true || !report.qqInstalled) return '';
  return `；顺便看下版本：QQ 已是 ${report.qqInstalled}，NapCat 还在 ${report.napcatInstalled || '未记录'}，要升就跑 ${report.upgradeCommand || UPGRADE_COMMAND}`;
}

export function lastVersionReport() {
  const stored = kvGetJson(VERSION_REPORT_KEY, null);
  return stored && typeof stored === 'object' ? stored : null;
}
