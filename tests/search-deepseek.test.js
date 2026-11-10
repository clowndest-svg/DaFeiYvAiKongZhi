// DeepSeek 官方 Search / Fetch 接口的判据。全部离线跑：fetch 用替身，钱记在测试自己的台账里。
// 唯一一份"成功响应"用的是当天真实抓取下来的 fixture，不是照文档想象写的形状。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../src/config.js';
import { saveSettings } from '../src/config.js';
import { closeDb, kvSet, kvSetJson, toolCallsToday } from '../src/db.js';
import { Companion } from '../src/chat.js';
import { shanghaiDayKey } from '../src/util.js';
import {
  PRICE_PER_REQUEST_CNY,
  QUALITY_SCORE,
  deepseekFetch,
  deepseekSearch,
  isPublicHttpUrl,
  mapSearchItem,
  pickQualityResults,
} from '../src/search-deepseek.js';
import { extractReadableUrl, formatPageNote, formatSearchNote, readWebPage, searchStatus, searchWeb } from '../src/search.js';

test.after(closeDb);
// 搜索缓存会跨用例串味儿：每个用例开始前清空，判据才是在看这次请求。
beforeEach(() => { kvSetJson('search:cache', []); });

const REAL = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'deepseek-search.sample.json'), 'utf8'));
const NO_WAIT = async () => {};

function jsonResponder(payload, status = 200) {
  return async (url, options) => ({
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
    url: String(url),
    options,
  });
}

// 记录每一次出门的请求，判"该不该发""发几次"都靠它。
function recorder(payloadList) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), body: options && options.body ? JSON.parse(options.body) : null, auth: options && options.headers ? options.headers.Authorization : null });
    const next = payloadList[Math.min(calls.length - 1, payloadList.length - 1)];
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, options);
    return next;
  };
  return { calls, impl };
}

const SEARCH_SETTINGS = { enabled: true, dailyMax: 20, maxResults: 3, timeoutSeconds: 8, provider: 'deepseek', minScore: 1.5, readPages: true, fetchDailyMax: 10 };

test('真实响应的字段都能落地：分数从高到低、长摘要当资料、出处与时效留着', () => {
  assert.ok(Array.isArray(REAL.results) && REAL.results.length >= 3, 'fixture 不是当天真实抓的形状');
  const { items } = pickQualityResults(REAL, { minScore: QUALITY_SCORE, limit: 3 });
  assert.equal(items.length, 3, `应当带回 3 条，实际 ${items.length}`);
  const scores = items.map((item) => item.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), '没按可信度从高到低排');
  for (const item of items) {
    assert.match(item.url, /^https?:\/\//);
    assert.ok(item.title.length > 0);
    assert.ok(item.snippet.length > 0, '长摘要没落到 snippet，她拿到的就是空资料');
    assert.equal(item.source, 'deepseek');
    assert.ok(Number.isFinite(item.authority));
    assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/, '发布时间没保留');
  }
  // 上游给的顺序不一定是按分数排的：倒着喂进去，带回的顺序必须还是高分在前（真实条目，只换顺序）。
  const shuffled = { results: [...REAL.results].reverse() };
  const again = pickQualityResults(shuffled, { minScore: QUALITY_SCORE, limit: REAL.results.length }).items.map((item) => item.score);
  assert.deepEqual(again, [...REAL.results].map((r) => Number(r.rerank_score.toFixed(2))).sort((a, b) => b - a), '输入顺序一变就不排序了');
  // 长摘要（summary）比短摘要（snippet）更适合当资料，实测两者内容不同，取的是前者。
  const first = REAL.results.find((r) => r.summary && r.summary !== r.snippet);
  if (first) assert.notEqual(mapSearchItem(first).snippet, mapSearchItem(first).short, '该用长摘要时用了短摘要');
});

