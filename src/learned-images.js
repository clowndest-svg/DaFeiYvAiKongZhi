import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { kvGetJson, kvSetJson } from './db.js';
import { nowIso } from './util.js';
import { imageType } from './net.js';

const KEY = 'learned_images';
const MAX = 60;

function stickerDir() {
  const dir = path.join(paths.data, 'stickers-learned');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listLearnedImages() {
  const list = kvGetJson(KEY, []);
  return Array.isArray(list) ? list : [];
}

export function learnImage(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error('不是可学习的图片格式（只支持 png/jpeg/webp/gif）');
  const mime = match[1];
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error('图片太大或为空');
  if (imageType(buffer) !== mime) throw new Error('图片格式与实际内容不一致');
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
  const dir = stickerDir();
  const file = `${hash}.${ext}`;
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) fs.writeFileSync(full, buffer);

  const list = listLearnedImages().filter((item) => item.hash !== hash);
  list.push({ hash, file, mime, bytes: buffer.length, learnedAt: nowIso() });
  while (list.length > MAX) {
    const old = list.shift();
    try {
      fs.unlinkSync(learnedPath(old));
    } catch {
      // ignore
    }
  }
  kvSetJson(KEY, list);
  return list[list.length - 1];
}

function learnedPath(record) {
  const name = String(record?.file || '');
  if (!/^[a-f0-9]{16}\.(?:png|jpg|webp|gif)$/.test(name)) throw new Error('图片表情文件名不合法');
  const dir = fs.realpathSync(stickerDir());
  const full = path.join(dir, name);
  if (fs.existsSync(full) && path.dirname(fs.realpathSync(full)) !== dir) throw new Error('图片表情不能指向目录外');
  return full;
}

export function getLearnedImageBase64(record) {
  const full = learnedPath(record);
  return fs.readFileSync(full).toString('base64');
}

export function lastLearnedImage() {
  const list = listLearnedImages();
  return list[list.length - 1] || null;
}

export function randomLearnedImage() {
  const list = listLearnedImages();
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

export function clearLearnedImages() {
  const dir = stickerDir();
  for (const item of listLearnedImages()) {
    try {
      fs.unlinkSync(learnedPath(item));
    } catch {
      // ignore
    }
  }
  kvSetJson(KEY, []);
  return 0;
}
