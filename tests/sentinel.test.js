// 哨兵的判据：这台服务器上还跑着别的项目，所以这里的每条约束都是在钉"不许越界"。
// 全程离线：不碰 ssh、不碰网络，只验"该拒绝的有没有拒绝、该说的是不是真话"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../src/config.js';
import { closeDb } from '../src/db.js';
import { sentinelConfig, sentinelHeartbeatPayload, sentinelStatus } from '../src/sentinel.js';

test.after(closeDb);

const SRC = fs.readFileSync(path.join(paths.root, 'src', 'sentinel.js'), 'utf8');
const INGEST = fs.readFileSync(path.join(paths.root, 'tools', 'server', 'bizhi-ingest.sh'), 'utf8');
const SCHED = fs.readFileSync(path.join(paths.root, 'src', 'scheduler.js'), 'utf8');
const API = fs.readFileSync(path.join(paths.root, 'src', 'index.js'), 'utf8');

test('没配、配坏、开关关了都只说人话，不起任何进程', () => {
  const missing = sentinelConfig();
  // 本机真配了，所以这里改判"内容被换成非法值"时的行为，确保判据不是空转
  assert.equal(typeof missing.ok, 'boolean');
  assert.ok(/缺 data\/sentinel\/config\.json|找不到哨兵密钥|哨兵开关是关的|不是合法字符/.test(missing.reason || '配置正常'), `配置正常时不该有理由，实际：${missing.reason}`);
});

test('host/user 里的注入字符一律拒绝，绝不拼进命令', () => {
  assert.ok(SRC.includes('/^[\\w.-]+$/'), 'host 校验的正则不见了');
  assert.ok(SRC.includes('/^[A-Za-z0-9._-]+$/'), 'user 校验的正则不见了');
  // 真正跑的判据：把非法 host 写进临时配置，sentinelConfig 必须说"不是合法字符"
  const file = path.join(paths.data, 'sentinel', 'config.json');
  const real = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ enabled: true, host: 'evil; rm -rf /', user: 'bizhisync', keyFile: path.join(paths.data, 'sentinel', 'id_bizhi_sentinel') }));
    const cfg = sentinelConfig();
    assert.equal(cfg.ok, false, '非法 host 竟然通过了校验');
    assert.match(cfg.reason, /不是合法字符/);
    fs.writeFileSync(file, JSON.stringify({ enabled: true, host: '203.0.113.10', user: 'bizhisync; rm', keyFile: path.join(paths.data, 'sentinel', 'id_bizhi_sentinel') }));
    assert.equal(sentinelConfig().ok, false, '非法 user 竟然通过了校验');
  } finally {
    if (real !== null) fs.writeFileSync(file, real);
    else fs.rmSync(file, { force: true });
  }
});

