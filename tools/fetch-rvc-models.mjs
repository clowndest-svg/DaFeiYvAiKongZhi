// 下载 RVC 音色模型库：只列真存在的文件、只下真下得动的，逐个校验并写清单。
// 用法：node tools/fetch-rvc-models.mjs [--limit=N] [--check]
//   --check 只列目录不下载。默认上限 40 个。
// 全程走本机代理（直连 huggingface 在这张网上是 000 超时），产物只落 voice/rvc/，不进仓库。
import './project-env.mjs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const HOME = path.join(ROOT, 'voice', 'rvc');
const MODELS = path.join(HOME, 'models');
const CACHE = path.join(MODELS, 'downloads');
const MANIFEST = path.join(MODELS, 'manifest.json');
const PROXY = process.env.RVC_PROXY || 'http://127.0.0.1:7897';
const PY = path.join(ROOT, 'voice', 'rvc-env', 'Scripts', 'python.exe');
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 40);

for (const dir of [MODELS, CACHE]) fs.mkdirSync(dir, { recursive: true });

function curl(args, timeout = 600000) {
  return spawnSync('curl', ['-sS', '--max-time', String(Math.round(timeout / 1000)), '-x', PROXY, ...args], { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function tree(repo) {
  const r = curl([`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`], 60000);
  if (r.status !== 0 || !r.stdout) throw new Error(`${repo} 列目录失败：${String(r.stderr || r.status).slice(0, 80)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${repo} 返回的不是 JSON`);
  }
}

const enc = (p) => String(p).split('/').map((seg) => encodeURIComponent(seg)).join('/');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// 目录名要能在 Windows/Linux 都建得出来：中文一律换成连字符，真正给人看的名字留在 manifest 的 title 里。
const slug = (name) => String(name).replace(/[\u3040-\u30ff\u4e00-\u9fff]+/g, '-').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 46) || 'model';

// 名称里能读出来的线索只照抄，不猜。注意 female 里也含 "male"，所以女声必须先判。
function familyOf(name) {
  const text = String(name || '');
  const v = text.toLowerCase();
  if (/女声|御姐|萝莉|甜美|学姐|学妹|female|woman|girl/.test(v)) return '女声';
  if (/[\u3040-\u30ff]/.test(text) && !/男声|\bmale|villain|marine|prisoner/.test(v)) return '女声';
  if (/男声|\bmale\b|villain|marine|prisoner|computer voice|\bguy\b|donald|trump|obama/.test(v)) return '男声或杂音';
  return '未标注';
}

const SOURCES = [
  { repo: 'TASTomusan/RVC_Models_Collection_Series', pick: (f) => f.path.toLowerCase().endsWith('.zip') },
  { repo: 'Wismut/RVC_US_Female_1', pick: (f) => f.path.toLowerCase().endsWith('.pth') },
  // 这批文件名里就写着「女声-…」，其中包含他要的御姐档；只取女声，男声和卡通音不进库。
  { repo: 'chaye741/RVC-Voice-Models', pick: (f) => /\.pth$/i.test(f.path) && /女声/.test(f.path) },
  { repo: 'Elesis/RVC_Models', pick: (f) => /\.pth$/i.test(f.path) },
  { repo: 'NotInt/girl_voice_rvc', pick: (f) => /\.pth$/i.test(f.path) },
];

const catalog = [];
const errors = [];
for (const source of SOURCES) {
  try {
    for (const f of tree(source.repo).filter(source.pick)) {
      if (!f.size) continue; // 目录节点或空文件
      catalog.push({ repo: source.repo, path: f.path, bytes: f.size });
    }
  } catch (error) {
    errors.push(`${source.repo}: ${error.message}`);
  }
}

const wanted = catalog.filter((item) => familyOf(path.basename(item.path)) !== '男声或杂音').slice(0, LIMIT);
console.log(`目录里共 ${catalog.length} 个模型文件，本轮要下 ${wanted.length} 个（跳过明显男声/机器音）`);
for (const e of errors) console.log('  列目录失败：' + e);
if (CHECK_ONLY) {
  for (const item of wanted) console.log(`  ${(item.bytes / 1e6).toFixed(1)}MB ${item.repo} :: ${item.path.slice(0, 70)}`);
  process.exit(0);
}

// 基座权重：rvc_python 一被构造就自己 requests.get 直连 HF——这张网直连不通，所以先手动放好。
const BASE_DIR = path.join(ROOT, 'voice', 'rvc-env', 'Lib', 'site-packages', 'rvc_python', 'base_model');
fs.mkdirSync(BASE_DIR, { recursive: true });
const BASE = [
  ['hubert_base.pt', 'https://huggingface.co/Daswer123/RVC_Base/resolve/main/hubert_base.pt', 120_000_000],
  ['rmvpe.pt', 'https://huggingface.co/Daswer123/RVC_Base/resolve/main/rmvpe.pt', 100_000_000],
  ['rmvpe.onnx', 'https://huggingface.co/Daswer123/RVC_Base/resolve/main/rmvpe.onnx', 60_000_000],
];
for (const [name, url, min] of BASE) {
  const file = path.join(BASE_DIR, name);
  if (fs.existsSync(file) && fs.statSync(file).size > min) {
    console.log(`基座 ${name} 已在（${(fs.statSync(file).size / 1e6).toFixed(0)}MB）`);
    continue;
  }
  const r = curl(['-L', '-C', '-', '-o', file, url], 1800000);
  const ok = fs.existsSync(file) && fs.statSync(file).size > min;
  console.log(`基座 ${name} 下载${ok ? '完成' : '失败'}${ok ? '' : '：' + String(r.stderr || r.status).slice(0, 80)}`);
}

const entries = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).entries || [] : [];
const bySource = new Map(entries.map((e) => [`${e.repo}::${e.path}`, e]));

