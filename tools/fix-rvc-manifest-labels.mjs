// 清单里的 family 是下载当时按文件名猜的；口径改过之后要按同一套规则重算一遍，
// 别让 "Female Wojak" 这种被旧规则标成男声的条目一直错着。
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), 'voice', 'rvc', 'models', 'manifest.json');
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// 假名/汉字直接按码位判，省得在正则里写字符范围被工具链改字。
function hasCjk(text) {
  for (const ch of String(text)) {
    const c = ch.charCodeAt(0);
    if (c >= 0x3040 && c <= 0x30ff) return true;
    if (c >= 0x4e00 && c <= 0x9fff) return true;
  }
  return false;
}

function familyOf(name) {
  const text = String(name || '');
  const v = text.toLowerCase();
  if (/女声|御姐|萝莉|甜美|学姐|学妹|female|woman|girl/.test(v)) return '女声';
  if (hasCjk(text) && !/男声|\bmale\b|villain|marine|prisoner/.test(v)) return '女声';
  if (/男声|\bmale\b|villain|marine|prisoner|computer voice|\bguy\b|donald|trump|obama/.test(v)) return '男声或杂音';
  return '未标注';
}

let changed = 0;
for (const entry of data.entries) {
  const next = familyOf(`${entry.title} ${entry.path}`);
  if (next !== entry.family) {
    console.log(`改标：${entry.id} 「${entry.family}」→「${next}」（${entry.title.slice(0, 30)}）`);
    entry.family = next;
    changed += 1;
  }
}
data.generatedAt = new Date().toISOString();
fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
const counts = {};
for (const e of data.entries) counts[e.family] = (counts[e.family] || 0) + 1;
console.log(`共改 ${changed} 条；现在分布 ${JSON.stringify(counts)}`);