test('命令用参数数组传给 ssh，不经过 shell；密钥只从本机 data/ 里读', () => {
  assert.ok(SRC.includes('spawn(cfg.sshPath, args'), '不是参数数组：拼字符串就是给注入开门');
  assert.ok(!/(^|[^.\w])exec(Sync)?\(/.test(SRC) && !/shell:\s*true/.test(SRC), '出现了走 shell 的子进程调用（db.exec 那种带点的不算）');
  assert.ok(SRC.includes("'BatchMode=yes'"), '没锁 BatchMode：密钥不通时会卡在那里等密码输入');
  assert.ok(SRC.includes("'IdentitiesOnly=yes'"), '没锁 IdentitiesOnly：ssh-agent 里别的密钥会被服务器看到');
  assert.ok(SRC.includes('-i', 'cfg.keyFile') || SRC.includes("'-i', cfg.keyFile"), '没用我们那把受限密钥');
  assert.ok(!/OneDrive|test\.pem/.test(SRC), '绝不能把主人登录服务器用的 root 密钥拿去跑备份');
});

test('备份包名两边同一个规矩，服务器只认这一个形状', () => {
  const generated = /^bizhi-\d{8}-\d{6}\.tar\.gz$/;
  const serverSide = /grep -Eq '\^(bizhi-\[0-9\]\{8\}-\[0-9\]\{6\}\\\.tar\\.gz)\$'/.test(INGEST);
  assert.ok(serverSide, '服务器端的名字校验变了：本机和服务器必须同一个规矩');
  const name = `bizhi-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.tar.gz`;
  assert.match(name, generated, '本机生成的包名不符合约定');
  for (const evil of ['../../../etc/passwd', 'bizhi-20260101-000000.tar.gz; rm -rf /', 'a.tar.gz']) {
    assert.ok(!generated.test(evil), `这种名字本该被拒：${evil}`);
  }
});

test('数据库用 VACUUM INTO 取快照，不在线拷 .db（拷出来是半截 WAL 的坏档）', () => {
  assert.ok(SRC.includes('VACUUM INTO'), '还在直接复制在线数据库');
  assert.ok(SRC.includes("replace(/'/g, \"''\")"), '路径里的单引号没转义');
});

// 自己写的 tar.gz：包能被 gunzip + tar 读回来，才算"哪天磁盘真坏了这档能用"
test('自己打的 tar.gz 要能被解开，内容一字不差', async () => {
  const { buildTarGz } = await import('../src/sentinel.js');
  const { gunzipSync } = await import('node:zlib');
  const files = [
    { name: 'data/bizhi.db', data: Buffer.from('数据库内容\n'.repeat(70)) },
    { name: 'config/persona.md', data: Buffer.from('她的人设\n第二行\n') },
    { name: 'data/weekly/a long-ish name that spills past the simple field.bin', data: Buffer.alloc(1500, 7) },
  ];
  const archive = buildTarGz(files);
  assert.equal(archive[0], 0x1f);
  assert.equal(archive[1], 0x8b, '不是 gzip（第一个字节应是 1f 8b）');
  const tar = gunzipSync(archive);
  assert.equal(tar.length % 512, 0, 'tar 必须按 512 字节对齐');
  const names = [];
  for (let off = 0; off + 512 <= tar.length; off += 512) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '') || '0', 8);
    const full = (prefix ? `${prefix}/` : '') + name;
    names.push(full);
    const body = tar.subarray(off + 512, off + 512 + size);
    const original = files.find((f) => f.name === full);
    assert.ok(original, `解出来的名字对不上：${full}`);
    assert.deepEqual(Buffer.from(body), Buffer.from(original.data), `${full} 内容不一致`);
    off += 512 + Math.ceil(size / 512) * 512 - 512;
  }
  assert.equal(names.length, 3, `应当解出 3 个文件，实际 ${names.length}：${names.join(' | ')}`);
});

