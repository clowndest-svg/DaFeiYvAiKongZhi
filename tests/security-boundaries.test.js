import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startTestServer } from './helpers/runtime.js';

const { normalizeSettings } = await import('../src/config.js');
const { buildChatPayload } = await import('../src/prompt.js');
const { leaksFromChat } = await import('../src/privacy.js');

test('非法设置块不能抛 TypeError 或污染原型', () => {
  assert.doesNotThrow(() => normalizeSettings({ qq: null, model: [], social: 'bad' }));
  const settings = normalizeSettings(JSON.parse('{"__proto__":{"polluted":true},"qq":{"constructor":{"prototype":{"enabled":true}}}}'));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(settings), Object.prototype);
});

test('群聊与访客提示词不携带主人名字和私密情绪原因', () => {
  const settings = normalizeSettings({ companion: { userName: 'PRIVATEUSER', nickname: 'PRIVATENICK' } });
  for (const channel of ['qq-group', 'qq-guest']) {
    const result = buildChatPayload({ settings, mood: { valence: 0, energy: 0.5, affection: 20, label: '平静', reason: 'PRIVATEREASON' }, block: { core: [], mid: [], long: [], innerThoughts: [] }, history: [{ role: 'user', content: '你好' }], channel });
    for (const privateValue of ['PRIVATEUSER', 'PRIVATENICK', 'PRIVATEREASON']) assert.equal(result.system.includes(privateValue), false, `${channel}: ${privateValue}`);
  }
});

test('私聊照搬检测统一标点、空白与 Unicode', () => {
  assert.ok(leaksFromChat('庭院后门，钥匙藏在，花盆底下', ['庭院后门钥匙藏在花盆底下']).length);
  assert.ok(leaksFromChat('我的代码是ＡＢＣＤ１２３４', ['我的代码是ABCD1234']).length);
});

test('私密媒体和跨站副作用都受会话边界保护', async (t) => {
  const app = await startTestServer(t, { password: 'test-password' });
  fs.writeFileSync(path.join(app.dir, 'media', 'xhs-shot-test.png'), Buffer.alloc(20));
  const noAuth = await fetch(`${app.base}/media/xhs-shot-test.png`);
  assert.equal(noAuth.status, 401);
  const login = await fetch(`${app.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BiZhi-Request': '1' }, body: JSON.stringify({ password: 'test-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const media = await fetch(`${app.base}/media/xhs-shot-test.png`, { headers: { Cookie: cookie } });
  assert.equal(media.status, 200);
  assert.match(media.headers.get('cache-control'), /no-store/);
  const cross = await fetch(`${app.base}/api/actions/reset-schedule`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.invalid', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.status, 403);
  const logout = await fetch(`${app.base}/api/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.invalid' } });
  assert.equal(logout.status, 403);
  const stillValid = await fetch(`${app.base}/api/status`, { headers: { Cookie: cookie } });
  assert.equal(stillValid.status, 200);
});

test('损坏 URL、Cookie 与 JSON 类型有确定错误响应', async (t) => {
  const app = await startTestServer(t, { password: 'test-password' });
  const malformed = await new Promise((resolve, reject) => {
    const request = http.get(`${app.base}/api/%E0%A4%A`, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    request.setTimeout(1500, () => request.destroy(new Error('Malformed URL hung')));
    request.on('error', reject);
  });
  assert.equal(malformed, 400);
  const badCookie = await fetch(`${app.base}/api/status`, { headers: { Cookie: 'bz_session=%' } });
  assert.equal(badCookie.status, 401);
  const badJson = await fetch(`${app.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BiZhi-Request': '1' }, body: 'null' });
  assert.equal(badJson.status, 400);
});
