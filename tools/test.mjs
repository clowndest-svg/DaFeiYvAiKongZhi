import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const full = process.argv.includes('--local');
const isolate = pathToFileURL(path.join(root, 'tests', 'helpers', 'isolate.mjs')).href;
const files = fs.readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.test.js')).sort();
const before = new Set(fs.existsSync(path.join(root, 'data')) ? fs.readdirSync(path.join(root, 'data')) : []);
const child = spawn(process.execPath, ['--test', ...files.map((name) => path.join(root, 'tests', name))], {
  cwd: root,
  env: {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${isolate}`.trim(),
    BIZHI_LOCAL_VOICE_TESTS: full ? '1' : '0',
  },
  stdio: 'inherit',
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('close', (code) => {
  process.exitCode = code ?? 1;
  for (const name of fs.readdirSync(path.join(root, 'data'))) {
    if (!/^test-isolated-/.test(name) || before.has(name)) continue;
    try { fs.rmSync(path.join(root, 'data', name), { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
    catch (error) { console.error(`Test cleanup failed: ${name}: ${error.message}`); process.exitCode = 1; }
  }
});
