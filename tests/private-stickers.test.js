import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OneBotChannel } from '../src/channels/onebot.js';
import { saveSettings } from '../src/config.js';
import { kvSet, kvSetJson, closeDb } from '../src/db.js';
test.after(closeDb);
test('群聊或访客索要表情不能取得主人教的私人图片与 mface',async(t)=>{
 saveSettings({qq:{enabled:true,sendStickers:true,learnImages:true,sleepyMode:false},tts:{enabled:false}});
 kvSet('qq_owner_id','2000000002');kvSetJson('learned_images',[{file:'private.jpg',hash:'private'}]);kvSetJson('learned_mfaces',[{emoji_id:'private'}]);
 const channel=new OneBotChannel({server:http.createServer(),companion:{reply:async()=>({text:'给你看看。',stickerHint:'mface'})}});
 t.after(()=>channel.destroy());let privateSends=0;
 channel.delayFor=async()=>{};channel.sendToTarget=async()=>{};channel.sendStickerToTarget=async()=>{};
 channel.sendLearnedImageToTarget=async()=>{privateSends++;};channel.sendMfaceToTarget=async()=>{privateSends++;};
 channel.buffers.set('guest:test',{texts:['发个表情包'],images:[],voices:[],target:{type:'private',userId:'123456789'},nickname:'访客',guest:true});
 await channel.drainBuffer('guest:test');assert.equal(privateSends,0);
});
