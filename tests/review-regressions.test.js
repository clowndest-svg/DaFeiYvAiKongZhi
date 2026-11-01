import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, listMemories, closeDb, addMemory, reviseMemory, kvGetJson, kvSetJson, addMessage, getMessagePage, getDb } from '../src/db.js';
import { loadSettings } from '../src/config.js';
import { reflect } from '../src/reflect.js';
import { VoiceCall } from '../src/voice-call.js';
import { LatestTaskQueue } from '../src/serial.js';
import { pricingFor } from '../src/llm.js';
import { listIntentions } from '../src/intentions.js';

test.after(closeDb);
test('自动事实保留完整短句上下文，不模糊合并主语，也不补改原话标点',async()=>{
 const settings=loadSettings();settings.model.reflectEvery=1;
 for(const [said,evidence,accepted] of [['我朋友喜欢喝拿铁','我朋友喜欢喝拿铁',true],['我喜欢喝拿铁','我喜欢喝拿铁',true],['如果我喜欢喝拿铁，我就去买','我喜欢喝拿铁',true],['我不，喜欢喝咖啡','我不喜欢喝咖啡',false]]){
  const session=createSession('原话上下文');
  await reflect({sessionId:session.id,settings,messages:[{role:'user',content:said},{role:'assistant',content:'知道了'}],llm:{chat:async()=>({content:JSON.stringify({memories:[{content:'错误改写',evidence}]})})}});
  const rows=listMemories({layer:'mid',limit:200}).filter(row=>row.source_session===session.id);
  assert.equal(rows.length,accepted?1:0);
  if(accepted)assert.equal(rows[0].content,`他说：「${said}」`);
 }
});
test('费率按模型和版本选择，缺失或非法配置保留明确的估算标记',()=>{
  const table={version:'2026-11-01',usdToCny:7,models:{synthetic:{cacheHit:1,cacheMiss:2,output:3}}};
  assert.equal(pricingFor('synthetic',table).output,3);
  assert.equal(pricingFor('other',table).version,'legacy-flash-estimate');
  assert.equal(pricingFor('synthetic','not json').version,'legacy-flash-estimate');
});
test('惦记只在明确完成的主人原话后闭环，否定和假设不能关闭',async()=>{
  const settings=loadSettings();settings.model.reflectEvery=1;
  for(const [text,closed] of [['我体检做完了',true],['我还没体检做完了',false],['如果体检做完了再说',false]]) {
    const now=Date.now();
    kvSetJson('open_intentions',[{id:'synthetic-task',text:'问体检结果',createdAt:new Date(now).toISOString(),dueAt:new Date(now).toISOString(),tries:0}]);
    await reflect({sessionId:createSession('事项闭环').id,settings,messages:[{role:'user',content:text},{role:'assistant',content:'知道了'}],llm:{chat:async()=>({content:JSON.stringify({completed_intentions:[{id:'synthetic-task',evidence:text}]})})}});
    assert.equal(listIntentions().length,closed?0:1);
  }
  kvSetJson('open_intentions',[]);
});
test('慢后台任务期间同会话只保留最新一个，失败不阻断后续任务',async()=>{
  const errors=[],runs=[];
  const queue=new LatestTaskQueue({onError:error=>errors.push(error.message)});
  let release;
  const gate=new Promise(resolve=>release=resolve);
  queue.enqueue('owner',async()=>{runs.push('first');await gate;throw new Error('synthetic');});
  await Promise.resolve();
  for(let i=0;i<100;i++)queue.enqueue('owner',async()=>runs.push(i));
  assert.equal(queue.pending.size,1);
  release();await queue.completion;
  assert.deepEqual(runs,['first',99]);assert.deepEqual(errors,['synthetic']);
  await queue.enqueue('owner',async()=>runs.push('next'));
  assert.equal(runs.at(-1),'next');
});
test('历史分页包含已压缩原话，游标不会重复或漏消息',()=>{
  const session=createSession('历史分页');
  for(let i=0;i<15;i++) addMessage({sessionId:session.id,role:'user',content:`原话${i}`});
  getDb().prepare('UPDATE messages SET compacted=1 WHERE session_id=?').run(session.id);
  const page1=getMessagePage(session.id,{limit:10});
  const page2=getMessagePage(session.id,{limit:10,before:page1.before});
  assert.equal(page1.hasMore,true);assert.equal(page2.hasMore,false);
  assert.equal(new Set([...page1.messages,...page2.messages].map(m=>m.id)).size,15);
});
test('记忆更正保留旧版，拒绝过期编辑，旧事实不再自动覆盖新内容',()=>{
  const old=addMemory({layer:'core',content:'他每天喝六杯咖啡'});
  const corrected=reviseMemory(old.id,'他现在每天喝一杯咖啡',old.updated_at);
  assert.equal(kvGetJson(`memory_versions:${old.id}`)[0].content,old.content);
  assert.throws(()=>reviseMemory(old.id,'过期编辑',old.updated_at),{status:409});
  assert.equal(addMemory({layer:'core',content:old.content}).content,corrected.content);
});
test('无证据重点记忆拒绝；有证据也保留原话而非错误改写',async()=>{
  const settings=loadSettings();settings.model.reflectEvery=1;
  for(const evidence of ['', '我朋友不喜欢香菜']) {
    const session=createSession('证据边界');
    await reflect({sessionId:session.id,settings,messages:[{id:1,role:'user',channel:'web',content:'我朋友不喜欢香菜'},{id:2,role:'assistant',channel:'web',content:'知道了'}],llm:{chat:async()=>({content:JSON.stringify({memories:[{content:'主人不喜欢香菜',evidence,importance:5}]})})}});
  }
  const rows=listMemories({layer:'mid',limit:100});
  assert.ok(!rows.some(r=>r.content==='主人不喜欢香菜'));
  assert.ok(rows.some(r=>r.content==='他说：「我朋友不喜欢香菜」'));
});

test('长期语音票据有界，淘汰后的晚到回执不能重复结算',()=>{
  let now=100000;
  const call=new VoiceCall({now:()=>now,setTimeout:()=>0,clearTimeout:()=>{}});
  let first;
  for(let i=0;i<1000;i++) {
    now+=10000;call.begin({ownerId:'synthetic',accountGeneration:1,enabled:true});
    const ticket=call.markCommitting(call.openTurn({ownerId:'synthetic',accountGeneration:1}));
    assert.equal(ticket.ok,true);first ||= ticket.ticketId;
    call.settle(ticket.ticketId,'confirmed');call.end('test');
  }
  assert.ok(call.tickets.size<=512);
  assert.equal(call.settle(first,'confirmed').ok,false);
});