test('没有网址的条目不算结果，null 站点名不许变成 "null"', () => {
  const item = mapSearchItem({ title: '没有链接的一条', url: '', site_name: null, summary: '甲', rerank_score: 2 });
  assert.equal(item, null, '缺 url 也被当成结果了');
  const withContent = mapSearchItem({ title: '带正文的一条', url: 'https://a.example/x', summary: '摘要', content: '正文'.repeat(1200), rerank_score: 2 });
  assert.equal(withContent.content.slice(0, 2), '正文', 'need_content 拿到的正文没带回来');
  assert.ok(withContent.content.length <= 1600, `正文没截断：${withContent.content.length}`);
  const noContent = mapSearchItem({ title: '没正文的一条', url: 'https://a.example/y', summary: '摘要', content: '', rerank_score: 2 });
  assert.equal(noContent.content, '', '空正文要如实留空，等补读');
  const ok = mapSearchItem({ title: '甲', url: 'https://a.example/x', site_name: null, rerank_score: 1.9, authority: -1 });
  assert.equal(ok.site, '');
  assert.equal(ok.authority, -1, '权威性未知（-1）被洗成别的数了');
});

test('低分结果不当资料：判"可信度都低"，但那一次钱照样记账（不许谎报没花钱）', async () => {
  saveSettings({ search: SEARCH_SETTINGS });
  const low = { results: [
    { title: '低质一页', url: 'https://low.example/a', summary: '乙', snippet: '乙', rerank_score: 0.8, authority: 1, site_name: 'low', date: '2026-01-01T00:00:00+00:00' },
    { title: '还低一页', url: 'https://low.example/b', summary: '丙', snippet: '丙', rerank_score: 1.2, authority: 0, site_name: 'low', date: '2026-01-02T00:00:00+00:00' },
  ] };
  const { calls, impl } = recorder([jsonResponder(low)]);
  const before = toolCallsToday();
  const found = await deepseekSearch('DeepSeek 新接口', { fetchImpl: impl, wait: NO_WAIT });
  assert.equal(calls.length, 1);
  assert.equal(found.ok, false, '全是低分却报了成功');
  assert.equal(found.lowQuality, true, '没区分"搜到但不可信"和"没搜到"');
  assert.match(found.reason, /可信度都低/);
  assert.equal(found.items.length, 0);
  assert.equal(found.all.length, 2, '低分条目应当留着给界面看');
  const after = toolCallsToday();
  assert.equal(after.search, before.search + 1, '上游给了结果就该按次计费，哪怕我们自己判为不可信');
  assert.ok(after.costCny - before.costCny >= PRICE_PER_REQUEST_CNY * 0.999, '花费没落到台账');
});

test('空结果与失败都不记账：只有 200 + 有结果才收钱', async () => {
  saveSettings({ search: SEARCH_SETTINGS });
  const before = toolCallsToday();
  const empty = await deepseekSearch('冷门问题', { fetchImpl: jsonResponder({ results: [] }), wait: NO_WAIT });
  assert.equal(empty.ok, false);
  assert.equal(empty.empty, true, '没区分"网上没匹配到"');
  assert.match(empty.reason, /没有匹配结果/);
  const httpFail = await deepseekSearch('冷门问题', { fetchImpl: jsonResponder({ error: { message: 'overloaded' } }, 500), wait: NO_WAIT });
  assert.equal(httpFail.ok, false);
  assert.match(httpFail.reason, /500/);
  const after = toolCallsToday();
  assert.equal(after.search, before.search, '空结果和失败被记账了');
  assert.equal(after.costCny, before.costCny, '没成功却产生了费用');
});

test('重试只给官方点名那几种：429/500/超时再来一次，401/402/400 一次就停（多试只是白烧额度）', async () => {
  saveSettings({ search: SEARCH_SETTINGS });
  const cases = [
    { status: 429, wantAttempts: 2, want: /每秒请求数/ },
    { status: 500, wantAttempts: 2, want: /服务端错误/ },
    { status: 504, wantAttempts: 2, want: /上游超时/ },
    { status: 402, wantAttempts: 1, want: /余额不足/ },
    { status: 401, wantAttempts: 1, want: /Key 不通/ },
    { status: 400, wantAttempts: 1, want: /HTTP 400/ },
  ];
  for (const scenario of cases) {
    const { calls, impl } = recorder([jsonResponder({ error: { message: 'x' } }, scenario.status)]);
    const found = await deepseekSearch('DeepSeek 状态码', { fetchImpl: impl, wait: NO_WAIT });
    assert.equal(found.ok, false, `HTTP ${scenario.status} 不该报成功`);
    assert.equal(calls.length, scenario.wantAttempts, `HTTP ${scenario.status} 发了 ${calls.length} 次，应为 ${scenario.wantAttempts} 次`);
    assert.match(found.reason, scenario.want, `HTTP ${scenario.status} 的原因不对：${found.reason}`);
  }
  const thrown = recorder([new Error('socket hang up'), new Error('socket hang up')]);
  const network = await deepseekSearch('DeepSeek 断网', { fetchImpl: thrown.impl, wait: NO_WAIT });
  assert.equal(thrown.calls.length, 2, '网络层错误应当重试一次');
  assert.equal(network.ok, false);
  assert.match(network.reason, /socket hang up/);
});

