import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths } from '../src/config.js';
import { configureStorage, cleanStorage } from '../src/storage.js';

const now = Date.now();
function fixture(name) {
  const root = path.join(paths.data, name, 'runtime');
  const storage = { root, tempRoot: path.join(root, 'tmp'), cache: path.join(root, 'cache') };
  for (const directory of [storage.tempRoot, ...['npm', 'pip', 'uv', 'playwright'].map(n => path.join(storage.cache, n))]) fs.mkdirSync(directory, { recursive: true });
  return storage;
}
function workspace(storage, pid, { age = 48 * 3600000, role = 'app', valid = true } = {}) {
  const directory = path.join(storage.tempRoot, `worker-${pid}-abcdef`);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ scope: valid ? 'bizhi-temp-v1' : 'foreign', pid, role, createdAt: now - age }));
  fs.writeFileSync(path.join(directory, 'temporary.bin'), Buffer.alloc(200));
  for (const file of fs.readdirSync(directory)) fs.utimesSync(path.join(directory, file), new Date(now - age), new Date(now - age));
  return directory;
}

test('临时与工具缓存统一位于指定数据目录，子进程继承且不改用户 APPDATA', () => {
  const previous = { ...process.env };
  try {
    const storage = configureStorage(path.join(paths.data, 'env-test'));
    for (const key of ['TEMP', 'TMP', 'TMPDIR', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'HF_HOME', 'TORCH_HOME', 'TORCH_EXTENSIONS_DIR', 'XDG_CACHE_HOME']) assert.ok(process.env[key].startsWith(storage.root + path.sep), key);
    assert.equal(process.env.APPDATA, previous.APPDATA);
    assert.equal(process.env.LOCALAPPDATA, previous.LOCALAPPDATA);
    const result = JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify({tmp:require("node:os").tmpdir(),pip:process.env.PIP_CACHE_DIR}))'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } }));
    assert.equal(result.tmp, storage.temp);
    assert.equal(result.pip, path.join(storage.cache, 'pip'));
  } finally { Object.assign(process.env, previous); }
});

test('只删除确认退出且过期的工作区；活动进程、子进程与未知归属保留', () => {
  const storage = fixture('lifecycle');
  const old = workspace(storage, 10001);
  const live = workspace(storage, 10002);
  const children = workspace(storage, 10003);
  const unknown = workspace(storage, 10004, { valid: false });
  const recent = workspace(storage, 10005, { age: 60000 });
  const result = cleanStorage(storage, { now, processAlive: pid => pid === 10002, hasLiveDescendants: pid => pid === 10003 });
  assert.equal(result.removedWorkspaces, 1);
  assert.equal(fs.existsSync(old), false);
  for (const file of [live, children, unknown, recent]) assert.equal(fs.existsSync(file), true);
});

test('容量清理保留新文件、安装运行时和链接目标，不越过本软件目录', () => {
  const storage = fixture('capacity');
  const old = workspace(storage, 20001, { age: 2 * 3600000 });
  const young = workspace(storage, 20002, { age: 60000 });
  const outside = path.join(paths.data, 'outside-canary'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(storage.tempRoot, 'worker-20003-abcdef'), 'junction');
  const result = cleanStorage(storage, { now, processAlive: () => false, hasLiveDescendants: () => false, maxTempBytes: 100 });
  assert.equal(result.removedWorkspaces, 1);
  assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(young), true);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('下载缓存按期限/容量清理，活跃工具阻止清理；浏览器安装缓存保留', () => {
  const storage = fixture('cache');
  const old = path.join(storage.cache, 'pip', 'old.bin'); fs.writeFileSync(old, 'old'); fs.utimesSync(old, new Date(now - 31 * 86400000), new Date(now - 31 * 86400000));
  const browser = path.join(storage.cache, 'playwright', 'browser.exe'); fs.writeFileSync(browser, 'installed');
  const worker = workspace(storage, 30001, { role: 'tool' });
  assert.equal(cleanStorage(storage, { now, processAlive: () => true, hasLiveDescendants: () => false }).cacheCleanupDeferred, true);
  assert.equal(fs.existsSync(old), true);
  fs.rmSync(worker, { recursive: true });
  assert.ok(cleanStorage(storage, { now, processAlive: () => false, hasLiveDescendants: () => false }).cacheRemovedBytes > 0);
  assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(browser), true);
});
