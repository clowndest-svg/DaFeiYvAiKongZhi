import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const value = address.toLowerCase();
    const first = value.split(':')[0];
    const second = Number.parseInt(value.split(':')[1] || '0', 16);
    return /^[23][0-9a-f]{3}:/.test(value) && !(first === '2001' && (second < 0x200 || second === 0xdb8));
  }
  return false;
}

export function assertSafeImageUrl(raw) {
  const url = new URL(String(raw || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('图片地址协议不支持');
  if (url.username || url.password) throw new Error('图片地址不许带账号');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') && !isIP(host)) {
    throw new Error('图片地址不允许指向本机或内网');
  }
  if (isIP(host) && !isPublicAddress(host)) throw new Error('图片地址不允许指向内网或保留地址');
  return url;
}

export function imageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return '';
}

function requestImage(url, addresses, { signal, maxBytes, extraHeaders, request }) {
  return new Promise((resolve, reject) => {
    const transport = request || (url.protocol === 'https:' ? https.request : http.request);
    const req = transport(url, {
      signal,
      headers: { 'User-Agent': 'BiZhi/1.0', 'Accept-Encoding': 'identity', ...extraHeaders },
      lookup(_host, options, callback) {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = res.headers.location;
        res.destroy();
        if (!location) return reject(new Error('图片重定向没给目标'));
        return resolve({ location });
      }
      if (status < 200 || status >= 300) { res.destroy(); reject(new Error(`图片下载失败 HTTP ${status}`)); return; }
      if (Number(res.headers['content-length'] || 0) > maxBytes) { res.destroy(); reject(new Error('图片太大')); return; }
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); reject(new Error('图片响应压缩格式不支持')); return; }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { reject(new Error('图片太大')); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('aborted', () => reject(new Error('图片下载中断')));
      res.once('end', () => size ? resolve({ buffer: Buffer.concat(chunks) }) : reject(new Error('图片为空')));
    });
    req.once('error', reject);
    req.end();
  });
}

export async function fetchSafeImage(raw, {
  timeoutMs = 25000, maxBytes = 7 * 1024 * 1024, extraHeaders = {}, signal,
  resolveHost = lookup, request,
} = {}) {
  timeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.min(60000, Math.max(1, Math.trunc(timeoutMs))) : 25000;
  maxBytes = Number.isFinite(Number(maxBytes)) ? Math.min(32 * 1024 * 1024, Math.max(1, Math.trunc(maxBytes))) : 7 * 1024 * 1024;
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let url = assertSafeImageUrl(raw);
  for (let hop = 0; hop <= 3; hop += 1) {
    combined.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const resolution = isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : resolveHost(host, { all: true, verbatim: true });
    let onAbort;
    const addresses = await Promise.race([
      resolution,
      new Promise((_, reject) => { onAbort = () => reject(combined.reason); combined.addEventListener('abort', onAbort, { once: true }); }),
    ]).finally(() => combined.removeEventListener('abort', onAbort));
    if (!addresses?.length || addresses.some((item) => !isPublicAddress(item.address))) throw new Error('图片 DNS 解析指向内网或保留地址');
    const result = await requestImage(url, addresses, { signal: combined, maxBytes, extraHeaders, request });
    if (result.buffer) return result.buffer;
    url = assertSafeImageUrl(new URL(result.location, url).href);
  }
  throw new Error('图片重定向次数太多');
}
