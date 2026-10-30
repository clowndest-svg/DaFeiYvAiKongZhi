import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepMerge, ensureDir, readJson, writeJsonAtomic } from './util.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SRC_DIR, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

if (process.env.BIZHI_TEST_MODE !== '1') loadDotEnv(path.join(ROOT, '.env'));

export const paths = {
  root: ROOT,
  src: SRC_DIR,
  web: path.join(ROOT, 'web'),
  assets: path.join(ROOT, 'assets'),
  config: path.join(ROOT, 'config'),
  data: process.env.BIZHI_DATA_DIR ? path.resolve(process.env.BIZHI_DATA_DIR) : path.join(ROOT, 'data'),
  get logs() { return path.join(this.data, 'logs'); },
  get media() { return path.join(this.data, 'media'); },
  get publicMedia() { return path.join(this.data, 'public-media'); },
  get daily() { return path.join(this.data, 'daily'); },
  get weekly() { return path.join(this.data, 'weekly'); },
  get letters() { return path.join(this.data, 'letters'); },
  get archives() { return path.join(this.data, 'archives'); },
  get xhsProfile() { return path.join(this.data, 'xhs-profile'); },
  get db() { return path.join(this.data, 'bizhi.db'); },
  get settings() {
    return process.env.BIZHI_SETTINGS_FILE
      ? path.resolve(process.env.BIZHI_SETTINGS_FILE)
      : path.join(this.config, 'settings.json');
  },
  get persona() { return process.env.BIZHI_PERSONA_FILE ? path.resolve(process.env.BIZHI_PERSONA_FILE) : path.join(this.config, 'persona.md'); },
  get momLetter() { return process.env.BIZHI_MOM_LETTER_FILE ? path.resolve(process.env.BIZHI_MOM_LETTER_FILE) : path.join(this.config, 'mom-letter.md'); },
  get defaultSettings() { return path.join(this.config, 'default-settings.json'); },
};

for (const dir of [
  paths.data,
  paths.logs,
  paths.media,
  paths.publicMedia,
  paths.daily,
  paths.weekly,
  paths.letters,
  paths.archives,
  paths.xhsProfile,
]) {
  ensureDir(dir);
}

export const env = {
  testMode: process.env.BIZHI_TEST_MODE === '1',
  apiKey: (process.env.DEEPSEEK_API_KEY || '').trim(),
  baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  defaultModel: (process.env.DEEPSEEK_MODEL || 'deepseek-flash').trim(),
  port: Number(process.env.PORT || 7788),
  onebotToken: (process.env.ONEBOT_TOKEN || '').trim(),
  openBrowser: process.env.OPEN_BROWSER === '1',
  consoleToken: (process.env.CONSOLE_TOKEN || '').trim(),
  consolePassword:
    process.env.BIZHI_DISABLE_CONSOLE_AUTH === '1'
      ? ''
      : (process.env.CONSOLE_PASSWORD || process.env.CONSOLE_TOKEN || '').trim(),
  edgePython: (process.env.BIZHI_EDGE_PYTHON || '').trim(),
  mock: process.env.LLM_MOCK === '1',
};

