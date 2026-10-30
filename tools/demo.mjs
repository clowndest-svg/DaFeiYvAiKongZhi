import fs from 'node:fs';
import path from 'node:path';
const data = path.resolve('data/demo-isolated');
fs.mkdirSync(data, { recursive: true });
Object.assign(process.env, { BIZHI_TEST_MODE:'1', BIZHI_DATA_DIR:data, BIZHI_SETTINGS_FILE:path.join(data,'settings.json'), BIZHI_NO_BACKUP:'1', BIZHI_DISABLE_CONSOLE_AUTH:'0', CONSOLE_PASSWORD:'demo-password', CONSOLE_TOKEN:'', ONEBOT_TOKEN:'demo-onebot', LLM_MOCK:'1', PORT:'7790', OPEN_BROWSER:'0', DEEPSEEK_API_KEY:'' });
if (!fs.existsSync(process.env.BIZHI_SETTINGS_FILE)) fs.writeFileSync(process.env.BIZHI_SETTINGS_FILE, JSON.stringify({ companion:{name:'鲸鲸'}, qq:{enabled:false}, social:{xhsEnabled:false}, proactive:{enabled:false} }));
await import('../src/index.js');
