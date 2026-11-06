import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

export function backgroundStatus() {
  const read = file => { try { return JSON.parse(fs.readFileSync(path.join(paths.data, file), 'utf8')); } catch { return {}; } };
  const config = read('background-lifecycle.json');
  const state = read('background-state.json');
  const timestamp = Date.parse(state.at || '');
  return {
    installed: config.installed === true,
    enabled: !fs.existsSync(path.join(paths.data, 'background.disabled')),
    logon: config.logon === true, unlock: config.unlock === true, resume: config.resume === true,
    periodicMinutes: Number(config.periodicMinutes) || 0,
    lastCheck: Number.isFinite(timestamp) ? state.at : null,
    fresh: Number.isFinite(timestamp) && Date.now() - timestamp < 90000,
    app: state.app?.state || 'unverified', qq: state.qq?.state || 'unverified',
    resumeWaiting: state.resume?.waiting === true,
    loginRequired: true,
  };
}
