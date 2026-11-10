// 哨兵：本机定时向另一台机器报平安，并把"她的大脑"（数据库 + 人设 + 周记/信/存档）
// 压成一份快照存到异机。这样这台电脑哪天磁盘坏了、或她悄悄停了半天，都有据可查、有档可恢复。
//
// 为什么是这个形状（稳定性优先）：
// 1) 单向：本机 → 服务器。服务器上不跑任何常驻进程、不开任何新端口——那台机器上还跑着
//    别的服务（已有站点和容器占着常用端口），
//    多一个常驻服务就多一份把它拖崩的风险。
// 2) 一把只干两件事的钥匙：服务器端那个账号的 shell 就是接收脚本本身，
//     authorised_keys 里再锁死 forced command；我们发的每条命令只有 heartbeat/backup/list 三种写法。
// 3) 连接信息不写进仓库：host/user 放在 data/sentinel/config.json（已 gitignore），私钥同目录。
// 4) 任何一步失败都只是"这次没报上"，绝不影响聊天、语音这些主链路；错误如实留成读数。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { paths, loadSettings, env } from './config.js';
import { getDb, kvGetJson, kvSetJson, addEvent } from './db.js';
import { logger } from './logger.js';

const DIR = path.join(paths.data, 'sentinel');
const CONFIG_FILE = path.join(DIR, 'config.json');
const DEFAULT_KEY = path.join(DIR, 'id_bizhi_sentinel');
// 这些目录/文件就是"她是谁、她记得什么"的全部家底，加起来才一百多 KB
const RECORD_DIRS = ['config', 'data/weekly', 'data/letters', 'data/archives'];
const MAX_BACKUP_BYTES = 300 * 1024 * 1024;

export function sentinelConfig() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { ok: false, enabled: false, reason: '本机还没配哨兵（缺 data/sentinel/config.json）' };
  }
  const host = String(raw.host || '').trim();
  const user = String(raw.user || '').trim();
  const keyFile = String(raw.keyFile || DEFAULT_KEY).trim();
  if (raw.enabled === false) return { ok: false, enabled: false, host, user, keyFile, reason: '哨兵开关是关的' };
  // host/user 要拼进 ssh 的 user@host，只允许规矩字符——不给任何注入的机会
  if (!/^[\w.-]+$/.test(host) || !/^[A-Za-z0-9._-]+$/.test(user)) return { ok: false, enabled: true, host, user, keyFile, reason: '配置里的 host/user 不是合法字符' };
  if (!fs.existsSync(keyFile)) return { ok: false, enabled: true, host, user, keyFile, reason: '找不到哨兵密钥（data/sentinel/）' };
  const knownHostsFile = path.join(DIR, 'known_hosts');
  try {
    if (!fs.existsSync(knownHostsFile)) {
      // Keep existing host-key pins rather than silently trusting a changed key.
      // Tests never read the user's real trust store.
      const previous = path.join(os.homedir(), '.ssh', 'known_hosts');
      if (!env.testMode && fs.existsSync(previous)) fs.copyFileSync(previous, knownHostsFile, fs.constants.COPYFILE_EXCL);
      else fs.writeFileSync(knownHostsFile, '', { flag: 'wx', mode: 0o600 });
    }
    if (fs.lstatSync(knownHostsFile).isSymbolicLink()) throw new Error('linked trust store');
  } catch { return { ok: false, enabled: true, host, user, keyFile, reason: '无法准备项目内 SSH 主机校验文件' }; }
  return { ok: true, enabled: true, host, user, keyFile, knownHostsFile, sshPath: String(raw.sshPath || 'ssh'), reason: '' };
}

