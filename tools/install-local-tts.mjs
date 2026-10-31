// 把本地 matcha 中文音色装到 voice/matcha/。
// 需要显式运行（npm run tts:install-local）：产品代码不会自动下载权重。
// 注意 data-baker 数据集「仅供非商业使用」，所以这套权重只放本机，不进任何对外交付包。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const DIR = path.join(ROOT, 'voice', 'matcha');
const SOURCES = [
  { name: 'matcha-icefall-zh-baker.tar.bz2', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/matcha-icefall-zh-baker.tar.bz2', unpack: true },
  { name: 'vocos-22khz-univ.onnx', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-22khz-univ.onnx', unpack: false },
];

fs.mkdirSync(DIR, { recursive: true });

for (const item of SOURCES) {
  const target = path.join(DIR, item.name);
  if (fs.existsSync(target) && fs.statSync(target).size > 1024 * 1024) {
    console.log(`已有 ${item.name}（${fs.statSync(target).size} 字节），跳过下载`);
  } else {
    console.log(`下载 ${item.url}`);
    const r = spawnSync('curl', ['-sSL', '--retry', '3', '--max-time', '900', '-o', target, item.url], { stdio: 'inherit', windowsHide: true });
    if (r.status !== 0 || !fs.existsSync(target)) {
      console.error(`下载失败：${item.name}（exit ${r.status}）`);
      process.exit(1);
    }
  }
  if (item.unpack) {
    const tmp = path.join(DIR, '_unpack');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const u = spawnSync('tar', ['-xf', target, '-C', tmp], { stdio: 'inherit', windowsHide: true });
    if (u.status !== 0) {
      console.error('解压失败：需要能处理 bz2 的 tar（Windows 10+ 自带 tar.exe 可以）');
      process.exit(1);
    }
    const inner = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((p) => fs.statSync(p).isDirectory());
    for (const name of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, name), path.join(DIR, name));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const need = ['model-steps-3.onnx', 'vocos-22khz-univ.onnx', 'lexicon.txt', 'tokens.txt', 'dict', 'date.fst', 'number.fst', 'phone.fst'];
const missing = need.filter((n) => !fs.existsSync(path.join(DIR, n)));
console.log(missing.length ? `还缺：${missing.join('、')}` : `装好了：${DIR}`);
process.exitCode = missing.length ? 1 : 0;
