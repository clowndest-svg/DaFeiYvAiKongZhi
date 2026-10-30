import fs from 'node:fs';
import path from 'node:path';

if (!process.argv.includes('--confirm-cost')) { console.error('This smoke test spends a small amount on your DeepSeek account. Run with --confirm-cost after reviewing the prompts.'); process.exitCode=1; }
else {
 const dir=path.resolve('data', `smoke-${Date.now()}`);fs.mkdirSync(dir,{recursive:true});
 process.env.BIZHI_DATA_DIR=dir;process.env.BIZHI_SETTINGS_FILE=path.join(dir,'settings.json');process.env.BIZHI_NO_BACKUP='1';
 const {DeepSeek}=await import('../src/llm.js');const {closeDb}=await import('../src/db.js');
 const llm=new DeepSeek();
 const results=[];
 try {
  const models=await llm.models();if(!models.length)throw new Error('models list empty');results.push('models');
  const balance=await llm.balance();if(!Number.isFinite(balance.total))throw new Error('balance invalid');results.push('balance');
  const message=[{role:'user',content:'只回复：在的'}];
  const reply=await llm.chat(message,{maxTokens:128,kind:'smoke'});if(!reply.content)throw new Error('empty reply');results.push('chat');
  const json=await llm.chat([{role:'user',content:'只返回 JSON：{"ok":true}'}],{maxTokens:128,responseFormat:{type:'json_object'},kind:'smoke'});if(JSON.parse(json.content).ok!==true)throw new Error('JSON invalid');results.push('json');
  let done;for await(const event of llm.stream(message,{maxTokens:128,kind:'smoke'}))if(event.type==='done')done=event;if(!done?.content)throw new Error('stream incomplete');results.push('stream');
  console.log('PASS: '+results.join(', '));
 }catch(error){console.error('FAIL after '+results.join(', ')+': '+error.message);process.exitCode=1;}finally{closeDb();}
}
