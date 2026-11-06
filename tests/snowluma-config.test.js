import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../src/config.js';
import { snowLumaConfig } from '../src/qq-provider.js';
import { validateSnowLumaConfig } from '../src/snowluma-package.js';
import { noteQqCapability, cookieExtensionsUnavailable, qqCapabilities } from '../src/qq-capabilities.js';
import { closeDb } from '../src/db.js';
test.after(closeDb);

test('全局默认、其他账号覆盖、地址/令牌/自动注入都必须通过校验', () => {
  const dir = path.join(paths.data, 'vendor-config');
  const configDir = path.join(dir, 'config'); fs.mkdirSync(configDir, { recursive: true });
  const config = snowLumaConfig({ account: '10000001', token: 'local-token', port: 9988 });
  const put = (name, data) => fs.writeFileSync(path.join(configDir, name), JSON.stringify(data));
  const args = { dir, botAccount: '10000001', token: 'local-token', wsUrl: 'ws://127.0.0.1:9988/onebot/snowluma' };
  put('runtime.json', config.runtime); put('onebot.json', config.global); put('onebot_10000001.json', config.account);
  assert.equal(validateSnowLumaConfig(args), true);
  put('onebot_10000002.json', config.account);
  assert.throws(() => validateSnowLumaConfig(args), /其他账号/);
  put('onebot_10000002.json', config.global);
  assert.throws(() => validateSnowLumaConfig({ ...args, token: 'wrong' }), /令牌/);
  put('runtime.json', { ...config.runtime, hookAutoLoad: true });
  assert.throws(() => validateSnowLumaConfig(args), /自动注入/);
});

test('只有两个空间扩展都明确不支持时才短暂熔断自动导入，其他能力保持独立', () => {
  noteQqCapability('get_cookies', 'unsupported');
  assert.equal(cookieExtensionsUnavailable(), false);
  noteQqCapability('get_credentials', 'unsupported');
  assert.equal(cookieExtensionsUnavailable(), true);
  noteQqCapability('send_private_msg', 'available');
  assert.equal(qqCapabilities().find(row => row.action === 'send_private_msg').state, 'available');
  noteQqCapability('get_cookies', 'available');
  assert.equal(cookieExtensionsUnavailable(), false);
});
