import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function removeTestDir(dir) {
  const relative = path.relative(path.join(ROOT, 'data'), path.resolve(dir));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Not a test directory');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
}

export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test child did not close')), 10000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.kill();
  });
}

export async function startTestServer(t, { settings = {}, password = '', env = {} } = {}) {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, 'data', 'test-server-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      BIZHI_TEST_MODE: '1', BIZHI_NO_BACKUP: '1', LLM_MOCK: '1', PORT: '0', OPEN_BROWSER: '0',
      BIZHI_DATA_DIR: dir, BIZHI_SETTINGS_FILE: path.join(dir, 'settings.json'),
      BIZHI_PERSONA_FILE: path.join(dir, 'persona.md'), BIZHI_MOM_LETTER_FILE: path.join(dir, 'mom-letter.md'),
      ONEBOT_TOKEN: 'test-onebot-token', CONSOLE_TOKEN: '', CONSOLE_PASSWORD: password,
      BIZHI_DISABLE_CONSOLE_AUTH: password ? '0' : '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  t.after(async () => { await stopChild(child); removeTestDir(dir); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Test server did not start: ${logs.slice(-2000)}`)), 15000);
    const read = (data) => {
      logs += data.toString();
      const match = logs.match(/BIZHI_READY:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Test server exited (${code}): ${logs.slice(-2000)}`)); });
  });
  return { child, dir, port, base: `http://127.0.0.1:${port}`, logs: () => logs };
}
