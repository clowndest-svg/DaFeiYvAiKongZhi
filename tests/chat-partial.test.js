import test from 'node:test';
import assert from 'node:assert/strict';
import { Companion } from '../src/chat.js';
import { getDb, closeDb } from '../src/db.js';

test.after(closeDb);
test('中断回复标为半截且不进入提示历史；正常回复按设置名清理',async()=>{
 const llm={configured:true,async *stream(){yield{type:'content',delta:'鲸鲸：半句话'};throw new Error('网络断了');}};
 const c=new Companion({llm});
 await assert.rejects(async()=>{for await(const e of c.streamReply({text:'你好'})){}},/网络/);
 const row=getDb().prepare("SELECT meta FROM messages WHERE role='assistant' ORDER BY id DESC LIMIT 1").get();
 assert.equal(JSON.parse(row.meta).aborted,true);
 const next=c.prepare({text:'然后呢'});assert.equal(next.history.some(m=>m.meta.aborted),false);
});
