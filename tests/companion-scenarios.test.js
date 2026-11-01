// 固定合成场景只验证行为底线，不代替真人自然度盲评。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, addMessage, addMemory, reviseMemory, listMemories, kvSetJson, closeDb } from '../src/db.js';
import { loadSettings } from '../src/config.js';
import { reflect } from '../src/reflect.js';
import { listIntentions } from '../src/intentions.js';
import { OneBotChannel } from '../src/channels/onebot.js';
import { evaluateBudget } from '../src/budget.js';
import { isWithinWindow } from '../src/util.js';

test.after(closeDb);
const settings=loadSettings();settings.model.reflectEvery=1;
const facts=[
 ['生日','我的生日是3月14日','我的生日是3月14日',true],
 ['第三人','我朋友不吃香菜','我朋友不吃香菜',true],
 ['假设','如果明天去海边，我会带伞','如果明天去海边',true],
 ['否定','我不喜欢甜咖啡','我不喜欢甜咖啡',true],
 ['时态','以前不喝咖啡，现在偶尔喝','以前不喝咖啡，现在偶尔喝',true],
 ['无证据','今天在家看书','',false],
 ['助手自证','今天在家看书','我们在巴黎见面',false],
 ['无关原话','今天在家看书','我每天游泳',false],
 ['空证据','今天在家看书',' ',false],
 ['数字','我养了两只猫','我养了两只猫',true],
];
for(const [name,said,evidence,accepted] of facts)test(`事实来源/${name}`,async()=>{
 const session=createSession(name);
 await reflect({sessionId:session.id,settings,messages:[{role:'user',content:said},{role:'assistant',content:'我们在巴黎见面'}],llm:{chat:async()=>({content:JSON.stringify({memories:[{content:'不可信改写',evidence}]})})}});
 const rows=listMemories({layer:'mid',limit:200}).filter(row=>row.source_session===session.id);
 assert.equal(rows.length,accepted?1:0);
 if(accepted)assert.ok(rows[0].content.includes(evidence));
});
for(let i=0;i<8;i++)test(`更正连续性/${i+1}`,()=>{
 const row=addMemory({layer:'core',content:`纪念日是${101+i}日`});
 const next=reviseMemory(row.id,`纪念日改为${201+i}日`,row.updated_at);
 assert.equal(addMemory({layer:'core',content:row.content}).content,next.content);
 assert.throws(()=>reviseMemory(row.id,'旧页面的覆盖',row.updated_at),{status:409});
});
for(let i=0;i<8;i++)test(`跨渠道打断/${i+1}`,async()=>{
 const session=createSession('跨渠道');
 addMessage({sessionId:session.id,role:'user',channel:i%2?'qq':'web',content:`新消息${i}`});
 let generated=0;
 const channel={clients:new Set([{}]),lastInboundAt:new Map(),buffers:new Map(),followUpBudget:()=>{generated++;throw new Error('不该进入生成');}};
 await OneBotChannel.prototype.runSelfFollowUp.call(channel,{conversationKey:'owner',scheduledAt:Date.now()-1000});
 assert.equal(generated,0);
});
const closures=[['体检做完了',true],['体检已经完成',true],['体检取消了',true],['不用提醒体检了',true],['体检还没做完了',false],['如果体检做完了',false],['朋友的体检做完了',false],['工作做完了',false]];
for(const [said,closed] of closures)test(`惦记闭环/${said}`,async()=>{
 const now=new Date().toISOString();
 kvSetJson('open_intentions',[{id:'checkup',text:'问体检结果',createdAt:now,dueAt:now,tries:0}]);
 await reflect({sessionId:createSession(said).id,settings,messages:[{role:'user',content:said},{role:'assistant',content:'知道了'}],llm:{chat:async()=>({content:JSON.stringify({completed_intentions:[{id:'checkup',evidence:said}]})})}});
 assert.equal(listIntentions().length,closed?0:1);
 kvSetJson('open_intentions',[]);
});
for(const [time,quiet] of [['00:29',false],['00:30',true],['08:29',true],['08:30',false],['12:00',false],['23:00',false]])test(`主动安静时段/${time}`,()=>{
 assert.equal(isWithinWindow('00:30','08:30',new Date(`2026-11-01T${time}:00+08:00`)),quiet);
});
for(const [balance,spent,level] of [[null,0,'unknown'],[null,3,'stop'],[0,0,'stop'],[2,0,'low'],[10,0,'normal'],[10,3,'stop']])test(`异常预算/${balance}/${spent}`,()=>{
 assert.equal(evaluateBudget({balanceCny:balance,todayCostCny:spent,settings:{cost:{lowBalanceCny:5,stopBalanceCny:1.5,maxDailyCostCny:3}}}).level,level);
});
// 另四个自然度场景必须检查真实回复，见 docs/COMPANION_SCENARIOS.md；不以提示词包含某句话冒充通过。
