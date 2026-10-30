import test from 'node:test';
import assert from 'node:assert/strict';
import { isOwnerConversation } from '../src/channels/xhs-safety.js';
import { kvSet, kvSetJson, closeDb } from '../src/db.js';
import { normalizeSettings } from '../src/config.js';
import { withXhsBrowser } from '../src/channels/xhs.js';
test.after(closeDb);
test('完整主页 ID 不截断，同名用户不能冒认主人', () => {
 const id='6a0000000000000000000001';
 assert.equal(normalizeSettings({social:{xhsOwnerUserId:id}}).social.xhsOwnerUserId,id);
 kvSet('xhs_self_user_id','self'); kvSetJson('xhs_owner_binding',{selfId:'self',convId:'verified'});
 assert.equal(isOwnerConversation({name:'same name',convId:'unverified'}),false);
 assert.equal(isOwnerConversation({convId:'verified'}),true);
 kvSet('xhs_self_user_id','another'); assert.equal(isOwnerConversation({convId:'verified'}),false);
});
test('浏览器队列支持嵌套调用且保持互斥', async () => {
 const order=[];
 await Promise.all([withXhsBrowser(async()=>{order.push(1);await withXhsBrowser(()=>order.push(2));}),withXhsBrowser(()=>order.push(3))]);
 assert.deepEqual(order,[1,2,3]);
});