function extractXhsUserId(value) {
  const text = String(value || '').trim();
  const match = text.match(/(?:^|\/)([0-9a-f]{24})(?:[/?#]|$)/i);
  if (match) return match[1].toLowerCase();
  return /^\d{4,24}$/.test(text) ? text : '';
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clockOr(value, fallback) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const FALLBACK_SETTINGS = (() => {
  try {
    return JSON.parse(fs.readFileSync(paths.defaultSettings, 'utf8'));
  } catch {
    return {};
  }
})();

function settingsShape(defaults, input) {
  if (Array.isArray(defaults)) return Array.isArray(input) ? input.filter((item) => ['string', 'number'].includes(typeof item)).slice(0, 200) : [];
  if (defaults && typeof defaults === 'object') {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, settingsShape(fallback, Object.hasOwn(value, key) ? value[key] : undefined)]));
  }
  if (input == null) return defaults;
  if (typeof defaults === 'boolean') return typeof input === 'boolean' ? input : defaults;
  if (typeof defaults === 'number') {
    const n = typeof input === 'number' || typeof input === 'string' && input.trim() ? Number(input) : NaN;
    return Number.isFinite(n) ? n : defaults;
  }
  return typeof input === 'string' ? input : defaults;
}

export function normalizeSettings(settings) {
  settings = settingsShape(FALLBACK_SETTINGS, settings);
  const s = structuredClone(settings);
  s.companion.name = String(s.companion.name || '小知').trim().slice(0, 20) || '小知';
  s.companion.userName = String(s.companion.userName || '').trim().slice(0, 20);
  s.companion.nickname = String(s.companion.nickname || '').trim().slice(0, 20);
  s.companion.intro = String(s.companion.intro || '').trim().slice(0, 80);

  s.model.name = String(s.model.name || env.defaultModel);
  s.model.temperature = Math.min(1.5, Math.max(0.1, Number(s.model.temperature) || 0.95));
  s.model.chatMaxTokens = Math.min(8000, Math.max(600, Number(s.model.chatMaxTokens) || 1400));
  s.model.reflectMaxTokens = Math.min(4000, Math.max(200, Number(s.model.reflectMaxTokens) || 450));
  s.model.reflectEvery = Math.min(10, Math.max(1, Number(s.model.reflectEvery) || 2));
  s.model.reasoningEffort = ['low', 'high', 'max'].includes(s.model.reasoningEffort)
    ? s.model.reasoningEffort
    : 'low';

  s.memory.compactTokens = Math.min(200000, Math.max(4000, numberOr(s.memory.compactTokens, 24000)));
  s.memory.handoverTokens = Math.max(
    s.memory.compactTokens + 4000,
    Math.min(400000, numberOr(s.memory.handoverTokens, 48000)),
  );
  s.memory.maxContextTokens = Math.min(128000, Math.max(8000, numberOr(s.memory.maxContextTokens, 64000)));
  s.memory.maxPromptTokens = Math.min(16000, Math.max(3000, numberOr(s.memory.maxPromptTokens, 6000)));
  s.memory.shortTurns = Math.min(80, Math.max(6, numberOr(s.memory.shortTurns, 24)));
  s.memory.retrieveCount = Math.min(30, Math.max(3, numberOr(s.memory.retrieveCount, 10)));
  s.memory.retrieveBudgetTokens = Math.min(8000, Math.max(500, numberOr(s.memory.retrieveBudgetTokens, 2200)));

  s.proactive.enabled = s.proactive.enabled !== false;
  s.proactive.idleMinutesMin = Math.min(720, Math.max(1, numberOr(s.proactive.idleMinutesMin, 25)));
  s.proactive.idleMinutesMax = Math.min(1440, Math.max(s.proactive.idleMinutesMin, numberOr(s.proactive.idleMinutesMax, 120)));
  s.proactive.maxPerDay = Math.min(10, Math.max(0, numberOr(s.proactive.maxPerDay, 3)));
  s.proactive.maxUnanswered = Math.min(5, Math.max(1, numberOr(s.proactive.maxUnanswered, 2)));
  s.proactive.dreamEnabled = s.proactive.dreamEnabled !== false;
  s.proactive.dreamHour = Math.min(23, Math.max(0, numberOr(s.proactive.dreamHour, 23)));
  s.proactive.quietStart = clockOr(s.proactive.quietStart, '00:30');
  s.proactive.quietEnd = clockOr(s.proactive.quietEnd, '08:30');

  s.qq.whitelist = Array.isArray(s.qq.whitelist)
    ? s.qq.whitelist.map((v) => String(v).trim()).filter(Boolean)
    : [];
  s.qq.groupWhitelist = Array.isArray(s.qq.groupWhitelist)
    ? s.qq.groupWhitelist.map((v) => String(v).trim()).filter(Boolean)
    : [];
  s.qq.maxRepliesPerHour = Math.min(200, Math.max(1, numberOr(s.qq.maxRepliesPerHour, 40)));
  s.qq.sendStickers = s.qq.sendStickers !== false;
  s.qq.stickerChance = Math.min(1, Math.max(0, numberOr(s.qq.stickerChance, 0.2)));
  s.qq.learnImages = s.qq.learnImages !== false;
  s.qq.autoRecover = s.qq.autoRecover !== false;
  s.qq.autoBindWhitelist = s.qq.autoBindWhitelist !== false;
  s.qq.sleepyMode = s.qq.sleepyMode !== false;
  s.qq.botAccount = /^[0-9]{5,12}$/.test(String(s.qq.botAccount || '').trim())
    ? String(s.qq.botAccount).trim()
    : '';
  s.tts.enabled = s.tts?.enabled !== false;
  const ttsVoice = String(s.tts?.voice || '').trim();
  s.tts.voice =
    ttsVoice === 'local-piper' || /^[a-z]{2}-[A-Z]{2}(-[A-Za-z0-9]+)*Neural$/.test(ttsVoice)
      ? ttsVoice
      : 'zh-CN-XiaoxiaoNeural';
  s.tts.rate = /^[+-][0-9]{1,3}%$/.test(String(s.tts?.rate || '')) ? String(s.tts.rate) : '+8%';
  s.tts.pitch = /^[+-][0-9]{1,3}Hz$/.test(String(s.tts?.pitch || '')) ? String(s.tts.pitch) : '+2Hz';
  s.tts.listen = s.tts.listen !== false;
  s.tts.maxPerDay = Math.min(30, Math.max(0, numberOr(s.tts?.maxPerDay, 8)));
  s.tts.maxChars = Math.min(200, Math.max(20, numberOr(s.tts?.maxChars, 120)));
  s.tts.chance = Math.min(1, Math.max(0, numberOr(s.tts?.chance, 0.18)));

  s.qq.selfFollowUp = s.qq.selfFollowUp !== false;
  s.qq.selfFollowUpChance = Math.min(1, Math.max(0, numberOr(s.qq.selfFollowUpChance, 0.25)));
  s.qq.selfFollowUpDelaySeconds = Math.min(300, Math.max(3, numberOr(s.qq.selfFollowUpDelaySeconds, 25)));
  s.qq.selfFollowUpMaxPerHour = Math.min(6, Math.max(0, numberOr(s.qq.selfFollowUpMaxPerHour, 2)));
  s.qq.selfFollowUpMaxPerDay = Math.min(20, Math.max(0, numberOr(s.qq.selfFollowUpMaxPerDay, 6)));

  s.cost.lowBalanceCny = Math.min(100, Math.max(0.1, numberOr(s.cost?.lowBalanceCny, 5)));
  s.cost.stopBalanceCny = Math.min(50, Math.max(0, numberOr(s.cost?.stopBalanceCny, 1.5)));
  s.cost.maxDailyCostCny = Math.min(100, Math.max(0, numberOr(s.cost?.maxDailyCostCny, 3)));
  s.cost.rechargeHint = String(s.cost?.rechargeHint || 'DeepSeek 余额').trim().slice(0, 40);

  s.social.dailyPostMax = Math.min(6, Math.max(0, numberOr(s.social.dailyPostMax, 2)));
  s.social.qzoneAutoReply = s.social.qzoneAutoReply !== false;
  s.social.qzoneAutoReplyMaxPerHour = Math.min(20, Math.max(1, numberOr(s.social.qzoneAutoReplyMaxPerHour, 3)));
  s.social.qzoneAutoReplyMaxPerDay = Math.min(50, Math.max(1, numberOr(s.social.qzoneAutoReplyMaxPerDay, 10)));
  s.social.qzoneAutoReplyMaxAgeHours = Math.min(168, Math.max(1, numberOr(s.social.qzoneAutoReplyMaxAgeHours, 48)));
  s.social.activeStart = clockOr(s.social.activeStart, '09:30');
  s.social.activeEnd = clockOr(s.social.activeEnd, '22:30');

  s.social.xhsEnabled = s.social.xhsEnabled === true;
  s.social.xhsAutoBrowse = s.social.xhsAutoBrowse === true;
  s.social.xhsAutoReply = s.social.xhsAutoReply !== false;
  s.social.xhsOwnerName = String(s.social.xhsOwnerName || '').trim().slice(0, 40);
  s.social.xhsOwnerUserId = extractXhsUserId(String(s.social.xhsOwnerUserId || ''));
  s.social.xhsSearchKeywords = String(s.social.xhsSearchKeywords || '').trim().slice(0, 200);
  s.social.xhsDailyCommentMax = Math.min(30, Math.max(0, numberOr(s.social.xhsDailyCommentMax, 6)));
  s.social.xhsDailyReplyMax = Math.min(50, Math.max(0, numberOr(s.social.xhsDailyReplyMax, 15)));
  s.social.xhsHourlyActionMax = Math.min(10, Math.max(1, numberOr(s.social.xhsHourlyActionMax, 3)));
  s.social.xhsAutoLike = s.social.xhsAutoLike === true;
  s.social.xhsAutoCollect = s.social.xhsAutoCollect === true;
  s.social.xhsDailyLikeMax = Math.min(30, Math.max(0, numberOr(s.social.xhsDailyLikeMax, 8)));
  s.social.xhsDailyCollectMax = Math.min(20, Math.max(0, numberOr(s.social.xhsDailyCollectMax, 4)));
  s.social.xhsAutoPublish = s.social.xhsAutoPublish === true;
  s.social.xhsDmReply = s.social.xhsDmReply === true;
  s.social.xhsDmAutoOwner = s.social.xhsDmAutoOwner !== false;
  s.social.xhsDmMaxPerDay = Math.min(10, Math.max(0, numberOr(s.social.xhsDmMaxPerDay, 3)));
  s.social.xhsDmMaxPerTarget = Math.min(5, Math.max(1, numberOr(s.social.xhsDmMaxPerTarget, 1)));
  s.social.xhsPublishPerDay = Math.min(3, Math.max(0, numberOr(s.social.xhsPublishPerDay, 1)));
  s.social.xhsDailyActionMax = Math.min(60, Math.max(0, numberOr(s.social.xhsDailyActionMax, 12)));
  s.social.xhsPollHoursMin = Math.min(12, Math.max(1, numberOr(s.social.xhsPollHoursMin, 2)));
  s.social.xhsPollHoursMax = Math.min(24, Math.max(s.social.xhsPollHoursMin, numberOr(s.social.xhsPollHoursMax, 3.5)));

  return s;
}

export function loadSettings() {
  const defaults = readJson(paths.defaultSettings, {});
  const user = readJson(paths.settings, {});
  return normalizeSettings(deepMerge(defaults, user));
}

export function saveSettings(patch) {
  const current = loadSettings();
  if (patch?.qq && Object.hasOwn(patch.qq, 'botAccount') && patch.qq.botAccount !== '' && !/^[0-9]{5,12}$/.test(String(patch.qq.botAccount))) throw new Error('机器人 QQ 号格式不合法，未修改原配置');
  const next = normalizeSettings(deepMerge(current, patch || {}));
  writeJsonAtomic(paths.settings, next);
  return next;
}

export function getPersona() {
  try {
    return fs.readFileSync(paths.persona, 'utf8');
  } catch {
    return '你是小知，用户的女朋友。说话自然、简短、有点小傲娇。';
  }
}

export function getMomLetter() {
  try {
    return fs.readFileSync(paths.momLetter, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return '';
  }
}

export function savePersona(text) {
  const value = String(text || '').trim();
  if (!value) throw new Error('人设不能为空');
  fs.writeFileSync(paths.persona, value + '\n', 'utf8');
  return value;
}

export function maskKey(key = env.apiKey) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export const appInfo = {
  name: '小知',
  version: '1.0.0',
  startAt: new Date().toISOString(),
};
