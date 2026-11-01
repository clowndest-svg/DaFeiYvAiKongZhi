import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync, backup } from 'node:sqlite';
const dir=fs.mkdtempSync(path.resolve('data/companion-benchmark-'));
Object.assign(process.env,{BIZHI_TEST_MODE:'1',BIZHI_NO_BACKUP:'1',BIZHI_DATA_DIR:dir,BIZHI_SETTINGS_FILE:path.join(dir,'settings.json')});
const db=await import('../src/db.js');
const {VoiceCall}=await import('../src/voice-call.js');
const session=db.createSession('一万条合成消息');
const started=performance.now();
db.getDb().exec('BEGIN');
for(let i=0;i<10000;i++)db.addMessage({sessionId:session.id,role:i%2?'assistant':'user',content:`合成消息${i}，用于分页和存储压测。`,tokens:20});
db.getDb().exec('COMMIT');
const insertMs=performance.now()-started;
const times=[],seen=new Set();let before=null;
while(true){
 const at=performance.now();const page=db.getMessagePage(session.id,{before,limit:80});times.push(performance.now()-at);
 for(const message of page.messages){if(seen.has(message.id))throw new Error('Duplicate history message');seen.add(message.id);}
 if(!page.hasMore)break;before=page.before;
}
if(seen.size!==10000)throw new Error('History coverage incomplete');
let now=100000;
const voice=new VoiceCall({now:()=>now,setTimeout:()=>0,clearTimeout:()=>{}});
for(let i=0;i<10000;i++){
 now+=10000;voice.begin({ownerId:'synthetic',accountGeneration:1,enabled:true});
 const ticket=voice.markCommitting(voice.openTurn({ownerId:'synthetic',accountGeneration:1}));
 if(!ticket.ok)throw new Error(ticket.reason);voice.settle(ticket.ticketId,'confirmed');voice.end('benchmark');
}
if(voice.tickets.size>512 || voice.timers.size)throw new Error('Voice resources unbounded');
db.closeDb();
const source=new DatabaseSync(path.join(dir,'bizhi.db'),{readOnly:true});
const restoredFile=path.join(dir,'restored.db');await backup(source,restoredFile);source.close();
const restored=new DatabaseSync(restoredFile,{readOnly:true});
const integrity=restored.prepare('PRAGMA integrity_check').get().integrity_check;
const restoredMessages=restored.prepare('SELECT COUNT(*) n FROM messages').get().n;restored.close();
if(integrity!=='ok'||restoredMessages!==10000)throw new Error('Backup restore verification failed');
times.sort((a,b)=>a-b);
const result={at:new Date().toISOString(),syntheticOnly:true,messages:seen.size,insertMs,historyPages:times.length,pageP95Ms:times[Math.min(times.length-1,Math.floor(times.length*.95))],voiceSessions:10000,retainedTickets:voice.tickets.size,remainingTimers:voice.timers.size,restoredMessages,integrity,rss:process.memoryUsage().rss,note:'数据库分页基线与合成资源验证，不代表HTTP端到端延迟或72小时生产稳定性。'};
fs.writeFileSync('data/implementation-benchmark.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
