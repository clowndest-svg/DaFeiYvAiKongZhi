import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
const hours=Math.min(168,Math.max(0.001,Number(args.hours)||72));
const interval=Math.min(300,Math.max(10,Number(args.interval)||60))*1000;
const vars={};
for(const line of fs.readFileSync('.env','utf8').replace(/^\uFEFF/,'').split(/\r?\n/)){
  const match=line.trim().match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
  if(match)vars[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
}
const base=`http://127.0.0.1:${Number(vars.PORT)||7788}`;
const output=path.resolve('data/stability-observation.json');
let cookie='';
const started=Date.now(), deadline=started+hours*3600000;
const result={collectorPid:process.pid,startedAt:new Date(started).toISOString(),plannedEndAt:new Date(deadline).toISOString(),plannedHours:hours,intervalSeconds:interval/1000,status:'collecting',samples:0,requestFailures:0,qqOfflineSamples:0,identityFailures:0,serverRestarts:0,samplingGaps:0,memory:{firstRss:null,lastRss:null,maxRss:0},lastSample:null};
const headers=()=>({'content-type':'application/json',origin:base,'x-bizhi-request':'1',...(cookie?{cookie}:{})});
async function login(){
  const response=await fetch(base+'/api/login',{method:'POST',headers:headers(),body:JSON.stringify({password:vars.CONSOLE_PASSWORD||vars.CONSOLE_TOKEN||''}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('authentication unavailable');
  cookie=String(response.headers.get('set-cookie')||'').split(';')[0];
}
let previousAt=0, previousPid=null;
function save(){fs.writeFileSync(output+'.tmp',JSON.stringify(result,null,2));fs.renameSync(output+'.tmp',output);}
try{
  await login();
  do{
    const now=Date.now();
    if(previousAt && now-previousAt>interval*2.5)result.samplingGaps++;
    previousAt=now;
    try{
      let response=await fetch(base+'/api/status',{headers:headers(),signal:AbortSignal.timeout(10000)});
      if(response.status===401){await login();response=await fetch(base+'/api/status',{headers:headers(),signal:AbortSignal.timeout(10000)});}
      if(!response.ok)throw new Error('status unavailable');
      const state=await response.json();result.samples++;
      if(state.qq?.connected===false)result.qqOfflineSamples++;
      if(state.qq?.connected===true && state.qq?.identityOk===false)result.identityFailures++;
      const runtime=state.runtime||{},rss=Number(runtime.memory?.rss)||null;
      if(rss){result.memory.firstRss??=rss;result.memory.lastRss=rss;result.memory.maxRss=Math.max(result.memory.maxRss,rss);}
      if(previousPid && runtime.pid && previousPid!==runtime.pid)result.serverRestarts++;
      previousPid=runtime.pid||previousPid;
      result.lastSample={at:new Date(now).toISOString(),qqConnected:state.qq?.connected===true,identityOk:state.qq?.connected===true?state.qq?.identityOk===true:null,pid:runtime.pid||null,rss,uptimeSeconds:runtime.uptimeSeconds??null};
    }catch{result.requestFailures++;result.lastFailureAt=new Date(now).toISOString();}
    save();
    if(Date.now()>=deadline)break;
    await sleep(Math.min(interval,deadline-Date.now()));
  }while(true);
  result.status='completed';result.endedAt=new Date().toISOString();
  result.note='采样完成不自动等于稳定性合格；需结合故障、采样缺口与资源趋势复核。';save();
}catch{result.status='failed';result.note='观察未能开始或持续，需检查本地服务/认证与文件写入。';save();process.exitCode=1;}
finally{if(cookie)await fetch(base+'/api/logout',{method:'POST',headers:headers(),signal:AbortSignal.timeout(10000)}).catch(()=>{});}
