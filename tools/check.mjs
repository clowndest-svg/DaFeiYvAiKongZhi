import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
let failures = 0;
for (const dir of ['src', 'web', 'tests', 'tools']) {
  for (const entry of fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(js|mjs|cjs)$/.test(entry.name)) continue;
    count += 1;
    const file = path.join(entry.parentPath, entry.name);
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (checked.status !== 0) { failures += 1; console.error(checked.stderr || checked.error?.message); }
  }
}
console.log(`Syntax: ${count - failures}/${count} passed`);
process.exitCode = failures ? 1 : 0;
