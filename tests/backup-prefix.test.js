import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const { paths } = await import('../src/config.js');
const { initDb, getDb, closeDb, kvSet, kvGet, kvDeletePrefix, backupDatabase } = await import('../src/db.js');
test.after(closeDb);
test('KV 前缀下划线是字面值，不误删其他前缀',()=>{
 kvSet('xhs_actual','value');kvSet('xhsXother','keep');kvDeletePrefix('xhs_');assert.equal(kvGet('xhsXother'),'keep');assert.equal(kvGet('xhs_actual'),null);
});
test('WAL 中的数据也进入一致性备份，快照完整可读',()=>{
 process.env.BIZHI_NO_BACKUP='0';
 getDb();kvSet('backup-sentinel','latest');backupDatabase();
 const folder=path.join(paths.data,'backups');
 const file=fs.readdirSync(folder).find(name=>name.endsWith('.db'));
 const db=new DatabaseSync(path.join(folder,file),{readOnly:true});
 assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok');
 assert.equal(db.prepare('SELECT value FROM kv WHERE key=?').get('backup-sentinel').value,'latest');db.close();
 process.env.BIZHI_NO_BACKUP='1';
});
