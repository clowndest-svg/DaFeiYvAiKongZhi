import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { extractDouyinPageComments, extractDouyinVideoContext, openDouyinReplyTarget, probeDouyinReplySubmit } from '../src/channels/douyin.js';

test('嵌套回复按自己的评论 ID 定位，父评论不会包含子评论正文', async t => {
  const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<div data-e2e="comment-list">
    <div data-e2e="comment-item"><span id="tooltip_111111"></span><a href="/user/a">父作者</a><p>父评论</p><span onclick="window.pressed='parent'">回复</span>
      <div data-e2e="comment-item"><span id="tooltip_222222"></span><a href="/user/b">子作者</a><p>子评论</p><span onclick="window.pressed='child'">回复</span></div>
    </div></div>`);
  const result = await page.evaluate(extractDouyinPageComments);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].id, '111111');
  assert.doesNotMatch(result.items[0].text, /子评论/);
  assert.equal(result.items[1].id, '222222');
  assert.equal(await page.evaluate(openDouyinReplyTarget, '222222'), '子作者');
  assert.equal(await page.evaluate(() => window.pressed), 'child');
  assert.equal(await page.evaluate(openDouyinReplyTarget, '333333'), null);
});

test('发送前必须同时匹配视频、评论、对象、内容和唯一控件', async t => {
  const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://www.douyin.com/video/123456', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div data-e2e="comment-item">
    <span id="tooltip_456789"></span><a href="/user/test">对方</a><span id="hint">回复@对方</span>
    <div contenteditable="true" role="combobox" aria-describedby="hint">你好</div>
    <span style="display:inline-block;width:30px;height:30px"><svg width="30" height="30"><path d="M17.5 30C23.851 30 29 25 29 18"></path></svg></span>
    </div>` }));
  await page.goto('https://www.douyin.com/video/123456');
  const expected = { videoId: '123456', commentId: '456789', target: '对方', text: '你好' };
  assert.ok(await page.evaluate(probeDouyinReplySubmit, expected));
  assert.equal(await page.evaluate(probeDouyinReplySubmit, { ...expected, text: '其他内容' }), null);
  assert.equal(await page.evaluate(probeDouyinReplySubmit, { ...expected, target: '其他人' }), null);
  assert.equal(await page.evaluate(probeDouyinReplySubmit, { ...expected, videoId: '654321' }), null);
  assert.equal(await page.evaluate(probeDouyinReplySubmit, { ...expected, commentId: '999999' }), null);
  await page.locator('body').evaluate(element => element.append('请完成下列验证'));
  assert.equal(await page.evaluate(probeDouyinReplySubmit, expected), null);
});

test('视频页提取：标题简介齐全，验证页和无视频页都如实报告', async t => {
  const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<h1>做菜教程</h1><p data-e2e="video-desc">三步搞定家常菜</p><video></video>');
  const result = await page.evaluate(extractDouyinVideoContext);
  assert.equal(result.verification, false);
  assert.equal(result.hasVideo, true);
  assert.equal(result.title, '做菜教程');
  assert.equal(result.desc, '三步搞定家常菜');
  assert.equal(result.playing, false, '没播放就不能说在播放');
  await page.setContent('<h1>标题</h1><p>请完成下列验证</p>');
  const blocked = await page.evaluate(extractDouyinVideoContext);
  assert.equal(blocked.verification, true);
  assert.equal(blocked.hasVideo, false);
});
