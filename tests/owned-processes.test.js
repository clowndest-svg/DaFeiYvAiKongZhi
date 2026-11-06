import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedProcessRoots } from '../src/processes.js';

test('停止进程树只选择已拥有的根，避免父进程退出后再次结束同一子进程', () => {
  const rows = [
    { ProcessId: 10, ParentProcessId: 1 },
    { ProcessId: 11, ParentProcessId: 10 },
    { ProcessId: 12, ParentProcessId: 11 },
    { ProcessId: 20, ParentProcessId: 99 },
  ];
  assert.deepEqual(ownedProcessRoots(rows).map(p => p.ProcessId), [10, 20]);
  assert.deepEqual(ownedProcessRoots(rows.slice(1)).map(p => p.ProcessId), [11, 20]);
  assert.deepEqual(ownedProcessRoots([]), []);
});