test('请求体只带文档认得的字段，长句截到 128，count 夹在 1~50', async () => {
  saveSettings({ search: SEARCH_SETTINGS });
  const { calls, impl } = recorder([jsonResponder(REAL)]);
  await deepseekSearch('一个很长很长的查询词'.repeat(20), { count: 999, oriQuestion: '原始问题'.repeat(40), fetchImpl: impl, wait: NO_WAIT });
  const body = calls[0].body;
  assert.equal(Object.keys(body).sort().join(','), 'count,ori_question,query', '发出去了文档没定义的字段');
  assert.ok(body.query.length <= 128, `query ${body.query.length} 字，超了 128`);
  assert.equal(body.count, 50, 'count 没夹在 1~50');
  assert.ok(body.ori_question.length <= 128);
  assert.match(calls[0].auth, /^Bearer /, '没带 Bearer 鉴权');
  assert.match(calls[0].url, /\/v1\/tools\/search$/, '端点不对');
  const needBody = recorder([jsonResponder(REAL)]);
  await deepseekSearch('短词', { count: 5, needContent: true, fetchImpl: needBody.impl, wait: NO_WAIT });
  assert.equal(needBody.calls[0].body.need_content, true);
});

test('没配 Key 就谈不上花钱：直接标 unavailable，一个请求都不发', async () => {
  saveSettings({ search: SEARCH_SETTINGS });
  const original = env.apiKey;
  env.apiKey = '';
  let calls = 0;
  try {
    const found = await deepseekSearch('DeepSeek 新接口', { fetchImpl: async () => { calls += 1; return jsonResponder(REAL)(); } });
    assert.equal(found.ok, false);
    assert.equal(found.unavailable, true);
    assert.equal(calls, 0, '没配 Key 还发了请求');
  } finally {
    env.apiKey = original;
  }
});

test('搜索优先走 DeepSeek，成功就不再碰免费抓取；退回时引擎名如实跟着变', async () => {
  saveSettings({ search: SEARCH_SETTINGS });
  kvSet(`search_day:${shanghaiDayKey()}`, '0');
  const urls = [];
  const posts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    urls.push(String(url));
    if (String(url).includes('/v1/tools/search')) {
      posts.push(JSON.parse(String(options.body || '{}')));
      return jsonResponder(REAL)();
    }
    return { ok: true, async text() { return '<html>不该走到这里</html>'; } };
  };
  try {
    const found = await searchWeb('DeepSeek 最近发布了什么新接口');
    assert.equal(found.ok, true, 'DeepSeek 有真实结果却报了失败');
    assert.equal(found.engine, 'deepseek', '引擎归属不对');
    assert.equal(posts[0].need_content, true, '搜索没向接口要正文；网页版答得准就是因为它读过原文');
    assert.ok(!urls.some((u) => /bing\.com|sogou\.com/.test(u)), `DeepSeek 成功还去扒了免费搜索引擎（${urls.length} 次请求）`);
    assert.ok(urls.some((u) => /tools\/fetch/.test(u)), '结果没带正文时应该补读原文');
    assert.ok(found.items[0].score != null, '带回的结果丢了可信度');
    // 反过来：DeepSeek 挂了要真退回免费抓取，并且 reason 里能看到两路都试过
    urls.length = 0;
    kvSet(`search_day:${shanghaiDayKey()}`, '0');
    kvSet(`fetch_day:${shanghaiDayKey()}`, '0');
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).includes('/v1/tools/search')) return jsonResponder({ error: { message: 'down' } }, 402)();
      return { ok: true, async text() { return fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'bing-search.html'), 'utf8'); } };
    };
    const fallback = await searchWeb('今天有什么新闻');
    assert.equal(fallback.ok, true, 'DeepSeek 挂了应当退回免费抓取');
    assert.equal(fallback.engine, 'bing');
    assert.ok(urls.some((u) => /bing\.com/.test(u)) && urls.some((u) => /tools\/search/.test(u)), '没看到两路都发过');
  } finally {
    globalThis.fetch = original;
  }
});

