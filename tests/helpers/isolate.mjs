import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const root = fileURLToPath(new URL('../../', import.meta.url));
process.env.BIZHI_TEST_MODE = '1';
process.env.BIZHI_NO_BACKUP = '1';
process.env.OPEN_BROWSER = '0';
process.env.DEEPSEEK_API_KEY = 'test-api-key';
process.env.ONEBOT_TOKEN ||= 'test-onebot-token';
process.env.CONSOLE_TOKEN ??= '';
process.env.CONSOLE_PASSWORD ??= '';
if (!process.env.BIZHI_DATA_DIR) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  process.env.BIZHI_DATA_DIR = fs.mkdtempSync(path.join(root, 'data', 'test-isolated-'));
}
process.env.BIZHI_SETTINGS_FILE ||= path.join(process.env.BIZHI_DATA_DIR, 'settings.json');
process.env.BIZHI_PERSONA_FILE ||= path.join(process.env.BIZHI_DATA_DIR, 'persona.md');
process.env.BIZHI_MOM_LETTER_FILE ||= path.join(process.env.BIZHI_DATA_DIR, 'mom-letter.md');
for (const [destination, source] of [[process.env.BIZHI_PERSONA_FILE, 'persona.md'], [process.env.BIZHI_MOM_LETTER_FILE, 'mom-letter.md']]) {
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, 'config', source), destination);
  }
}

const unsafePrograms = /^(taskkill|wscript|cscript|reg|shutdown)(?:\.exe)?$/i;
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  if (unsafePrograms.test(path.basename(String(file)))) throw new Error(`Test attempted real process control: ${file}`);
  return originalSpawn.call(this, file, args, options);
};
for (const protocol of [http, https]) {
  for (const name of ['request', 'get']) {
    const original = protocol[name];
    protocol[name] = function (input, ...args) {
      const options = typeof input === 'string' || input instanceof URL ? new URL(input) : input || {};
      const host = String(options.hostname || options.host || 'localhost').replace(/^\[|\]$/g, '');
      if (!['localhost', '127.0.0.1', '::1'].includes(host) || ['7788', '6099', '9333'].includes(String(options.port || ''))) throw new Error('Test attempted external/production HTTP request');
      return original.call(this, input, ...args);
    };
  }
}
syncBuiltinESMExports();

const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, options) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!local || ['7788', '6099', '9333'].includes(url.port)) {
    return Promise.reject(new Error(`Test attempted external/production request: ${url.origin}`));
  }
  return originalFetch(input, options);
};
