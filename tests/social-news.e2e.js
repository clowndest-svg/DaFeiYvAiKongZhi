import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { startTestServer } from './helpers/runtime.js';

test('资讯候选可核对来源并填入共用选题，来源链接拒绝脚本协议', { timeout: 60000 }, async t => {
  const app = await startTestServer(t, { settings: { qq: { enabled: false }, proactive: { enabled: false } } });
  const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/api/social/news', route => route.fulfill({ json: { ok: true, items: [
    { title: '官方模型更新', url: 'https://example.com/announcement' },
    { title: '待核对资讯', url: 'javascript:alert(1)' },
  ] } }));
  await page.goto(app.base);
  await page.locator('.rail-btn[data-view="social"]').click();
  await page.locator('#socialNewsRefresh').click();
  await page.locator('#socialNewsResults button').first().click();
  assert.equal(await page.locator('#socialTopic').inputValue(), '官方模型更新');
  assert.equal(await page.locator('#socialNewsResults a').count(), 1);
});

test('刷视频界面：笔记真渲染、开关真发请求、「理解这条」带对视频 ID', { timeout: 60000 }, async t => {
  const app = await startTestServer(t, { settings: { qq: { enabled: false }, proactive: { enabled: false } } });
  const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/api/douyin/video-notes', route => route.fulfill({ json: { notes: [
    { videoId: '123456', url: 'https://www.douyin.com/video/123456', title: '测试视频', summary: '画面里在做菜', topics: ['美食'], tone: '轻松', playing: true, at: '2026-11-10T08:00:00Z' },
  ], browseEnabled: false, today: 2 } }));
  const browsePosts = [];
  await page.route('**/api/douyin/browse', route => { browsePosts.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, enabled: true } }); });
  await page.route('**/api/douyin/videos', route => route.fulfill({ json: { ok: true, items: [
    { id: '123456', url: 'https://www.douyin.com/video/123456', title: '测试视频' },
  ] } }));
  let resolveUnderstand;
  const understandPosted = new Promise(resolve => { resolveUnderstand = resolve; });
  await page.route('**/api/douyin/understand', route => { resolveUnderstand(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, note: { videoId: '123456' } } }); });
  const until = async fn => { for (let i = 0; i < 60; i += 1) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('等待请求超时'); };
  await page.goto(app.base);
  await page.locator('.rail-btn[data-view="social"]').click();
  await page.locator('#douyinReadNotes').evaluate(button => { button.closest('details').open = true; });
  await page.locator('#douyinReadNotes').click();
  await page.locator('#douyinVideoNotes .search-row').waitFor();
  assert.match(await page.locator('#douyinVideoNotes').innerText(), /画面里在做菜/);
  assert.match(await page.locator('#douyinVideoNotes').innerText(), /今天已看 2 条/);
  assert.equal(await page.locator('#douyinBrowseEnabled').isChecked(), false);
  await page.locator('#douyinBrowseEnabled').check();
  await until(() => browsePosts.length === 1);
  assert.deepEqual(browsePosts[0], { enabled: true });
  await page.locator('#douyinReadVideos').evaluate(button => { button.closest('details').open = true; });
  await page.locator('#douyinReadVideos').click();
  await page.locator('#douyinVideos button').click();
  assert.deepEqual(await understandPosted, { videoId: '123456' });

  // 设置页的抖音分区：状态行读真实服务端，开关和动态页同一份状态，快捷跳转把三张卡都展开。
  await page.locator('.rail-btn[data-view="settings"]').click();
  await page.locator('#settings-tab-douyin').click();
  await page.waitForFunction(() => {
    const node = document.querySelector('#douyinSettingsStatus');
    return node && !node.textContent.includes('正在读取');
  });
  const status = await page.locator('#douyinSettingsStatus').innerText();
  assert.match(status, /还没绑定抖音号/);
  assert.match(status, /发送未实机验收/);
  assert.equal(await page.locator('#douyinToggleAutoReply').isDisabled(), true, '发送闸门没开时自动回复开关必须禁用');
  assert.equal(await page.locator('#douyinToggleBrowse').isChecked(), false);
  await page.locator('#douyinToggleBrowse').check();
  await until(() => browsePosts.length === 2);
  assert.deepEqual(browsePosts[1], { enabled: true });
  await page.locator('#douyinToggleMonitor').check();
  await page.locator('#douyinToSocial').click();
  assert.equal(await page.locator('#view-social').evaluate(node => node.classList.contains('active')), true);
  assert.equal(await page.locator('#douyinReadNotes').evaluate(button => button.closest('details').open), true);
});