// 命令一律用参数数组传，不经过 shell；command 只由我们自己拼（内容是 base64 或时间戳文件名）。
function runSsh(cfg, command, { stdinFile = '', timeoutMs = 90000 } = {}) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=12',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'IdentitiesOnly=yes',
    '-o', `UserKnownHostsFile="${cfg.knownHostsFile.replace(/\\/g, '/')}"`,
    '-i', cfg.keyFile,
    `${cfg.user}@${cfg.host}`,
    command,
  ];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cfg.sshPath, args, {
        windowsHide: true,
        // 要喂文件时 stdin 必须是 'pipe'；'ignore' 下 child.stdin 是 null，pipe 过去就崩（实测）
        stdio: [stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, reason: `ssh 起不来：${String(error.message).slice(0, 80)}`, stdout: '', code: -1 });
      return;
    }
    let stdout = '';
    let stderr = '';
    const done = (result) => resolve({ ...result, stdout: stdout.trim(), stderr: stderr.trim().slice(0, 160) });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      done({ ok: false, reason: `哨兵连接超过 ${Math.round(timeoutMs / 1000)} 秒没回来`, code: -1 });
    }, timeoutMs);
    if (stdinFile) {
      const stream = fs.createReadStream(stdinFile);
      stream.on('error', (error) => logger.warn('哨兵读备份文件失败', { error: error.message }));
      stream.pipe(child.stdin);
    }
    // stdio[0] 是 'ignore'，这时 child.stdin 是 null——调 .end() 会直接把这次心跳弄崩（实测报的就是这个）
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ ok: false, reason: `ssh 报错：${String(error.message).slice(0, 80)}`, code: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      if (code === 0 && (out === 'ok' || out.startsWith('ok '))) done({ ok: true, code });
      else done({ ok: false, code, reason: (stderr || out || `ssh 退出码 ${code}`).slice(0, 140) });
    });
  });
}

export function sentinelStatus() {
  const cfg = sentinelConfig();
  const heartbeat = kvGetJson('sentinel_heartbeat', null);
  const backup = kvGetJson('sentinel_backup', null);
  return {
    configured: cfg.ok,
    enabled: cfg.enabled,
    reason: cfg.reason,
    host: cfg.host || '',
    lastHeartbeat: heartbeat,
    lastBackup: backup,
    heartbeatHealthy: Boolean(heartbeat?.ok && Date.now() - new Date(heartbeat.at).getTime() < 90 * 60 * 1000),
  };
}

function b64(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export async function sendSentinelHeartbeat(payload = {}) {
  const cfg = sentinelConfig();
  if (!cfg.ok) return { ok: false, reason: cfg.reason };
  const at = new Date().toISOString();
  // 读数字段统一由 sentinelHeartbeatPayload 给：调用方只补"连没连上"这类状态。
  // 之前这里只把调用方传的几个布尔值拼上去，服务器上收到的档就缺了内存和运行时长（实测）。
  const line = { ...sentinelHeartbeatPayload(payload), at };
  const encoded = b64(line);
  if (encoded.length > 3000) return { ok: false, reason: '心跳内容太长（超过 3000 base64 字符）' };
  const result = await runSsh(cfg, `heartbeat ${encoded}`);
  kvSetJson('sentinel_heartbeat', { ok: result.ok, at, reason: result.reason || '', bytes: encoded.length });
  if (!result.ok) logger.warn('哨兵心跳没送出去', { reason: result.reason });
  return { ok: result.ok, reason: result.reason || '', at };
}

// tar.gz 由我们自己写：外部 tar 不可靠——这台机器上 Node 的 PATH 里排在前面的常常是
// Git Bash 那个 GNU tar，它把 C:\Users\... 当成"主机:路径"直接报错（实测退出码 2）。
// 记录文件总共才一百多 KB，自己打这个包比赌系统里哪个 tar 先来稳得多。
function tarHeader(name, size, mtimeMs) {
  const header = Buffer.alloc(512);
  const clean = String(name).replace(/\\/g, '/').replace(/^\.?\//, '');
  let entryName = clean;
  let prefix = '';
  if (Buffer.byteLength(entryName) > 99) {
    const cut = clean.lastIndexOf('/', 99);
    prefix = cut > 0 ? clean.slice(0, cut) : '';
    entryName = cut > 0 ? clean.slice(cut + 1) : clean.slice(-99);
  }
  header.write(entryName.slice(0, 100), 0, 'utf8');
  header.write('0000644\0', 100, 'utf8');
  header.write('0000000\0', 108, 'utf8');
  header.write('0000000\0', 116, 'utf8');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
  header.write(`${Math.floor(mtimeMs / 1000).toString(8).padStart(11, '0')}\0`, 136, 'utf8');
  header.write('        ', 148, 'utf8');
  header.write('0', 156, 'utf8');
  header.write('ustar\0', 257, 'utf8');
  header.write('00', 263, 'utf8');
  header.write(prefix.slice(0, 155), 345, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  return header;
}

export function buildTarGz(entries) {
  const parts = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    parts.push(tarHeader(entry.name, body.length, entry.mtimeMs || Date.now()));
    parts.push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));   // 结尾两个空块
  return gzipSync(Buffer.concat(parts));
}

// 把要备份的东西摊平成"包内路径 → 内容"，只收清单里的，别的路径一概不进包
function collectBackupEntries(stageExtra) {
  const entries = [...stageExtra];
  const walk = (abs, rel) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const child of fs.readdirSync(abs)) walk(path.join(abs, child), `${rel}/${child}`);
      return;
    }
    entries.push({ name: rel, data: fs.readFileSync(abs), mtimeMs: st.mtimeMs });
  };
  for (const rel of RECORD_DIRS) {
    const from = path.join(paths.root, rel);
    if (fs.existsSync(from)) walk(from, rel);
  }
  return entries;
}

