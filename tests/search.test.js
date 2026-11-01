// 联网搜索的判据。全部离线跑（fetch 被替身接管），不靠真网络也能钉住行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closeDb, kvSet } from '../src/db.js';
import { saveSettings } from '../src/config.js';
import { shanghaiDayKey } from '../src/util.js';
import { Companion } from '../src/chat.js';
import { buildQuery, dropDefinitionNoise, formatSearchNote, needsSearch, parseBing, searchWeb } from '../src/search.js';

test.after(closeDb);

const BING_FIXTURE = fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'bing-search.html'), 'utf8');

test('触发判断：要现查的才搜，情绪话和私密回忆不搜', () => {
  const cases = [
    ['DeepSeek 最新发布的是什么模型', true],
    ['今天天气怎么样', true],
    ['搜一下 上海 房价', true],
    ['帮我查一下高铁晚点没有', true],
    ['现在美元汇率多少钱', true],
    ['我这边没网是什么意思', false],
    ['想你了', false],
    ['晚安', false],
    ['嗯', false],
    ['你还记得我上次说的三元桥那家店吗', false],
    // 「最近发布了什么新东西」这种问法当时漏了：她只能说不知道，用户截图指的就是这句。
    ['DeepSeek 最近发布了什么新东西？', true],
    ['最近有什么好看的剧吗', true],
    ['这个 app 最新版本是啥', true],
    ['苹果最新的手机是哪款', true],
    ['今天有什么新闻', true],
    // 疑问词出现在句子中间不算在要资料；问的是她本人也不算。
    ['最近好累啊什么都不想做', false],
    ['你最近有没有好好吃饭', false],
    ['今天心情不好', false],
    ['最近天气好热啊', false],
    ['我刚下班，好饿', false],
  ];
  for (const [text, want] of cases) {
    assert.equal(needsSearch(text), want, `「${text}」判错了`);
  }
});

test('摘查询词：把口语壳剥掉，长说法先剥（"帮我查一下"不能剩个"一下"）', () => {
  assert.equal(buildQuery('帮我查一下 DeepSeek 最新发布的是什么模型啊'), 'DeepSeek 最新发布的 模型');
  assert.equal(buildQuery('搜一下：上海 房价'), '上海 房价');
  assert.equal(buildQuery('今天天气怎么样？'), '今天天气');
  assert.equal(buildQuery('那个 请问 小米股价多少').startsWith('小米股价'), true);
  // 实测翻过车：整句问话直接丢给 Bing，它去解释「最近」这个词，还回了首李圣杰的歌。
  assert.equal(buildQuery('最近有什么新发布的模型？'), '最近 新发布的模型');
  assert.ok(!/有什么|有没有|是什么/.test(buildQuery('最近有什么新发布的模型？')), '问话的壳还在查询词里');
  assert.equal(buildQuery('这个 app 最新版本是啥'), '这个 app 最新版本');
});

test('Bing 结果解析：标题/网址/摘要齐全，引擎自己的链接不算结果', () => {
  const items = parseBing(BING_FIXTURE);
  assert.equal(items.length, 2, `解析出 ${items.length} 条，应为 2 条`);
  assert.match(items[0].title, /DeepSeek/);
  assert.equal(items[0].url, 'https://www.53ai.com/news/large-language-model/2026103145736.html');
  assert.match(items[0].snippet, /Super-agent/);
  assert.ok(!items.some((i) => /bing\.com|microsoft/.test(i.url)), '引擎内链被当成结果了');
  assert.ok(items[1].snippet.includes('1 天前'), '时效信息要留住（她要知道这不是刚发生的）');
});

test('词典页和歌页不算资料：单字词搜出来的噪音要丢掉，正主不许误伤', () => {
  const noise = [
    { title: '最近（汉语词语）_百度百科' },
    { title: '最近 - 李圣杰 - 单曲 - 网易云音乐' },
    { title: '李圣杰的《最近》 歌词 - 百度知道' },
    { title: '《新》的拼音,新字的意思、组词、部首' },
    { title: '新 xīn - 汉典' },
  ];
  const keep = [
    { title: 'DeepSeek | API Platform' },
    { title: '上海天气预报,上海7天天气预报' },
    { title: '今日天气-上海市气象局' },
  ];
  assert.deepEqual(dropDefinitionNoise(noise), [], '词典/歌曲页没被过滤掉');
  assert.equal(dropDefinitionNoise([...noise, ...keep]).length, 3, '正经结果被误伤了');
  assert.deepEqual(dropDefinitionNoise([]), []);
});

test('整页都是词典噪音时：报"没搜到"，不许把"最近"的词义当成资料喂给她', async () => {
  saveSettings({ search: { enabled: true, dailyMax: 20, maxResults: 5, timeoutSeconds: 8 } });
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => '<ul>' + ['最近（汉语词语）_百度百科', '最近 - 李圣杰 - 单曲 - 网易云音乐']
      .map((t) => `<li class="b_algo"><h2><a href="https://example.com/${encodeURIComponent(t)}">${t}</a></h2><p>释义</p></li>`)
      .join('') + '</ul>',
  });
  try {
    const found = await searchWeb('最近有什么新发布的模型');
    assert.equal(found.ok, false, '全是词典噪音却报了成功');
    assert.equal(found.items.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('隐私闸门：查询里有一串数字就不往搜索引擎发', async () => {
  saveSettings({ search: { enabled: true, dailyMax: 20, maxResults: 5, timeoutSeconds: 8 } });
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('不该发请求');
  };
  try {
    const blocked = await searchWeb('查一下 1990000111223 这个号');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.privacyBlocked, true, '数字串没被挡下');
    assert.match(blocked.reason, /数字/);
    assert.equal(calls, 0, '闸门挡下了却还是发了请求');
  } finally {
    globalThis.fetch = original;
  }
});

