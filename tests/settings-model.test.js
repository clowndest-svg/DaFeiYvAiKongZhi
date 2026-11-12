import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsScopePatch, catalogPage } from '../web/settings-model.js';

test('聊天保存包含联网和记忆中的做梦字段，主动、X、小红书草稿互不串写', () => {
  const values = { companion: {}, model: { name: 'demo' }, memory: {}, search: { enabled: false }, proactive: { enabled: false, dreamEnabled: true, dreamHour: 0 }, social: { enabled: false, activeStart: '10:00', xEnabled: true, xDailyLikeMax: 0, xhsEnabled: false, xhsDailyLikeMax: 2 } };
  assert.deepEqual(settingsScopePatch(values, 'chat'), { model: values.model, memory: {}, search: { enabled: false }, proactive: { dreamEnabled: true, dreamHour: 0 } });
  assert.deepEqual(settingsScopePatch(values, 'proactive'), { proactive: { enabled: false } });
  assert.deepEqual(settingsScopePatch(values, 'x'), { social: { xEnabled: true, xDailyLikeMax: 0 } });
  assert.deepEqual(settingsScopePatch(values, 'xhs'), { social: { xhsEnabled: false, xhsDailyLikeMax: 2 } });
  assert.deepEqual(settingsScopePatch(values, 'social'), { social: { enabled: false, activeStart: '10:00' } });
});

test('音色目录搜索、过滤后修正页码，空结果和末页不丢记录', () => {
  const models = Array.from({ length: 36 }, (_, i) => ({ id: String(i), title: `VOICE ${i}`, family: '测试', available: i % 2 === 0 }));
  assert.equal(catalogPage(models).pages, 6);
  assert.equal(catalogPage(models, { page: 5 }).items.at(-1).id, '35');
  assert.equal(catalogPage(models, { filter: 'ready' }).total, 18);
  assert.equal(catalogPage(models, { query: 'voice 35', page: 5 }).page, 0);
  assert.equal(catalogPage(models, { filter: 'selected', selected: '12' }).items[0].id, '12');
  assert.deepEqual(catalogPage(models, { query: '无结果' }).items, []);
});

test('抖音音轨分区独立保存，动态分区不会覆盖未保存的音轨草稿', () => {
  const social = { enabled: true, qzoneAutoReply: true, douyinAudioEnabled: false, douyinAudioSeconds: 22, xEnabled: true };
  assert.deepEqual(settingsScopePatch({ social }, 'douyin'), { social: { douyinAudioEnabled: false, douyinAudioSeconds: 22 } });
  assert.deepEqual(settingsScopePatch({ social }, 'social'), { social: { enabled: true, qzoneAutoReply: true } });
});
