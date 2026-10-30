import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fetchSafeImage, isPublicAddress } from '../src/net.js';
import { buildSapiScript } from '../src/tts.js';

const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];
function fixtureRequest({ headers = {}, status = 200, chunks = [], lookupCheck = () => {} } = {}) {
  return (_url, options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      options.lookup('images.example.com', { all: true }, (_error, addresses) => lookupCheck(addresses));
      process.nextTick(() => {
        const res = new PassThrough();
        res.statusCode = status;
        res.headers = headers;
        callback(res);
        for (const chunk of chunks) if (!res.destroyed) res.write(chunk);
        if (!res.destroyed) res.end();
      });
    };
    return req;
  };
}

test('图片 DNS 私网/混合解析及映射 IPv6 均拒绝', async () => {
  for (const address of ['127.0.0.1', '100.64.0.1', '192.0.2.1', '2001:db8::1', '::ffff:127.0.0.1', '2001::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  let calls = 0;
  await assert.rejects(() => fetchSafeImage('https://images.example.com/a', { resolveHost: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], request: () => { calls += 1; } }), /DNS/);
  assert.equal(calls, 0);
});

test('图片连接固定解析结果、无 Content-Length 也受流式大小限制', async () => {
  let pinned = false;
  const result = await fetchSafeImage('https://images.example.com/a', { resolveHost: publicDns, maxBytes: 20, request: fixtureRequest({ chunks: [Buffer.alloc(12)], lookupCheck: (addresses) => { pinned = addresses[0].address === '8.8.8.8'; } }) });
  assert.equal(result.length, 12);
  assert.equal(pinned, true);
  await assert.rejects(() => fetchSafeImage('https://images.example.com/a', { resolveHost: publicDns, maxBytes: 20, request: fixtureRequest({ chunks: [Buffer.alloc(12), Buffer.alloc(12)] }) }), /太大/);
  await assert.rejects(() => fetchSafeImage('https://images.example.com/a', { resolveHost: publicDns, request: fixtureRequest({ status: 302, headers: { location: 'http://127.0.0.1/secret' } }) }), /内网/);
});

test('SAPI 文本和路径只作为 Base64 数据，不能成为脚本语句', () => {
  const text = '你好 $(Write-Output BAD); `" ${env:USERPROFILE}';
  const file = 'D:\\voice\\a$(BAD).wav';
  const script = buildSapiScript(text, file);
  assert.equal(script.includes(text), false);
  assert.equal(script.includes('Write-Output BAD'), false);
  const encoded = [...script.matchAll(/FromBase64String\('([^']+)'\)/g)].map((match) => Buffer.from(match[1], 'base64').toString('utf8'));
  assert.deepEqual(encoded, [text, file]);
  assert.match(script, /finally \{ \$s.Dispose\(\) \}/);
});
