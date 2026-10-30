import fs from 'node:fs';
import path from 'node:path';
import { paths, env } from './config.js';

const SECRETS = [env.apiKey, env.onebotToken, env.consolePassword, env.consoleToken, process.env.QZONE_BRIDGE_TOKEN].filter(
  (s) => s && s.length > 6,
);

function redact(value) {
  let s = String(value ?? '');
  for (const secret of SECRETS) s = s.split(secret).join('***');
  s = s.replace(/sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+/g, '***');
  s = s.replace(/("(?:p_skey|skey|access_token|token|password|console_password|console_token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"***"');
  s = s.replace(/\b(p_skey|skey|access_token|token|password|console_password|console_token)\s*=\s*([^;\s&"']+)/gi, '$1=***');
  s = s.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer ***');
  return s;
}

function pruneLogs() {
  try {
    const files = fs
      .readdirSync(paths.logs)
      .filter((name) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - 14))) {
      fs.rmSync(path.join(paths.logs, name), { force: true });
    }
  } catch {
    // ignore
  }
}
pruneLogs();

function stamp() {
  return new Date().toISOString();
}

function write(level, message, data) {
  const line = `[${stamp()}] ${level} ${redact(message)}${data === undefined ? '' : ' ' + redact(safeStringify(data))}`;
  try {
    const file = path.join(paths.logs, `app-${stamp().slice(0, 10)}.log`);
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch {
    // 日志写不进去也不能拖垮服务
  }
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

function safeStringify(data) {
  try {
    return typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export const logger = {
  info: (message, data) => write('INFO', message, data),
  warn: (message, data) => write('WARN', message, data),
  error: (message, data) => write('ERROR', message, data),
  debug: (message, data) => {
    if (process.env.BIZHI_DEBUG === '1') write('DEBUG', message, data);
  },
  redact,
};