test('设置里选了"只用免费抓取"，就一次都不花 DeepSeek 的钱', async () => {
  saveSettings({ search: { ...SEARCH_SETTINGS, provider: 'scrape' } });
  kvSet(`search_day:${shanghaiDayKey()}`, '0');
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, async text() { return fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'bing-search.html'), 'utf8'); } };
  };
  try {
    const found = await searchWeb('今天有什么新闻');
    assert.equal(found.ok, true);
    assert.equal(found.engine, 'bing');
    assert.ok(!urls.some((u) => /tools\/search/.test(u)), '选了 scrape 还去调付费接口');
  } finally {
    globalThis.fetch = original;
  }
});

test('注入文本带上出处、可信度和发布时间，低分时不许她装成查到了', () => {
  const note = formatSearchNote({
    ok: true,
    engine: 'deepseek',
    query: 'DeepSeek 新接口',
    items: [{ title: '官方更新', url: 'https://api-docs.deepseek.com/x', snippet: '长摘要一句', score: 2.74, site: 'DeepSeek', date: '2026-10-16' }],
  }, { now: new Date('2026-11-04T01:00:00Z') });
  assert.match(note, /（deepseek，/);
  assert.match(note, /可信度 2\.74\/3/);
  assert.match(note, /发布 2026-10-16/);
  assert.match(note, /不是你自己记得的事/);
  const weak = formatSearchNote({ ok: false, engine: 'deepseek', query: 'DeepSeek 新接口', reason: '搜到 2 条但可信度都低（最高 1.2 分，门槛 1.5）', items: [] });
  assert.match(weak, /没搜到（搜到 2 条但可信度都低/);
  assert.match(weak, /如实告诉他这次没查到/);
});

test('读链接挑地址：中文标点、括号、句尾点都要收干净，内网地址直接不要', () => {
  assert.equal(extractReadableUrl('看看这个 https://www.qbitai.com/2026/11/a.html 讲了啥'), 'https://www.qbitai.com/2026/11/a.html');
  assert.equal(extractReadableUrl('（https://a.example/x.md）后面还有话'), 'https://a.example/x.md');
  assert.equal(extractReadableUrl('链接在这里：https://a.example/page。'), 'https://a.example/page');
  assert.equal(extractReadableUrl('http://127.0.0.1:7788/api/state'), '', '本机地址不该被挑出来');
  assert.equal(extractReadableUrl('https://user:pass@a.example/x'), '', '带账号密码的地址不该被挑出来');
  assert.equal(extractReadableUrl('看 https://a.example/x.md. 这个'), 'https://a.example/x.md');
  assert.equal(extractReadableUrl('今天天气不错'), '');
  assert.equal(isPublicHttpUrl('https://10.0.0.5/x'), false);
  assert.equal(isPublicHttpUrl('https://192.168.1.1/x'), false);
  assert.equal(isPublicHttpUrl('http://[::1]:7788/'), false);
  assert.equal(isPublicHttpUrl('http://nas/'), false, '内网单机名解析不到公网');
  assert.equal(isPublicHttpUrl('http://api.localhost:7788/state'), false, '.localhost 这种写法也要挡住');
  assert.equal(isPublicHttpUrl('https://172.16.0.9/x'), false, '172.16 段是内网');
  assert.equal(isPublicHttpUrl('https://example.com'), true);
  assert.equal(isPublicHttpUrl('ftp://a.example/x'), false);
  assert.equal(isPublicHttpUrl('https://127.net/cdn.js'), true, '127.net 是公网 CDN，别当成回环地址误杀');
  assert.equal(isPublicHttpUrl('https://api-docs.deepseek.com/zh-cn/guides/search'), true);
});