// 数据库用 VACUUM INTO 取快照（在线直接拷 .db 会拿到半截 WAL 的坏档）
function snapshotDatabase() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bizhi-sentinel-db-'));
  const snap = path.join(stage, 'bizhi.db');
  try {
    getDb().exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
    return { stage, entries: [{ name: 'data/bizhi.db', data: fs.readFileSync(snap) }] };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function runSentinelBackup({ reason = '手动' } = {}) {
  const cfg = sentinelConfig();
  if (!cfg.ok) return { ok: false, reason: cfg.reason };
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const name = `bizhi-${stamp}.tar.gz`;   // 服务器只认这个形状，这里也照同一个形状生成
  const at = now.toISOString();
  let dbStage = '';
  try {
    const snap = snapshotDatabase();
    dbStage = snap.stage;
    const entries = collectBackupEntries(snap.entries);
    if (entries.length < 2) throw new Error(`快照里只有 ${entries.length} 个文件，不像完整的家底，没往服务器传`);
    const archive = buildTarGz(entries);
    if (archive.length > MAX_BACKUP_BYTES) throw new Error(`快照 ${Math.round(archive.length / 1e6)} MB，超过上限，没往服务器传`);
    const file = path.join(dbStage, name);
    fs.writeFileSync(file, archive);
    const sha256 = createHash('sha256').update(archive).digest('hex').slice(0, 16);
    const sent = await runSsh(cfg, `backup ${name}`, { stdinFile: file, timeoutMs: 180000 });
    const files = [...new Set(entries.map((e) => e.name.split('/')[0] === 'data' ? 'data' : e.name.split('/')[0]))];
    kvSetJson('sentinel_backup', { ok: sent.ok, at, name, bytes: archive.length, sha256, count: entries.length, files, reason: sent.reason || '', trigger: reason });
    if (sent.ok) addEvent('sentinel_backup', `把她的记忆存到异机一份（${Math.round(archive.length / 1024)} KB，${entries.length} 个文件）`, { name, bytes: archive.length, sha256 });
    else addEvent('sentinel_backup_failed', '这次备份没存到异机', { name, reason: sent.reason });
    return { ok: sent.ok, reason: sent.reason || '', name, bytes: archive.length, sha256, count: entries.length, files };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 140);
    kvSetJson('sentinel_backup', { ok: false, at, name, reason: message, trigger: reason });
    addEvent('sentinel_backup_failed', '这次备份没打成包', { reason: message });
    return { ok: false, reason: message };
  } finally {
    if (dbStage) fs.rmSync(dbStage, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
}

// 心跳说什么：只报读数，不报内容——服务器被翻也不该看到聊天记录。
export function sentinelHeartbeatPayload(extra = {}) {
  const settings = loadSettings();
  let free = 0;
  try { free = Math.round((os.freemem() / 1073741824) * 10) / 10; } catch { /* 拿不到就报 0 */ }
  return {
    app: 'bizhi',
    who: String(settings?.companion?.name || ''),
    qq: extra.qq === true,
    x: extra.x === true,
    xhs: extra.xhs === true,
    mock: extra.mock === true,
    freeGb: free,
    uptimeMin: Math.round(process.uptime() / 60),
  };
}
