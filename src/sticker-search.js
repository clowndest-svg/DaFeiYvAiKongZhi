import { loadSettings } from './config.js';
import { addEvent, kvGetJson, kvSetJson } from './db.js';
import { logger } from './logger.js';
import { fetchSafeImage } from './net.js';
import { learnImage, listLearnedImages } from './learned-images.js';
import { privacyProblems } from './privacy.js';
import { nowIso } from './util.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ADOPT_KEY = 'sticker_adopt_day';
const DAILY_MAX = 12;
const MAX_BYTES = 4 * 1024 * 1024;

function localDayKey() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function sniffType(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length > 6 && buf.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  return '';
}

function adoptedToday() {
  const record = kvGetJson(ADOPT_KEY, { day: localDayKey(), count: 0 });
  return record.day === localDayKey() ? Number(record.count || 0) : 0;
}

function bumpAdopted(n) {
  const current = adoptedToday();
  kvSetJson(ADOPT_KEY, { day: localDayKey(), count: current + n });
}

export function stickerLibraryStatus() {
  return { total: listLearnedImages().length, adoptedToday: adoptedToday(), dailyMax: DAILY_MAX };
}

export function parseBingImageHtml(html, { query = '', limit = 12 } = {}) {
  const found = [];
  const seen = new Set();
  for (const match of String(html).matchAll(/murl&quot;:&quot;(https?:[^&"]{10,400})/g)) {
    let target = match[1];
    try {
      target = target.replace(/\\u002f/g, '/').replace(/\\u0026/g, '&');
      const parsed = new URL(target);
      parsed.search = '';
      parsed.hash = '';
      target = parsed.toString();
    } catch {
      continue;
    }
    if (seen.has(target)) continue;
    seen.add(target);
    found.push({ url: target, query, source: 'bing' });
    if (found.length >= Math.max(1, Number(limit) || 12)) break;
  }
  return found;
}

export async function searchStickerImages(query, { limit = 12 } = {}) {
  const q = String(query || '').trim().slice(0, 60);
  if (!q) throw new Error('要搜什么图？给个关键词');
  const problems = privacyProblems(q, loadSettings());
  if (problems.length) {
    addEvent('sticker_query_blocked', '她想搜的图里带了不该外送的字', { problems: problems.slice(0, 2) });
    throw new Error(`这个关键词我不往外发：${problems[0]}`);
  }
  const count = Math.min(35, Math.max(5, Number(limit) * 3));
  const url = `https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=0&count=${count}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`图片搜索返回 HTTP ${res.status}`);
  const html = await res.text();
  const found = parseBingImageHtml(html, { query: q, limit });
  logger.info('图片搜索完成', { query: q, hits: found.length });
  return found;
}

export async function listMemeTemplates({ limit = 12 } = {}) {
  const res = await fetch('https://api.imgflip.com/get_memes', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`梗图模板接口返回 HTTP ${res.status}`);
  const data = await res.json();
  const memes = data?.data?.memes || [];
  return memes.slice(0, Math.max(1, Number(limit) || 12)).map((m) => ({
    url: String(m.url || ''),
    name: String(m.name || '').slice(0, 60),
    source: 'imgflip',
  }));
}

export async function adoptStickerImage(url) {
  if (adoptedToday() >= DAILY_MAX) throw new Error('今天收的图到上限了（12 张），明天再收');
  const buf = await fetchSafeImage(url, {
    timeoutMs: 25000,
    maxBytes: MAX_BYTES,
    extraHeaders: { Referer: new URL(url).origin + '/' },
  });
  const mime = sniffType(buf);
  if (!mime) throw new Error('内容不是 png/jpeg/webp/gif');
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  const record = learnImage(dataUrl);
  if (record) bumpAdopted(1);
  return record;
}

export async function findAndAdoptStickers({ query, limit = 3 } = {}) {
  const wanted = Math.max(1, Math.min(6, Number(limit) || 3));
  const room = DAILY_MAX - adoptedToday();
  if (room <= 0) return { ok: true, query, adopted: [], skipped: '今天收图已到上限' };
  const candidates = await searchStickerImages(query, { limit: wanted * 3 });
  const adopted = [];
  const failed = [];
  for (const item of candidates) {
    if (adopted.length >= Math.min(wanted, room)) break;
    try {
      const record = await adoptStickerImage(item.url);
      if (record) adopted.push({ file: record.file, bytes: record.bytes, from: item.url.slice(0, 120) });
    } catch (error) {
      failed.push(error.message);
    }
  }
  if (adopted.length) {
    addEvent('sticker_adopt', `她自己找了 ${adopted.length} 张图收进表情库`, { query, adopted: adopted.length });
  } else {
    addEvent('sticker_adopt_empty', '她去搜了图，但没有能收进来的', { query, errors: failed.slice(0, 3) });
  }
  logger.info('找图收库完成', { query, adopted: adopted.length, failed: failed.length });
  return { ok: true, query, adopted, failed: failed.slice(0, 3), at: nowIso() };
}
