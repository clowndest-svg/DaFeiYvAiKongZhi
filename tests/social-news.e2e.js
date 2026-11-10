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
  let resolveBrowse;
  const browsePosted = new Promise(resolve => { resolveBrowse = resolve; });
  await page.route('**/api/douyin/browse', route => { resolveBrowse(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, enabled: true } }); });
  await page.route('**/api/douyin/videos', route => route.fulfill({ json: { ok: true, items: [
    { id: '123456', url: 'https://www.douyin.com/video/123456', title: '测试视频' },
  ] } }));
  let resolveUnderstand;
  const understandPosted = new Promise(resolve => { resolveUnderstand = resolve; });
  await page.route('**/api/douyin/understand', route => { resolveUnderstand(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, note: { videoId: '123456' } } }); });
  await page.goto(app.base);
  await page.locator('.rail-btn[data-view="social"]').click();
  await page.locator('#douyinReadNotes').evaluate(button => { button.closest('details').open = true; });
  await page.locator('#douyinReadNotes').click();
  await page.locator('#douyinVideoNotes .search-row').waitFor();
  assert.match(await page.locator('#douyinVideoNotes').innerText(), /画面里在做菜/);
  assert.match(await page.locator('#douyinVideoNotes').innerText(), /今天已看 2 条/);
  assert.equal(await page.locator('#douyinBrowseEnabled').isChecked(), false);
  await page.locator('#douyinBrowseEnabled').check();
  assert.deepEqual(await browsePosted, { enabled: true });
  await page.locator('#douyinReadVideos').evaluate(button => { button.closest('details').open = true; });
  await page.locator('#douyinReadVideos').click();
  await page.locator('#douyinVideos button').click();
  assert.deepEqual(await understandPosted, { videoId: '123456' });
});
