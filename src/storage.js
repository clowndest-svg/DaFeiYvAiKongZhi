import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const configured = new Map();
export function configureStorage(dataDirectory) {
  const root = path.resolve(dataDirectory, 'runtime');
  let storage = configured.get(root);
  if (!storage) {
    const tempRoot = path.join(root, 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const temp = fs.mkdtempSync(path.join(tempRoot, `worker-${process.pid}-`));
    const entry = process.argv[1] || '';
    const role = entry.endsWith('background.mjs') ? 'watchdog' : /[/\\]src[/\\]/.test(entry) ? 'app' : 'tool';
    fs.writeFileSync(path.join(temp, 'owner.json'), JSON.stringify({ scope: 'bizhi-temp-v1', pid: process.pid, nonce: crypto.randomUUID(), role, createdAt: Date.now() }));
    const cache = path.join(root, 'cache');
    storage = { root, tempRoot, temp, cache, python: path.join(root, 'python') };
    for (const name of ['npm', 'pip', 'uv', 'playwright', 'huggingface', 'torch', 'torch-extensions', 'xdg', 'matplotlib', 'numba', 'pycache']) fs.mkdirSync(path.join(cache, name), { recursive: true });
    fs.mkdirSync(storage.python, { recursive: true });
    configured.set(root, storage);
  }
  Object.assign(process.env, {
    TEMP: storage.temp, TMP: storage.temp, TMPDIR: storage.temp,
    npm_config_cache: path.join(storage.cache, 'npm'), PIP_CACHE_DIR: path.join(storage.cache, 'pip'),
    UV_CACHE_DIR: path.join(storage.cache, 'uv'), UV_PYTHON_INSTALL_DIR: storage.python,
    PLAYWRIGHT_BROWSERS_PATH: path.join(storage.cache, 'playwright'),
    HF_HOME: path.join(storage.cache, 'huggingface'), HF_HUB_CACHE: path.join(storage.cache, 'huggingface', 'hub'),
    TORCH_HOME: path.join(storage.cache, 'torch'), XDG_CACHE_HOME: path.join(storage.cache, 'xdg'),
    TORCH_EXTENSIONS_DIR: path.join(storage.cache, 'torch-extensions'),
    MPLCONFIGDIR: path.join(storage.cache, 'matplotlib'), NUMBA_CACHE_DIR: path.join(storage.cache, 'numba'),
    PYTHONPYCACHEPREFIX: path.join(storage.cache, 'pycache'),
  });
  return storage;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function contained(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
// Links, missing ownership, live processes and incomplete scans are all kept.
export function cleanStorage(storage, { now = Date.now(), processAlive = alive, hasLiveDescendants = () => true, maxEntries = 12000, maxTempBytes = 1024 ** 3, maxCacheBytes = 512 * 1024 ** 2 } = {}) {
  const result = { at: now, removedBytes: 0, removedWorkspaces: 0, cacheRemovedBytes: 0, skipped: 0 };
  let visited = 0;
  const filesUnder = root => {
    const files = [];
    const walk = directory => {
      if (++visited > maxEntries) throw new Error('scan limit');
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('linked directory');
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name);
        if (!contained(root, file)) throw new Error('path escaped');
        const stat = fs.lstatSync(file);
        if (++visited > maxEntries || stat.isSymbolicLink()) throw new Error('unsafe/incomplete scan');
        if (stat.isDirectory()) walk(file);
        else if (stat.isFile()) files.push({ file, bytes: stat.size, mtime: stat.mtimeMs });
      }
    };
    walk(root); return files;
  };
  const workspaces = [];
  let toolsBusy = false;
  for (const name of fs.readdirSync(storage.tempRoot)) {
    if (!/^worker-\d+-[A-Za-z0-9]+$/.test(name)) continue;
    const directory = path.join(storage.tempRoot, name);
    try {
      if (!contained(storage.tempRoot, directory) || fs.lstatSync(directory).isSymbolicLink()) throw new Error('linked workspace');
      const ownerFile = path.join(directory, 'owner.json');
      if (fs.lstatSync(ownerFile).isSymbolicLink()) throw new Error('linked owner');
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      if (owner.scope !== 'bizhi-temp-v1' || !Number.isInteger(owner.pid) || owner.pid <= 0 || !name.startsWith(`worker-${owner.pid}-`) || !Number.isFinite(owner.createdAt)) throw new Error('unknown owner');
      if (processAlive(owner.pid) || hasLiveDescendants(owner.pid)) { if (owner.role === 'tool') toolsBusy = true; result.skipped++; continue; }
      const files = filesUnder(directory);
      workspaces.push({ directory, bytes: files.reduce((sum, file) => sum + file.bytes, 0), latest: Math.max(owner.createdAt, ...files.map(file => file.mtime)) });
    } catch { toolsBusy = true; result.skipped++; }
  }
  let tempBytes = workspaces.reduce((sum, item) => sum + item.bytes, 0);
  for (const item of workspaces.sort((a, b) => a.latest - b.latest)) {
    const age = now - item.latest;
    if (age < 86400000 && !(tempBytes > maxTempBytes && age > 3600000)) continue;
    try {
      // Only previously scanned, non-linked, owned and exited workspaces.
      fs.rmSync(item.directory, { recursive: true, force: true });
      result.removedBytes += item.bytes; result.removedWorkspaces++; tempBytes -= item.bytes;
    } catch { result.skipped++; }
  }
  // Download caches are replaceable. Installed browsers, Python, models and
  // authentication profiles are never candidates for automatic removal.
  if (!toolsBusy) for (const name of ['npm', 'pip', 'uv']) {
    try {
      const root = path.join(storage.cache, name);
      const files = filesUnder(root).sort((a, b) => a.mtime - b.mtime);
      let bytes = files.reduce((sum, file) => sum + file.bytes, 0);
      for (const item of files) {
        const age = now - item.mtime;
        if (age < 30 * 86400000 && !(bytes > maxCacheBytes && age > 7 * 86400000)) continue;
        try { fs.unlinkSync(item.file); bytes -= item.bytes; result.cacheRemovedBytes += item.bytes; } catch { result.skipped++; }
      }
    } catch { result.skipped++; }
  }
  result.tempEligibleBytesRemaining = tempBytes;
  result.cacheCleanupDeferred = toolsBusy;
  return result;
}
