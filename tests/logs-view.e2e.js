import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { startTestServer } from './helpers/runtime.js';

test('日志面板：她的思考、运行事件、服务日志和自我档案都真的渲染出来', { timeout: 60000 }, async t => {
  const app = await startTestServer(t, { settings: { qq: { enabled: false }, proactive: { enabled: false } } });
  const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let selfNotes = { text: '我说话短，喜欢反问。', updatedAt: '2026-11-10T09:00:00Z', versions: 3 };
  await page.route('**/api/self-notes', route => route.fulfill({ json: selfNotes }));
  await page.route('**/api/self-notes/clear', route => { selfNotes = { text: '', updatedAt: '2026-11-10T09:10:00Z', versions: 4 }; return route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/logs/thoughts*', route => route.fulfill({ json: { thoughts: [
    { id: 7, at: '2026-11-10T08:30:00Z', channel: 'qq', thought: '他今天话很少，可能真的累了。', reply: '那你早点睡，我陪你说两句。' },
  ] } }));
  await page.route('**/api/events', route => route.fulfill({ json: { events: [
    { id: 9, type: 'self_edit', message: '她自己改了一遍自我档案', created_at: '2026-11-10T08:00:00Z' },
  ] } }));
  const serverLogs = [];
  await page.route('**/api/logs/server*', route => { serverLogs.push(new URL(route.request().url()).searchParams.get('file')); return route.fulfill({ json: { file: 'app-2026-11-10.log', text: '[2026-11-10T08:00:00.000Z] INFO 小知已启动：http://127.0.0.1:7788' } }); });
  await page.goto(app.base);
  await page.locator('.rail-btn[data-view="logs"]').click();
  await page.waitForFunction(() => document.querySelector('#logsThoughts')?.textContent?.includes('他今天话很少'));
  assert.match(await page.locator('#selfNotesText').innerText(), /我说话短/);
  assert.match(await page.locator('#selfNotesMeta').innerText(), /3 个版本/);
  assert.match(await page.locator('#logsThoughts').innerText(), /那你早点睡/);
  assert.match(await page.locator('#logsEvents').innerText(), /她自己改了一遍自我档案/);
  assert.match(await page.locator('#logsServer').innerText(), /小知已启动/);
  assert.equal(serverLogs[0], 'app');
  await page.locator('#logsFileOut').click();
  await page.waitForFunction(() => document.querySelector('#logsFileMeta').textContent.includes('server.out'));
  assert.equal(serverLogs.at(-1), 'out');
  page.on('dialog', (dialog) => dialog.accept());
  await page.locator('#selfNotesClear').click();
  await page.waitForFunction(() => document.querySelector('#selfNotesMeta').textContent.includes('还没写过'));
});