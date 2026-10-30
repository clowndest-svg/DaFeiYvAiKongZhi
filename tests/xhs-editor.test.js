import test from 'node:test';
import assert from 'node:assert/strict';
import { xhsBrowser, publishFilledXhsNote } from '../src/channels/xhs.js';
import { kvSet, kvSetJson, closeDb } from '../src/db.js';
import { saveSettings } from '../src/config.js';
test.after(closeDb);
test('当前编辑器被改后拒绝发布，不能只信缓存稿件',async(t)=>{
 saveSettings({social:{xhsEnabled:true,xhsPublishPerDay:1}});kvSet('xhs_self_user_id','verified-self');
 kvSetJson('xhs_last_fill',{id:'draft',selfId:'verified-self',title:'云很好看',body:'今天看看云',images:1,at:new Date().toISOString()});
 const browser=xhsBrowser();let clicks=0;
 t.mock.method(browser,'ensure',async()=>{});
 t.mock.method(browser,'evaluateFunction',async()=>({title:'私下偷偷改的稿',body:'different',images:1,url:'https://creator.xiaohongshu.com/publish/publish'}));
 t.mock.method(browser,'evaluate',async()=>{clicks++;return true;});
 await assert.rejects(()=>publishFilledXhsNote(),/不一致/);assert.equal(clicks,0);
});
