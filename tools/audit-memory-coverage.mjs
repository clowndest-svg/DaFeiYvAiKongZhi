import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const file = path.resolve(process.argv[2] || 'data/bizhi.db');
const db = new DatabaseSync(file, { readOnly: true });
try {
  const sessions = db.prepare('SELECT session_id,COUNT(*) count FROM messages WHERE compacted=1 GROUP BY session_id').all();
  const coverage = db.prepare("SELECT value FROM kv WHERE key LIKE 'compact_coverage:%'").all().flatMap(row=>{try{return JSON.parse(row.value);}catch{return [];}});
  const known = new Set(coverage.filter(part=>part.complete).map(part=>part.id));
  const marked = db.prepare('SELECT id FROM messages WHERE compacted=1').all();
  console.log(JSON.stringify({at:new Date().toISOString(),readOnly:true,compactedMessages:marked.length,provenCoveredMessages:marked.filter(row=>known.has(row.id)).length,legacyCoverageUnknown:marked.filter(row=>!known.has(row.id)).length,sessions:sessions.length,note:'旧版未保存覆盖元数据，无法由标志证明原话已经进入摘要；本工具不重建、不修改记忆。'},null,2));
} finally { db.close(); }
