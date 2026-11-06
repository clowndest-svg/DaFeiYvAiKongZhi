import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { paths } from '../src/config.js';
import { acquireRuntimeLock } from '../src/runtime-lock.js';

test('同一数据目录不允许两个应用拥有；释放后允许重新启动', () => {
  const directory = path.join(paths.data, 'lock-test');
  const release = acquireRuntimeLock(directory);
  assert.throws(() => acquireRuntimeLock(directory), /已有应用/);
  release();
  const next = acquireRuntimeLock(directory);
  release(); // An old owner cannot remove the new owner's lock.
  assert.throws(() => acquireRuntimeLock(directory), /已有应用/);
  next();
});

test('只在原 PID 确认已退出后恢复遗留锁，破损锁不冒险覆盖', async () => {
  const directory = path.join(paths.data, 'stale-lock-test'); fs.mkdirSync(directory, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  child.kill(); await exited;
  const file = path.join(directory, 'app-runtime.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid }));
  const release = acquireRuntimeLock(directory); release();
  fs.writeFileSync(file, '{broken');
  assert.throws(() => acquireRuntimeLock(directory), /不完整/);
});
