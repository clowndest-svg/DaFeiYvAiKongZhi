import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// One process owns one business data directory, even if two ports are chosen.
export function acquireRuntimeLock(directory) {
  const file = path.join(directory, 'app-runtime.lock');
  fs.mkdirSync(directory, { recursive: true });
  const content = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
  let fd;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { fd = fs.openSync(file, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = fs.readFileSync(file, 'utf8');
      let pid;
      try { pid = JSON.parse(previous).pid; } catch { throw new Error('运行锁不完整，请核实进程后处理 app-runtime.lock'); }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('运行锁 PID 不可信，请先核实进程');
      try { process.kill(pid, 0); throw new Error('同一业务数据目录已有应用进程，拒绝启动第二个实例'); }
      catch (probeError) { if (probeError.code !== 'ESRCH') throw probeError; }
      if (fs.readFileSync(file, 'utf8') === previous) fs.unlinkSync(file);
    }
  }
  if (fd === undefined) throw new Error('无法取得业务数据目录运行锁');
  try { fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (fs.readFileSync(file, 'utf8') === content) fs.unlinkSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
