import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { getMood } from './mood.js';
import { randInt } from './util.js';

const FILES = {
  happy: 'happy.png',
  shy: 'shy.png',
  surprised: 'surprised.png',
  blink: 'blink.png',
  normal: 'normal.png',
};

const PACK_DIR = path.join(paths.assets, 'stickers', 'deepseek-whale');
let PACK = {};
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'manifest.json'), 'utf8'));
  for (const item of manifest.items || []) {
    if (!item?.expression || !item?.file) continue;
    if (!PACK[item.expression]) PACK[item.expression] = [];
    PACK[item.expression].push(item.file);
  }
} catch {
  PACK = {};
}

const cache = new Map();

export function stickerNames() {
  const names = Object.keys(PACK);
  return names.length ? names : Object.keys(FILES);
}

export function getStickerBase64(name) {
  const packFiles = PACK[name];
  if (packFiles?.length) {
    const file = packFiles[randInt(0, packFiles.length - 1)];
    const full = path.join(PACK_DIR, file);
    if (!cache.has(full)) {
      if (!fs.existsSync(full)) return null;
      cache.set(full, fs.readFileSync(full).toString('base64'));
    }
    return cache.get(full);
  }

  const file = FILES[name];
  if (!file) return null;
  const full = path.join(paths.assets, 'stickers', file);
  if (!cache.has(full)) {
    if (!fs.existsSync(full)) return null;
    cache.set(full, fs.readFileSync(full).toString('base64'));
  }
  return cache.get(full);
}

export function pickSticker({ text = '', reply = '', settings = {}, mood = null } = {}) {
  const qq = settings.qq || {};
  if (qq.sendStickers === false) return null;
  if (/别(?:发|来|用|整).{0,3}(?:表情|贴纸|图)|不要(?:发|来|用).{0,3}(?:表情|贴纸|图)|不想看(?:表情|贴纸|图)/.test(text)) return null;

  const explicit = /表情包|表情|贴纸|发个图|发张|来张|卖萌|可爱|发个我看看|发来看看|发个看看|来一个|发一个/.test(text);
  const kaomoji = /(?:[（(][^）)\n]{1,20}[）)]|[\u{1F300}-\u{1FAFF}\u2600-\u27BF])/u.test(reply);
  const chance = Math.min(1, Math.max(0, Number(qq.stickerChance ?? 0.2)));
  if (!explicit && !(kaomoji && Math.random() < chance)) return null;

  const currentMood = mood || getMood();
  const options = ['happy', 'happy', 'blink'];
  if (/害羞|哼|才不|讨厌|脸红/.test(reply) || currentMood.affection >= 35) options.push('shy');
  if (/惊|欸|诶|真的|！|\?/.test(reply)) options.push('surprised');
  if (explicit) options.push('normal');
  return options[randInt(0, options.length - 1)];
}
