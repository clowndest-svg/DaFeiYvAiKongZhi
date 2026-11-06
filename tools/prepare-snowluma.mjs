// Offline preparation only: never starts QQ, accepts terms, or switches provider.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { env, loadSettings, paths } from '../src/config.js';
import { snowLumaConfig, providerInfo } from '../src/qq-provider.js';
import { SNOWLUMA_RELEASE } from '../src/snowluma-package.js';

const { tag, bytes: expectedSize, sha256: expectedHash } = SNOWLUMA_RELEASE;
const verified = path.join(paths.data, `SnowLuma-${tag}-win-x64.verified.zip`);
const archive = fs.existsSync(verified) ? verified : path.join(paths.data, `SnowLuma-${tag}-win-x64.zip`);
const settings = loadSettings();
const report = {
  provider: providerInfo().id,
  target: `SnowLuma ${tag} Windows x64 full`,
  releaseUrl: `https://github.com/SnowLuma/SnowLuma/releases/tag/${tag}`,
  accountConfigured: /^\d{5,12}$/.test(settings.qq.botAccount || ''),
  tokenConfigured: Boolean(env.onebotToken),
  archivePresent: fs.existsSync(archive),
  archiveVerified: false,
  productionModifiedByThisCommand: false,
  liveCompatibilityVerified: false,
};
if (report.archivePresent && fs.statSync(archive).size === expectedSize) {
  report.archiveVerified = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') === expectedHash;
}
if (process.argv.includes('--prepare')) {
  const config = snowLumaConfig({ account: settings.qq.botAccount, token: env.onebotToken });
  const dir = path.join(paths.data, 'snowluma-prepared', 'config');
  if (fs.existsSync(dir)) throw new Error('离线配置已存在；请核对后保留或另存，不覆盖已有令牌和账号配置');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of [
    ['onebot.json', config.global],
    [`onebot_${settings.qq.botAccount}.json`, config.account],
    ['runtime.json', config.runtime],
  ]) fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  report.preparedDirectory = path.dirname(dir);
}
if (process.argv.includes('--snapshot')) {
  const dir = path.join(paths.data, 'migration-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  for (const file of [paths.settings, path.join(paths.root, '.env')]) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, path.basename(file)), fs.constants.COPYFILE_EXCL);
  }
  if (fs.existsSync(paths.db)) {
    const source = new DatabaseSync(paths.db, { readOnly: true });
    try { source.exec(`VACUUM INTO '${path.join(dir, 'bizhi.db').replace(/'/g, "''")}'`); }
    finally { source.close(); }
    const copy = new DatabaseSync(path.join(dir, 'bizhi.db'), { readOnly: true });
    try {
      if (Object.values(copy.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error('数据库快照校验失败');
    } finally { copy.close(); }
  }
  report.snapshotDirectory = dir;
}
console.log(JSON.stringify(report, null, 2));