test('网络挂了、被验证码挡了、返回 0 条：都不许抛，且如实给出原因', async () => {
  saveSettings({ search: { enabled: true, dailyMax: 20, maxResults: 5, timeoutSeconds: 8 } });
  const original = globalThis.fetch;
  const scenarios = [
    { name: '断网', fetch: async () => { throw new Error('fetch failed'); }, want: /没解析出结果|failed|没有可用引擎|验证码/ },
    { name: '验证码页', fetch: async () => ({ ok: true, text: async () => '<html>请完成下方验证后继续操作 captcha</html>' }), want: /验证/ },
    { name: '空结果', fetch: async () => ({ ok: true, text: async () => '<html><body>没有结果</body></html>' }), want: /没解析出结果/ },
    { name: 'HTTP 403', fetch: async () => ({ ok: false, status: 403, text: async () => '' }), want: /HTTP 403/ },
  ];
  try {
    for (const scenario of scenarios) {
      globalThis.fetch = scenario.fetch;
      const result = await searchWeb('今天有什么新闻');
      assert.equal(result.ok, false, `${scenario.name}：不该报成功`);
      assert.ok(Array.isArray(result.items) && result.items.length === 0, `${scenario.name}：不该有假结果`);
      assert.match(String(result.reason), scenario.want, `${scenario.name}：原因不对（${result.reason}）`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('配额与开关：到顶不再发请求；关掉时明说是设置里关的', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, text: async () => BING_FIXTURE };
  };
  try {
    saveSettings({ search: { enabled: true, dailyMax: 1, maxResults: 5, timeoutSeconds: 8 } });
    const today = shanghaiDayKey();
    kvSet(`search_day:${today}`, '0');
    const first = await searchWeb('最新手机价格');
    assert.equal(first.ok, true, '第一次应当能搜');
    kvSet(`search_day:${today}`, '5');
    const out = await searchWeb('最新手机价格');
    assert.equal(out.ok, false);
    assert.equal(out.quotaOut, true, '没走配额闸门');
    assert.match(out.reason, /次数用完/);
    const before = calls;
    await searchWeb('最新手机价格');
    assert.equal(calls, before, '配额到顶后还在发请求');

    saveSettings({ search: { enabled: false, dailyMax: 20, maxResults: 5, timeoutSeconds: 8 } });
    const off = await searchWeb('最新手机价格');
    assert.equal(off.skipped, true, '关闭时应当直接跳过');
    assert.match(off.reason, /设置里关/);
  } finally {
    globalThis.fetch = original;
  }
});

test('注入文本：成功时报出处和时效，失败时只许说没查到，不许替她编借口', () => {
  const okNote = formatSearchNote({ ok: true, engine: 'bing', query: 'DeepSeek 最新发布 模型', items: [{ title: '甲', url: 'https://a.example/x', snippet: '1 天前 乙', source: 'bing' }] }, { now: new Date('2026-11-01T09:00:00Z') });
  assert.match(okNote, /【刚刚联网搜到的】/);
  assert.match(okNote, /来源 https:\/\/a\.example\/x/);
  assert.match(okNote, /不是你自己记得的事/);
  assert.match(okNote, /别讲成刚发生/);

  const badNote = formatSearchNote({ ok: false, reason: 'bing:超时', query: '今天的新闻' });
  assert.match(badNote, /没搜到（bing:超时）/);
  assert.match(badNote, /如实告诉他这次没查到/);
  assert.ok(!/【刚刚联网搜到的】/.test(badNote), '没搜到却给了结果块');
});

test('群聊和访客的话不发去外网；不需要查的话也不发', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, text: async () => BING_FIXTURE };
  };
  try {
    saveSettings({ search: { enabled: true, dailyMax: 20, maxResults: 5, timeoutSeconds: 8 } });
    const companion = new Companion({ llm: { configured: true } });
    assert.equal(await companion.searchNoteFor({ text: '最新模型是什么', channel: 'qq-group' }), '', '群聊的话被送去搜索了');
    assert.equal(await companion.searchNoteFor({ text: '最新模型是什么', channel: 'qq-guest' }), '', '访客的话被送去搜索了');
    assert.equal(calls, 0);
    const quiet = await companion.searchNoteFor({ text: '想你了', channel: 'qq' });
    assert.equal(quiet, '', '情绪话触发了搜索');
    assert.equal(calls, 0);
    const note = await companion.searchNoteFor({ text: 'DeepSeek 最新发布的是什么模型', channel: 'qq' });
    assert.match(note, /【刚刚联网搜到的】/, '该搜的时候没搜');
    assert.ok(calls >= 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('提示词里必须写明"你能上网查"，并且不许她编出查的过程', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'prompt.js'), 'utf8').split(String.fromCharCode(13)).join(String.fromCharCode(10));
  assert.match(source, /你能上网查东西/);
  assert.match(source, /【刚刚联网搜到的】/);
  assert.match(source, /【联网搜索的结果】/, '搜索失败时的说明块没写进规则，她会以为自己查过');
  assert.match(source, /两块都没有/, '没搜的时候要把搜索这回事当没发生');
  assert.match(source, /装作查/, '不许凭感觉报天气/价格/版本号');
  assert.ok(!/以后不要说“我这边没网”/.test(source), '旧的补丁式禁令还在（已被更准的"没结果就别提"取代）');
  assert.match(source, /一次只说一遍/, '重复解释的约束没写进提示词');
});
