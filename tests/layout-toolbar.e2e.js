import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startTestServer } from './helpers/runtime.js';

test('长短记忆操作栏对齐；动态筛选独立成行，搜索状态分页联动', { timeout: 120000 }, async t => {
  const app = await startTestServer(t, { settings: { qq: { enabled: false }, proactive: { enabled: false } } });
  const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  for (const content of ['短记忆', '很长的记忆内容'.repeat(45), 'NoSpaces'.repeat(80)]) {
    const response = await context.request.post(app.base + '/api/memories', { headers: { origin: app.base, 'x-bizhi-request': '1' }, data: { layer: 'core', importance: 5, content } });
    assert.equal(response.ok(), true);
  }
  const kinds = ['qzone', 'xhs', 'douyin'];
  const statuses = ['draft', 'approved', 'posted'];
  const posts = Array.from({ length: 29 }, (_, i) => ({ id: i + 1, kind: kinds[i % 3], status: statuses[Math.floor(i / 3) % 3], title: `记录 ${i + 1}`, content: (i % 2 ? '搜索词 星光' : '普通正文').repeat(i % 4 + 1), tags: ['测试'], created_at: '2026-11-07T00:00:00Z' }));
  await page.route('**/api/posts', route => route.fulfill({ json: { posts, labels: { qzone: 'QQ 空间', xhs: '小红书', douyin: '抖音' } } }));
  await page.goto(app.base);
  await page.locator('.rail-btn[data-view="memory"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.mem-card').length === 3);
  const shots = path.resolve('data/browser-verification'); fs.mkdirSync(shots, { recursive: true });
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('.rail-btn[data-view="memory"]').click();
    const xs = await page.locator('.mem-actions').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().x));
    assert.ok(Math.max(...xs) - Math.min(...xs) < 2, `${width}: memory actions shifted`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.getByRole('button', { name: '更正', exact: true }).first().click();
    await page.getByRole('textbox', { name: '更正这条记忆' }).fill('保留修改草稿');
    assert.equal(await page.locator('.mem-editor .btn-row').count(), 1);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.rail-btn[data-view="social"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.post-card').length === 12);
    const filters = await page.locator('#postFilters').boundingBox();
    const grid = await page.locator('#postList').boundingBox();
    assert.ok(filters.height < 110 && filters.y + filters.height <= grid.y, `${width}: filters stretched into cards`);
    assert.equal(await page.locator('#postList > .tabs').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    if (width <= 520) {
      const intro = await page.locator('.social-toolbar > div:first-child').boundingBox();
      const actions = await page.locator('.social-toolbar > .btn-row').boundingBox();
      assert.ok(actions.y - (intro.y + intro.height) < 25, `${width}: toolbar has a stretched empty area`);
    }
    await page.screenshot({ path: path.join(shots, `toolbar-social-${width}.png`) });
    await page.locator('.rail-btn[data-view="memory"]').click();
    await page.screenshot({ path: path.join(shots, `toolbar-memory-${width}.png`) });
  }
  await page.locator('.rail-btn[data-view="social"]').click();
  await page.locator('#postNextPage').click();
  assert.equal(await page.locator('#postPageInfo').innerText(), '第 2 / 3 页');
  await page.locator('#postNextPage').click();
  assert.equal(await page.locator('.post-card').count(), 5);
  assert.equal(await page.locator('#postNextPage').isDisabled(), true);
  await page.locator('[data-post-filter="douyin"]').click();
  assert.equal(await page.locator('.post-card').count(), 9);
  await page.locator('#postStatusFilter').selectOption('approved');
  assert.equal(await page.locator('.post-card').count(), 3);
  await page.locator('#postSearch').fill('星光');
  assert.equal(await page.locator('.post-card').count(), 2);
  assert.equal(await page.locator('[data-post-filter="douyin"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#postSearch').fill('完全不匹配');
  assert.equal(await page.locator('.post-card').count(), 0);
  assert.match(await page.locator('#postList').innerText(), /没有匹配/);
  await page.locator('#postSearch').fill('');
  assert.equal(await page.locator('.post-card').count(), 3);
  assert.deepEqual(errors, []);
});
