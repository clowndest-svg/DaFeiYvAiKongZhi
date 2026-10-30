export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function assertJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求体必须是 JSON 对象');
  const visit = (node, depth) => {
    if (depth > 12) throw new HttpError(400, 'JSON 嵌套太深');
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new HttpError(400, 'JSON 包含不允许的字段');
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return value;
}

export function assertCsrf(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET')) return;
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') throw new HttpError(403, '拒绝跨站请求');
  if ((origin || site) && req.headers['x-bizhi-request'] !== '1') throw new HttpError(403, '拒绝缺少同源校验的请求');
  if (origin) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('origin');
    } catch { throw new HttpError(403, '拒绝不合法的请求来源'); }
  }
}

export async function readJsonBody(req, limit = 256 * 1024) {
  if (Number(req.headers['content-length'] || 0) > limit) { req.resume(); throw new HttpError(413, '请求体太大（图片请先压缩）'); }
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => { if (!settled) { settled = true; chunks.length = 0; reject(error); } };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) return fail(new HttpError(413, '请求体太大（图片请先压缩）'));
      chunks.push(chunk);
    });
    req.once('aborted', () => fail(new HttpError(400, '请求已中断')));
    req.once('error', fail);
    req.once('end', () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const result = assertJsonObject(raw ? JSON.parse(raw) : {});
        settled = true;
        resolve(result);
      } catch (error) { fail(error instanceof HttpError ? error : new HttpError(400, '请求体不是合法 JSON')); }
    });
  });
}
