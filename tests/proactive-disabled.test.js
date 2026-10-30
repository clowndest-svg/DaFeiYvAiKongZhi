import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/runtime.js';
test('关闭主动功能时手动入口返回未发送，而非空结果引发 500',async(t)=>{
 const app=await startTestServer(t,{settings:{proactive:{enabled:false}}});
 const response=await fetch(app.base+'/api/actions/proactive',{method:'POST'});
 assert.equal(response.status,200);const data=await response.json();assert.equal(data.ok,false);assert.match(data.reason,/不允许/);
});