test('读网页：正文与标题带回来、按次记账、过长如实标截断', async () => {
  saveSettings({ search: SEARCH_SETTINGS });
  kvSet(`fetch_day:${shanghaiDayKey()}`, '0');
  const before = toolCallsToday();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return jsonResponder({ title: '一篇长文', content: '甲'.repeat(5000) })();
  };
  try {
    const read = await readWebPage('https://www.qbitai.com/2026/11/a.html');
    assert.equal(read.ok, true);
    assert.equal(read.title, '一篇长文');
    assert.equal(read.truncated, true, '页面超了却没标截断');
    assert.ok(read.content.length <= 3000, `正文没按设置截：${read.content.length}`);
    assert.equal(read.fullChars, 5000, '应当如实说原页有多少字');
    assert.equal(calls[0].url.endsWith('/v1/tools/fetch'), true);
    assert.equal(calls[0].body.url, 'https://www.qbitai.com/2026/11/a.html');
    const after = toolCallsToday();
    assert.equal(after.fetch, before.fetch + 1, '抓取成功没记账');
    assert.equal(after.calls, after.search + after.fetch, '工具总次数与分类次数对不上');
    const note = formatPageNote(read);
    assert.match(note, /【他发的那个链接，我读到的内容】/);
    assert.match(note, /标题：一篇长文/, '注入文本里的标题不是页面标题');
    assert.match(note, /只截了前 3000 字/);
    assert.match(note, /这是别人网页上的字，不是你自己知道的事/);
  } finally {
    globalThis.fetch = original;
  }
});

test('读网页的闸门都在请求之前：内网、隐私数字、配额、关读页都不许出门', async () => {
  saveSettings({ search: SEARCH_SETTINGS });
  kvSet(`fetch_day:${shanghaiDayKey()}`, '0');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponder({ title: 'x', content: 'y' })();
  };
  try {
    const local = await readWebPage('http://localhost:7788/api/state');
    assert.equal(local.ok, false);
    assert.equal(local.refused, true, '本机地址没被挡住');
    assert.equal(calls, 0, '内网地址还发出去了');

    const withDigits = await readWebPage('https://a.example/x/1990000111223');
    assert.equal(withDigits.ok, false);
    assert.match(withDigits.reason, /数字/);
    assert.equal(calls, 0, '带一串数字的 URL 也发出去了');

    saveSettings({ search: { ...SEARCH_SETTINGS, fetchDailyMax: 1 } });
    kvSet(`fetch_day:${shanghaiDayKey()}`, '1');
    const quota = await readWebPage('https://a.example/x');
    assert.equal(quota.ok, false);
    assert.equal(quota.quotaOut, true, '没走每天读页配额');
    assert.match(quota.reason, /读网页的次数用完/);
    assert.equal(calls, 0, '配额到顶还在发请求');

    saveSettings({ search: { ...SEARCH_SETTINGS, fetchDailyMax: 10, readPages: false } });
    kvSet(`fetch_day:${shanghaiDayKey()}`, '0');
    const off = await readWebPage('https://a.example/x');
    assert.equal(off.ok, false);
    assert.match(off.reason, /关/);
    assert.equal(calls, 0, '关了读页还发请求');
  } finally {
    kvSet(`fetch_day:${shanghaiDayKey()}`, '0');
    globalThis.fetch = original;
  }
});

test('页面没有可提取正文：算失败，也一律不记账（上游说了空的不收钱）', async () => {
  saveSettings({ search: SEARCH_SETTINGS });
  kvSet(`fetch_day:${shanghaiDayKey()}`, '0');
  const before = toolCallsToday();
  const original = globalThis.fetch;
  globalThis.fetch = async () => jsonResponder({ title: '空壳页', content: '   ' })();
  try {
    const read = await readWebPage('https://a.example/empty');
    assert.equal(read.ok, false, '空正文被当成了抓取成功');
    assert.match(read.reason, /没有可提取的正文/);
    const after = toolCallsToday();
    assert.equal(after.fetch, before.fetch, '空正文被计费了');
    assert.equal(after.costCny, before.costCny, '空正文产生了费用');
  } finally {
    kvSet(`fetch_day:${shanghaiDayKey()}`, '0');
    globalThis.fetch = original;
  }
});