function pyExtract(zipFile, outDir) {
  const script = [
    'import io,os,sys,zipfile',
    'src,out=sys.argv[1],sys.argv[2]',
    'os.makedirs(out,exist_ok=True)',
    'zf=zipfile.ZipFile(src)',
    'for i in zf.infolist():',
    '    n=i.filename',
    '    if n.lower().endswith(".zip"):',
    '        inner=zipfile.ZipFile(io.BytesIO(zf.read(n)))',
    '        for k in inner.infolist():',
    '            if k.filename.lower().endswith((".pth",".index")):',
    '                open(os.path.join(out,os.path.basename(k.filename)),"wb").write(inner.read(k.filename))',
    '    elif n.lower().endswith((".pth",".index")):',
    '        open(os.path.join(out,os.path.basename(n)),"wb").write(zf.read(n))',
    '    elif n.lower().endswith(".wav") and i.file_size<1_500_000:',
    '        open(os.path.join(out,"sample-"+os.path.basename(n)),"wb").write(zf.read(n))',
    'print("done")',
  ].join('\n');
  const r = spawnSync(PY, ['-I', '-c', script, zipFile, outDir], { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return { ok: r.status === 0, out: String(r.stdout || '') + String(r.stderr || '') };
}

let downloaded = 0;
let failed = 0;
for (const item of wanted) {
  const key = `${item.repo}::${item.path}`;
  const existing = bySource.get(key);
  const stem = path.basename(item.path, path.extname(item.path));
  const id = `${slug(stem)}-${crypto.createHash('sha1').update(item.path).digest('hex').slice(0, 6)}`;
  const dir = path.join(MODELS, id);
  if (existing && existing.ok && existing.pth && fs.existsSync(path.join(ROOT, existing.pth))) {
    console.log(`跳过（清单里已有且文件在）：${id}`);
    continue;
  }
  const raw = path.join(CACHE, `${id}${path.extname(item.path) || '.bin'}`);
  if (!fs.existsSync(raw) || (item.bytes && fs.statSync(raw).size !== item.bytes)) {
    const r = curl(['-L', '-C', '-', '-o', raw, `https://huggingface.co/${item.repo}/resolve/main/${enc(item.path)}`], 1800000);
    if (!fs.existsSync(raw)) {
      failed += 1;
      console.log(`下载失败：${item.path.slice(0, 40)} → ${String(r.stderr || r.status).slice(0, 90)}`);
      continue;
    }
  }
  const size = fs.statSync(raw).size;
  if (item.bytes && size !== item.bytes) {
    failed += 1;
    console.log(`大小不符：${id} 期望 ${item.bytes} 实到 ${size}`);
    fs.rmSync(raw, { force: true });
    continue;
  }
  fs.mkdirSync(dir, { recursive: true });
  if (/\.zip$/i.test(item.path)) {
    const ex = pyExtract(raw, dir);
    if (!ex.ok) {
      failed += 1;
      console.log(`解压失败：${id} → ${ex.out.slice(0, 90)}`);
      continue;
    }
  } else {
    fs.copyFileSync(raw, path.join(dir, path.basename(item.path)));
  }
  const found = fs.readdirSync(dir);
  const pth = found.filter((n) => n.toLowerCase().endsWith('.pth'))[0];
  if (!pth) {
    failed += 1;
    console.log(`没有 .pth：${id}（${found.join(',').slice(0, 60)}）`);
    continue;
  }
  const idx = found.filter((n) => n.toLowerCase().endsWith('.index'))[0];
  const sample = found.filter((n) => n.toLowerCase().endsWith('.wav'))[0];
  const chinese = (String(item.path).match(/女声-[^/]+/) || [])[0];
  bySource.set(key, {
    id,
    repo: item.repo,
    path: item.path,
    title: (chinese || stem).replace(/\s*\(RVC\s*v?2?\s*-\s*\d+\s*[Ee]pochs?\)\s*/i, '').trim(),
    family: familyOf(path.basename(item.path)),
    bytes: size,
    sha256: sha256(raw),
    pth: path.relative(ROOT, path.join(dir, pth)).split(path.sep).join('/'),
    index: idx ? path.relative(ROOT, path.join(dir, idx)).split(path.sep).join('/') : '',
    sample: sample ? path.relative(ROOT, path.join(dir, sample)).split(path.sep).join('/') : '',
    ok: true,
    at: new Date().toISOString(),
  });
  downloaded += 1;
  const entry = bySource.get(key);
  console.log(`✓ ${entry.family} ${(size / 1e6).toFixed(0)}MB ${entry.title.slice(0, 40)}`);
  fs.writeFileSync(MANIFEST, JSON.stringify({ generatedAt: entry.at, entries: [...bySource.values()] }, null, 2), 'utf8');
}

const list = [...bySource.values()];
fs.writeFileSync(MANIFEST, JSON.stringify({ generatedAt: new Date().toISOString(), entries: list }, null, 2), 'utf8');
console.log(`\n本轮新下 ${downloaded} 个、失败 ${failed} 个；清单里可用 ${list.filter((e) => e.ok).length} 个 → ${path.relative(ROOT, MANIFEST)}`);