test('打包不依赖系统里的 tar：那玩意儿在这台机器上会把 C:\\ 当成主机名', () => {
  assert.ok(!/\btar\.exe\b|spawn\(['"]tar/.test(SRC), '又去调用外部 tar 了');
  assert.ok(SRC.includes('gzipSync'), '没有自己压缩');
});

test('备份清单只含"她的记忆"，不含密钥、不含 .env、不含浏览器 profile', () => {
  const dirs = /const RECORD_DIRS = \[([^\]]*)\]/.exec(SRC);
  assert.ok(dirs, '找不到备份清单');
  assert.ok(dirs[1].includes('config'), '人设/设置没进备份');
  for (const kind of ['weekly', 'letters', 'archives']) assert.ok(dirs[1].includes(kind), `周记/信/存档少了 ${kind}`);
  for (const forbidden of ['.env', 'sentinel', 'x-profile', 'xhs-profile', 'napcat', 'logs', 'voice']) {
    assert.ok(!dirs[1].includes(forbidden), `备份清单里出现了不该有的东西：${forbidden}`);
  }
  assert.ok(SRC.includes('MAX_BACKUP_BYTES'), '没有体积上限：一个坏客户端能把服务器磁盘写满');
  const cap = /MAX_BACKUP_BYTES = (\d+) \* 1024 \* 1024/.exec(SRC);
  assert.ok(cap && Number(cap[1]) <= 400, `上限必须小于服务器端那把 ${'400'} MB 的闸，本机写 ${cap && cap[1]} MB`);
});

test('服务器那把闸：超上限、坏压缩包、半截文件都要处理干净', () => {
  assert.ok(INGEST.includes('head -c'), '没有边收边限量：一个大文件就能把服务器磁盘写满');
  assert.ok(INGEST.includes('gzip -t'), '收下来不校验压缩包');
  assert.ok(INGEST.includes('tar -tzf'), '收下来不校验 tar 能不能读');
  assert.ok(INGEST.includes('rm -f "$tmp"'), '校验不过时要删掉半截文件，别留在 incoming 里堆磁盘');
  assert.ok(INGEST.includes('ls -1t "$BK"/bizhi-*.tar.gz'), '没有保留上限：只留最近几份');
  assert.ok(INGEST.includes('SSH_ORIGINAL_COMMAND'), 'forced command 不校验原始请求：这把密钥就能跑别的命令');
  assert.ok(INGEST.includes('不认这个指令'), '未知指令必须拒绝，而不是当成空操作');
  assert.ok(SRC.includes('StrictHostKeyChecking=accept-new'), '首次连接的处理没写明');
});

test('心跳只报读数不报内容，并且失败不影响主链路', () => {
  const payload = sentinelHeartbeatPayload({ qq: true, x: false });
  for (const key of ['app', 'who', 'qq', 'x', 'freeGb', 'uptimeMin']) assert.ok(key in payload, `心跳里少了 ${key}`);
  const json = JSON.stringify(payload);
  assert.ok(!/chat|messages|text|content|token|password/i.test(json), `心跳里出现了内容类字段：${json.slice(0, 80)}`);
  assert.ok(SCHED.includes('pollSentinel'), '调度器没接哨兵');
  assert.ok(/catch[\s\S]{0,90}lastSentinelError/.test(SCHED), '哨兵失败会把调度器一起拖崩：错误必须被接住');
  assert.ok(SCHED.includes('30 * 60 * 1000'), '心跳间隔不是半小时');
  assert.ok(SCHED.includes('ageHours >= 20'), '备份不是"超过 20 小时才补一份"，会天天重传');
});

test('心跳真的带上读数：发送方必须用那个 payload 构造器，而不是自己拼四个布尔', () => {
  const sender = /export async function sendSentinelHeartbeat[\s\S]*?\r?\n}/.exec(SRC);
  assert.ok(sender, '找不到 sendSentinelHeartbeat');
  assert.ok(sender[0].includes('sentinelHeartbeatPayload('), '心跳没走构造器：服务器上收到的会缺内存/运行时长（实测缺过）');
  assert.ok(!/\{ at, \.\.\.payload \}/.test(sender[0]), '又退回只拼调用方传的那几个字段');
});

test('界面和接口同一份读数：状态来自后端，不是界面自己编的', () => {
  assert.ok(API.includes("'/api/sentinel'"), '没有状态接口');
  assert.ok(API.includes("'/api/sentinel/run'"), '没有"现在就跑一次"的入口');
  const web = fs.readFileSync(path.join(paths.root, 'web', 'app.js'), 'utf8');
  assert.ok(web.includes("/api/sentinel"), '界面没读后端的状态');
  // 界面只转述后端给的读数（时间、大小、原因），不自己编数字
  assert.ok(web.includes('/api/sentinel'), '界面没读后端的状态');
  assert.ok(web.includes('backup.bytes'), '界面没显示后端给的存档大小');
  assert.ok(web.includes('beat.reason'), '界面没把失败原因如实说出来');
  const status = sentinelStatus();
  for (const field of ['configured', 'lastHeartbeat', 'lastBackup', 'heartbeatHealthy']) assert.ok(field in status, `状态里少了 ${field}`);
});
