import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dataDir = path.join(ROOT, 'data', 'test-xhs-activity-' + process.pid);
fs.mkdirSync(dataDir, { recursive: true });
process.env.BIZHI_DATA_DIR = dataDir;
process.env.LLM_MOCK = '1';

const { recordXhsActivity, getRecentXhsActivity } = await import('../src/channels/xhs-actions.js');
const { Companion } = await import('../src/chat.js');
const { DeepSeek } = await import('../src/llm.js');
const { closeDb, kvSet } = await import('../src/db.js');

test('她做过的小红书动作会被记下来，并且只留最近的', () => {
  recordXhsActivity({ type: 'comment', note: '一个人做的意面', text: '这个我也想去试试', target: '某个博主' });
  recordXhsActivity({ type: 'reply_owner', note: '她的主页简介', text: '收到啦', target: '测试主人昵称' });
  const list = getRecentXhsActivity({ hours: 48, limit: 8 });
  assert.equal(list.length, 2);
  assert.equal(list[0].type, 'reply_owner', '最近的排在前面');
  assert.match(list[0].text, /收到啦/);
  for (let i = 0; i < 260; i += 1) recordXhsActivity({ type: 'like', note: '第 ' + i + ' 条' });
  const kept = getRecentXhsActivity({ hours: 48, limit: 400 });
  assert.equal(kept.length, 200, '最多留 200 条（一周报要够数）');
  assert.equal(kept.some((item) => item.note === '第 0 条'), false, '太旧的要被挤掉');
  assert.equal(kept.some((item) => item.note === '第 259 条'), true, '最新的必须留着');
});

test('通知角标只在它自己的时间窗里出现，别在周报里赖着不走', () => {
  kvSet('xhs_notification_badge', '3');
  kvSet('xhs_notification_checked_at', new Date(Date.now() - 200 * 3600000).toISOString());
  assert.equal(getRecentXhsActivity({ hours: 168, limit: 50 }).some((item) => item.type === 'notify'), false, '两百年前查过的角标不该再报');
  kvSet('xhs_notification_checked_at', new Date().toISOString());
  const fresh = getRecentXhsActivity({ hours: 48, limit: 50 });
  assert.equal(fresh.some((item) => item.type === 'notify' && /3 条/.test(item.text)), true, '刚查到的角标要在');
  kvSet('xhs_notification_badge', '0');
});

test('QQ 私聊里她知道自己在小红书上干过什么，群里和陌生人不知道', async () => {
  const companion = new Companion({ llm: new DeepSeek() });
  const privatePrep = companion.prepare({ text: '你今天干嘛了', channel: 'qq' });
  assert.ok(privatePrep.block.xhsActivity?.length >= 1, '私聊要带上她做过的事');
  assert.match(privatePrep.payload.system, /只有真做过才在里面/);
  assert.match(privatePrep.payload.system, /别编/);

  const groupPrep = companion.prepare({ text: '在吗', channel: 'qq-group' });
  assert.equal(groupPrep.block.xhsActivity, undefined, '群里不该带这些');
  assert.ok(!groupPrep.payload.system.includes('只有真做过才在里面'), '群聊提示词里不能出现她的平台活动清单');
  const guestPrep = companion.prepare({ text: '你好', channel: 'qq-guest' });
  assert.ok(!guestPrep.payload.system.includes('只有真做过才在里面'));
});

test.after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
