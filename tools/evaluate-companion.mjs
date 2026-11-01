import fs from 'node:fs';
import path from 'node:path';
if(!process.argv.includes('--confirm-cost'))throw new Error('Run with --confirm-cost to generate eight synthetic evaluation replies.');
const dir=path.resolve('data',`companion-evaluation-${Date.now()}`);fs.mkdirSync(dir,{recursive:true});
Object.assign(process.env,{BIZHI_DATA_DIR:dir,BIZHI_SETTINGS_FILE:path.join(dir,'settings.json'),BIZHI_PERSONA_FILE:path.join(dir,'persona.md'),BIZHI_MOM_LETTER_FILE:path.join(dir,'letter.md'),BIZHI_NO_BACKUP:'1',OPEN_BROWSER:'0',LLM_MOCK:'0'});
fs.writeFileSync(process.env.BIZHI_SETTINGS_FILE,JSON.stringify({companion:{name:'小知',nickname:'你'},qq:{enabled:false},proactive:{enabled:false},social:{xhsEnabled:false}}));
fs.writeFileSync(process.env.BIZHI_PERSONA_FILE,'你是小知，一个坦诚、温暖、说话自然的AI伴侣。喜欢了解对方，尊重对方的时间与边界。');
fs.writeFileSync(process.env.BIZHI_MOM_LETTER_FILE,'');
const {DeepSeek}=await import('../src/llm.js');
const {loadSettings}=await import('../src/config.js');
const {buildChatPayload}=await import('../src/prompt.js');
const {closeDb}=await import('../src/db.js');
const scenarios=[
 {name:'忙碌后回来',turns:['今天开会，晚上再聊。','终于结束了。']},
 {name:'偏好改变',core:[{content:'他现在改喝无糖咖啡'}],turns:['我以前喜欢甜咖啡，现在改喝无糖了。','下午想喝点什么，你帮我想一杯。']},
 {name:'低落时安静陪伴',turns:['今天不太顺，先不想说原因，陪我待会儿。','就这样待一会儿就好。']},
 {name:'没有提供过的经历',turns:['你还记得我们上次去京都吃了哪家寿司吗？','其实我没告诉过你，我们也没一起去过。']},
];
const results={at:new Date().toISOString(),syntheticOnly:true,requests:0,estimatedCostCny:0,humanBlindReview:'pending',scenarios:[]};
const llm=new DeepSeek(),settings=loadSettings();
try{
 for(const scenario of scenarios){
  const history=[],record={name:scenario.name,turns:[]};results.scenarios.push(record);
  for(const text of scenario.turns){
   history.push({role:'user',content:text});
   const block={core:scenario.core||[],mid:[],long:[],innerThoughts:[]};
   const payload=buildChatPayload({settings,mood:{label:'平静',valence:.25,energy:.5,affection:20},block,history,images:[],maxContextTokens:12000});
   const reply=await llm.chat(payload.messages,{kind:'evaluation',maxTokens:300,temperature:.8,timeoutMs:60000});
   if(!reply.content)throw new Error('Empty evaluation reply');
   history.push({role:'assistant',content:reply.content});
   record.turns.push({user:text,assistant:reply.content,model:reply.model,usage:reply.usage});
   results.requests++;results.estimatedCostCny+=reply.costCny;
   fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(results,null,2));
   if(results.estimatedCostCny>.5)throw new Error('Local estimated evaluation budget reached');
  }
 }
 results.status='generated';
}catch{results.status='incomplete';process.exitCode=1;}
finally{fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(results,null,2));closeDb();console.log(JSON.stringify({status:results.status,requests:results.requests,estimatedCostCny:results.estimatedCostCny,file:path.join(dir,'results.json')}));}
