import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startTestServer } from './helpers/runtime.js';

const shots=path.resolve('data/browser-verification');fs.mkdirSync(shots,{recursive:true});
test('真实浏览器：登录、聊天/停止、设置回环、记忆、动态和窄屏', {timeout:120000},async(t)=>{
 const cleanups=[];
 const app=await startTestServer({after:fn=>cleanups.push(fn)},{password:'browser-test-password',settings:{companion:{name:'测试鲸鲸'},qq:{enabled:false},proactive:{enabled:false},social:{xhsEnabled:false}}});
 const executable=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file=>fs.existsSync(file));
 if(!executable)throw new Error('No installed Chromium browser for full browser verification');
 const temp=path.join(app.dir,'browser');
 const context=await chromium.launchPersistentContext(temp,{executablePath:executable,headless:true,viewport:{width:1440,height:900},env:{...process.env,TEMP:app.dir,TMP:app.dir}});
 t.after(async()=>{await context.close();for(const cleanup of cleanups)await cleanup();});
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(app.base);
 await page.locator('#loginScreen').waitFor({state:'visible'});
 await page.locator('#loginPassword').fill('browser-test-password');await page.locator('#loginSubmit').click();
 await page.locator('#loginScreen').waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.querySelector('#topName').textContent==='测试鲸鲸');
 await page.locator('#chatInput').fill('测试一条普通聊天');await page.locator('#sendBtn').click();
 await page.waitForFunction(()=>document.querySelector('#sendBtn').textContent==='发送'&&document.querySelectorAll('.msg.assistant').length>0);
 assert.ok((await page.locator('#messages').innerText()).includes('测试模式'));
 await page.locator('#chatInput').fill('这条中途停下');await page.locator('#sendBtn').click();
 await page.locator('.bubble.streaming').waitFor();await page.locator('#sendBtn').click();
 await page.waitForFunction(()=>document.querySelector('#sendBtn').textContent==='发送');
 await page.locator('#chatInput').fill('停下之后的新消息');await page.locator('#sendBtn').click();
 await page.waitForFunction(()=>document.querySelector('#sendBtn').textContent==='发送');
 await page.waitForFunction(()=>document.querySelector('#messages').innerText.includes('停下之后的新消息'));
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForTimeout(150);
 await page.screenshot({path:path.join(shots,'chat-desktop.png')});
 await page.locator('.rail-btn[data-view="settings"]').click();
 await page.locator('#setName').fill('保留未保存内容');await page.waitForTimeout(4500);
 assert.equal(await page.locator('#setName').inputValue(),'保留未保存内容');
 await page.locator('#setMaxPerDay').fill('0');await page.locator('#saveSettingsBtn').click();
 await page.waitForFunction(()=>document.querySelector('#saveHint').textContent==='已保存');
 assert.equal(await page.locator('#setMaxPerDay').inputValue(),'0');
 await page.screenshot({path:path.join(shots,'settings-desktop.png')});
 await page.locator('.rail-btn[data-view="memory"]').click();
 await page.locator('#memoryContentInput').fill('浏览器测试：喜欢喝温水');await page.locator('#addMemoryBtn').click();
 await page.waitForFunction(()=>document.querySelector('#memoryContent').innerText.includes('喜欢喝温水'));
 await page.locator('.rail-btn[data-view="social"]').click();
 await page.locator('[data-post-kind="qzone"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.post-card').length>0);
 for(const width of [768,390,337]){
  await page.setViewportSize({width,height:844});
  for(const view of ['chat','memory','social','settings']){
   await page.locator(`.rail-btn[data-view="${view}"]`).click();
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   assert.equal(overflow,false,`${width}px ${view} overflow`);
  }
  await page.screenshot({path:path.join(shots,`settings-${width}.png`)});
 }
 assert.deepEqual(errors,[],'浏览器不得有未处理的 JS 错误');
 console.log(JSON.stringify({browser:'installed Chromium',viewports:[1440,768,390,337],screenshots:path.relative(process.cwd(),shots),pageErrors:errors.length}));
});
