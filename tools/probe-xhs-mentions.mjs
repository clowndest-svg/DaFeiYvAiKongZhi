import { readXhsMentions } from '../src/channels/xhs.js';
const dump = await readXhsMentions({});
console.log('条目数 =', dump.items.length, '| 新鲜 =', dump.fresh.length);
for (const it of dump.items) console.log(' -', JSON.stringify(it).slice(0, 150));
process.exit(0);