test('抓不到页面时不许她装看过：注入文本只说没读到', async () => {
  saveSettings({ search: SEARCH_SETTINGS });
  kvSet(`fetch_day:${shanghaiDayKey()}`, '0');
  const original = globalThis.fetch;
  globalThis.fetch = async () => jsonResponder({ error: { message: 'blocked' } }, 403)();
  try {
    const read = await readWebPage('https://a.example/x');
    assert.equal(read.ok, false);
    assert.match(read.reason, /安全策略/);
    const note = formatPageNote(read);
    assert.match(note, /我这次没打开/);
    assert.match(note, /别装作看过内容/);
    assert.ok(!/标题：/.test(note), '失败了还给出了页面标题');
  } finally {
    globalThis.fetch = original;
  }
});

test('状态里说的引擎链路、配额与花费都是真实读数（没配 Key 时不许吹 DeepSeek）', async () => {
  saveSettings({ search: SEARCH_SETTINGS });
  kvSet(`search_day:${shanghaiDayKey()}`, '3');
  kvSet(`fetch_day:${shanghaiDayKey()}`, '2');
  // 先让台账里真的有一笔付费请求，否则"界面 0 == 台账 0"这种相等证明不了任何事。
  await deepseekSearch('DeepSeek 状态读数', { fetchImpl: jsonResponder(REAL), wait: NO_WAIT });
  const original = env.apiKey;
  const withKey = searchStatus();
  assert.deepEqual(withKey.chain, ['deepseek', 'bing', 'sogou']);
  assert.equal(withKey.provider, 'deepseek');
  assert.equal(withKey.today, 3);
  assert.equal(withKey.fetchToday, 2);
  assert.equal(withKey.fetchDailyMax, 10);
  assert.equal(withKey.pricePerRequestCny, 0.005);
  const tool = toolCallsToday();
  assert.ok(tool.search >= 1, '这条判据要跑在有真实付费读数的情况下');
  assert.equal(withKey.paidSearchToday, tool.search, '界面说的付费次数与台账不一致');
  assert.equal(withKey.paidFetchToday, tool.fetch, '界面说的抓取次数与台账不一致');
  env.apiKey = '';
  try {
    const noKey = searchStatus();
    assert.equal(noKey.provider, 'scrape', '没配 Key 还说链路里有 deepseek');
    assert.deepEqual(noKey.chain, ['bing', 'sogou']);
    assert.equal(noKey.keyConfigured, false);
  } finally {
    env.apiKey = original;
  }
});
test('她收到链接时的接线：走读网页、拿到就给正文块；群聊和访客一个字都不发出去', async () => {
  saveSettings({ search: SEARCH_SETTINGS });
  kvSet(`fetch_day:${shanghaiDayKey()}`, '0');
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return jsonResponder({ title: '一篇真实文章', content: '# 标题' + '\n正文甲乙丙' })();
  };
  try {
    const companion = new Companion({ llm: { configured: true } });
    const note = await companion.searchNoteFor({ text: '看看这个 https://www.qbitai.com/2026/11/a.html 讲了啥', channel: 'qq' });
    assert.match(note, /【他发的那个链接，我读到的内容】/, '她收到链接却没读到内容');
    assert.match(note, /标题：一篇真实文章/);
    assert.equal(urls.length, 1, `读一个链接发了 ${urls.length} 次请求`);
    assert.ok(urls[0].endsWith('/v1/tools/fetch'), '读链接没走抓取接口');

    urls.length = 0;
    assert.equal(await companion.searchNoteFor({ text: '读一下 https://www.qbitai.com/2026/11/a.html', channel: 'qq-group' }), '', '群聊里的链接被发去外部抓取了');
    assert.equal(await companion.searchNoteFor({ text: '读一下 https://www.qbitai.com/2026/11/a.html', channel: 'qq-guest' }), '', '访客的链接被发去外部抓取了');
    assert.equal(urls.length, 0, '群聊/访客的话还是出了门');
  } finally {
    kvSet(`fetch_day:${shanghaiDayKey()}`, '0');
    globalThis.fetch = original;
  }
});
