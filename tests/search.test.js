// 联网搜索的判据。全部离线跑（fetch 被替身接管），不靠真网络也能钉住行为。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closeDb, kvSet, kvSetJson, addMessage, getActiveSession, getMessagesForPrompt } from '../src/db.js';
import { saveSettings, loadSettings } from '../src/config.js';
import { shanghaiDayKey } from '../src/util.js';
import { Companion } from '../src/chat.js';
import { buildChatPayload } from '../src/prompt.js';
import { annotateSources, backfillDates, buildQuery, dropDefinitionNoise, formatSearchNote, needsSearch, parseBing, parsePublishedDate, rankSearchItems, searchWeb, resolveSearchQuery, informativeQuery } from '../src/search.js';

test.after(closeDb);
// 搜索缓存会跨用例串味儿：每个用例开始前清空，判据才是在看这次请求。
beforeEach(() => { kvSetJson('search:cache', []); });

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
    // 11-10 QQ 截图原话：句尾落在"了"上也要认出是在问新鲜事。
    ['gpt和claude是不是出最新模型了', true],
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
    const cachedAgain = await searchWeb('最新手机价格');
    assert.equal(cachedAgain.cached, true, '配额用完后，刚查过的问题应当还能从缓存答');
    const out = await searchWeb('最新平板价格');
    assert.equal(out.ok, false);
    assert.equal(out.quotaOut, true, '没走配额闸门');
    assert.match(out.reason, /次数用完/);
    const before = calls;
    await searchWeb('最新平板价格');
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

// —— 11-10 QQ 截图翻车回归：搜"可以"/"给"的词典页、没搜却编"翻出来的都是…" ——

test('空壳残句不算查询词：可以/给我看/嗯 都不许发去搜索引擎', () => {
  for (const shell of ['可以', '给我看', '嗯', '好的吧', '可以，你联网检索吧', '搜索给我看']) {
    assert.equal(informativeQuery(shell), '', `「${shell}」被当成了查询词`);
  }
  assert.equal(informativeQuery('可以，查一下上海房价'), '上海房价');
  assert.equal(informativeQuery('搜索给我看 gpt和claude是不是出最新模型了'), 'gpt和claude是不是出最新模型了');
});

test('答应去搜时接住上一轮的问题：搜的是他问的事，不是"可以"', () => {
  const topic = 'gpt和claude是不是出最新模型了';
  for (const confirm of ['可以，你联网检索吧，有最新的ai咨询吗', '搜索给我看', '嗯，去查吧']) {
    const query = resolveSearchQuery(confirm, [topic]);
    assert.ok(query.includes('gpt') && query.includes('claude') && query.includes('最新'), `「${confirm}」没接住主题：${query}`);
    assert.ok(!/^(可以|给)/.test(query), `「${confirm}」摘出了空壳词：${query}`);
  }
  assert.ok(resolveSearchQuery('搜一下', [topic]).includes('gpt'), '只说了"搜一下"也要接上一轮的主题');
  assert.equal(resolveSearchQuery('搜索给我看', ['想你了', '晚安']), '', '上一轮是情绪话时不该硬接');
  assert.equal(resolveSearchQuery('查一下上海房价', [topic]), '上海房价', '自己带主题时不接旧话题');
});

test('端到端：他说"可以，你联网检索吧"，发出去的查询词是他上一轮问的事', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, text: async () => BING_FIXTURE };
  };
  try {
    saveSettings({ search: { enabled: true, provider: 'scrape', dailyMax: 20, maxResults: 5, timeoutSeconds: 8 } });
    const session = getActiveSession();
    addMessage({ sessionId: session.id, role: 'user', content: 'gpt和claude是不是出最新模型了', channel: 'qq' });
    addMessage({ sessionId: session.id, role: 'assistant', content: '要我联网看一眼吗？你点个头，我就去翻。', channel: 'qq' });
    const companion = new Companion({ llm: { configured: true } });
    const note = await companion.searchNoteFor({ text: '可以，你联网检索吧，有最新的ai咨询吗', channel: 'qq' });
    assert.match(note, /【刚刚联网搜到的】/, '接住主题后应该真搜');
    assert.ok(seen.length >= 1, '没有发出搜索请求');
    const sent = decodeURIComponent(seen.join(' '));
    assert.ok(sent.includes('gpt') && sent.includes('claude'), `发出去的查询词不对：${sent}`);
    assert.ok(!/[?&]q=(可以|给)[&%]/.test(seen.join(' ')), '把空壳词发出去了');
  } finally {
    globalThis.fetch = original;
  }
});

test('让他去搜但接不住主题时：不搜、注入"问他要查什么"，绝不发空壳词', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, text: async () => BING_FIXTURE }; };
  try {
    saveSettings({ search: { enabled: true, provider: 'scrape', dailyMax: 20 } });
    const companion = new Companion({ llm: { configured: true } });
    const note = await companion.searchNoteFor({ text: '搜索给我看', channel: 'qq', sessionId: 'no-such-session' });
    assert.match(note, /这次没搜/);
    assert.match(note, /问他要查哪件事/);
    assert.equal(calls, 0, '没主题还把残句发出去了');
  } finally {
    globalThis.fetch = original;
  }
});

test('搜索说明跟着消息落库，下一轮历史里看得见真实结果', () => {
  const session = getActiveSession();
  const note = formatSearchNote({ ok: true, engine: 'bing', query: 'gpt claude 最新模型', items: [{ title: '甲', url: 'https://a.example/x', snippet: '乙' }] });
  const prep = new Companion({ llm: { configured: true } }).prepare({ text: '可以，你联网检索吧', channel: 'qq', extraContext: note });
  const stored = getMessagesForPrompt(session.id, 4).find((m) => m.id === prep.userMessage.id);
  assert.ok(stored.meta?.searchNote?.includes('【刚刚联网搜到的】'), '搜索说明没落库，下一轮她又会凭印象编');
  const payload = buildChatPayload({
    settings: loadSettings(),
    mood: { label: '平静', valence: 0, energy: 0.5, affection: 20, reason: '' },
    block: { core: [], long: [], mid: [], summary: '', handover: '', innerThoughts: [] },
    history: [...getMessagesForPrompt(session.id, 4), { role: 'user', content: '那claude呢', meta: {} }],
    maxContextTokens: 100000,
    channel: 'qq',
  });
  const joined = payload.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  assert.ok(joined.includes('https://a.example/x'), '下一轮上下文里没有真实来源，模型只能编');
});

// —— 11-10 晚：QQ 里被网页版 DeepSeek 比下去的那次 ——
// 根因三条：没要正文、追问不触发搜索、说明里没有"按日期/来源"的硬要求。

test('搜索会向接口要正文；说明带上正文节选、来源日期和引用纪律', () => {
  const rich = formatSearchNote({
    ok: true, engine: 'deepseek', query: 'gpt claude 最新模型',
    items: [
      { title: 'Claude Fable 5.2 登场', url: 'https://a.example/news', content: 'IT之家 11 月 10 日消息，Anthropic 今天发布 Claude Fable 5.2。', date: '2026-11-10T16:00:00+00:00', score: 2.33, site: 'IT之家' },
      { title: '旧闻', url: 'https://a.example/old', snippet: '只有摘要的一条', date: '2026-11-01' },
    ],
  });
  assert.match(rich, /正文节选：IT之家 11 月 10 日消息/);
  assert.match(rich, /发布 2026-11-10/, '日期要只留到天');
  assert.match(rich, /只有摘要的一条/);
  assert.match(rich, /正文节选里没出现的模型名、日期、数字，不许写进回答/);
  assert.match(rich, /按日期从新到旧/);
  assert.match(rich, /标签页、列表页、论坛帖不算"发布"的凭据/);
  assert.match(rich, /来源说法不一致/);
  assert.match(rich, /最多发 1-2 个最靠谱的原文/);
});

test('搜索没带正文时补读前两页：正文进说明，最多两页，读不到就按摘要走', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).includes('/v1/tools/fetch')) {
      const target = JSON.parse(String(options.body || '{}')).url;
      return { ok: true, status: 200, text: async () => JSON.stringify({ title: '正文页', content: `正文里写到：Fable 5.2 于 11 月 10 日发布。来源 ${target}` }) };
    }
    return { ok: true, text: async () => BING_FIXTURE };
  };
  try {
    saveSettings({ search: { enabled: true, provider: 'scrape', dailyMax: 20, readPages: true, fetchDailyMax: 10 } });
    kvSet(`search_day:${shanghaiDayKey()}`, '0');
    kvSet(`fetch_day:${shanghaiDayKey()}`, '0');
    const found = await searchWeb('最新发布的模型');
    assert.equal(found.ok, true);
    const fetched = calls.filter((u) => u.includes('/v1/tools/fetch'));
    assert.ok(fetched.length >= 1, '没正文却没去补读原文');
    assert.ok(fetched.length <= 2, `补读超过了前两页：${fetched.length}`);
    assert.ok(found.items.some((item) => item.content), '补读到的正文没挂回结果');
    assert.match(formatSearchNote(found), /正文节选：正文里写到/);
  } finally { globalThis.fetch = original; }
});

test('追问接上一轮搜索：问完 GPT 再问 Claude 也要真去查，闲聊不查', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(decodeURIComponent(String(url)));
    return { ok: true, text: async () => BING_FIXTURE };
  };
  try {
    saveSettings({ search: { enabled: true, provider: 'scrape', dailyMax: 20, readPages: false } });
    kvSet(`search_day:${shanghaiDayKey()}`, '0');
    const session = getActiveSession();
    addMessage({ sessionId: session.id, role: 'user', content: 'gpt和claude出最新模型了吗', channel: 'qq', meta: { searchQuery: 'gpt和claude出最新模型了吗' } });
    addMessage({ sessionId: session.id, role: 'assistant', content: '我查到了一些…', channel: 'qq' });
    const companion = new Companion({ llm: { configured: true } });
    const note = await companion.searchNoteFor({ text: 'Claude呢', channel: 'qq' });
    assert.match(note, /【刚刚联网搜到的】/, '追问没有触发搜索');
    const sent = seen.join(' ');
    assert.match(sent, /claude/i, '追问没把 Claude 带进查询词');
    assert.match(sent, /gpt/i, '追问没接上一轮的主题');
    seen.length = 0;
    assert.equal(await companion.searchNoteFor({ text: '晚安', channel: 'qq' }), '', '闲聊被当成追问去搜了');
    assert.equal(seen.length, 0);
    // 旧消息只留了整段搜索说明（没有单独存查询词）也要能接上。
    // 先清缓存：上一次调用已经把同一查询写进 20 分钟缓存，这里要验证的是查询词拼装。
    kvSetJson('search:cache', []);
    addMessage({ sessionId: session.id, role: 'user', content: 'gpt和claude出最新模型了吗', channel: 'qq', meta: { searchNote: '【刚刚联网搜到的】（bing，11/10，查的是「gpt和claude出最新模型了吗」）\n1. 甲' } });
    seen.length = 0;
    const legacy = await companion.searchNoteFor({ text: 'Claude呢', channel: 'qq' });
    assert.match(legacy, /【刚刚联网搜到的】/, '旧消息的搜索说明没被用来接主题');
    assert.match(seen.join(' '), /claude/i);
  } finally { globalThis.fetch = original; }
});

test('搜索说明落库时同时记下查询词，下一轮追问才能接上', () => {
  const session = getActiveSession();
  const note = formatSearchNote({ ok: true, engine: 'bing', query: 'gpt claude 最新模型', items: [{ title: '甲', url: 'https://a.example/x', snippet: '乙' }] });
  const prep = new Companion({ llm: { configured: true } }).prepare({ text: '查一下最新模型', channel: 'qq', extraContext: note });
  const stored = getMessagesForPrompt(session.id, 4).find((m) => m.id === prep.userMessage.id);
  assert.equal(stored.meta?.searchQuery, 'gpt claude 最新模型', '查询词没落库，追问时接不上');
});

// —— 11-10 晚：排序/兜底日期/缓存/日期闸门四件小事 ——

test('排序：同一天里官方来源优先，列表/标签页降权；问最新时日期优先', () => {
  const items = annotateSources([
    { title: '聚合转述', url: 'https://news.example.com/a', score: 2.2, date: '2026-11-09' },
    { title: '官方公告', url: 'https://openai.com/index/x', score: 1.9, date: '2026-11-09' },
    { title: '标签页', url: 'https://simonwillison.net/tags/gpt/', score: 2.5, date: '2026-11-09' },
  ]);
  const ranked = rankSearchItems(items, 'gpt 最新模型');
  assert.equal(ranked[0].title, '官方公告', '官方来源没置顶');
  assert.equal(ranked.at(-1).title, '标签页', '标签页没降权');
  const withNewer = annotateSources([
    { title: '官方旧闻', url: 'https://anthropic.com/news', score: 2.4, date: '2026-11-08' },
    { title: '今天的新报道', url: 'https://news.example.com/b', score: 1.8, date: '2026-11-10' },
  ]);
  assert.equal(rankSearchItems(withNewer, '最新模型')[0].title, '今天的新报道', '问最新没按日期排');
  assert.equal(rankSearchItems(withNewer, '模型安全')[0].title, '官方旧闻', '非新鲜问题应优先官方');
});

test('兜底日期解析：绝对日期、月日、相对时间都能落到天，瞎写的返回空', () => {
  const now = new Date('2026-11-10T12:00:00+08:00');
  assert.equal(parsePublishedDate('发布于 2026-11-09', now), '2026-11-09');
  assert.equal(parsePublishedDate('2026年11月9日 消息', now), '2026-11-09');
  assert.equal(parsePublishedDate('11月9日 14:03 来源', now), '2026-11-09');
  assert.equal(parsePublishedDate('11月9日', new Date('2026-01-05T12:00:00+08:00')), '2025-11-09', '跨年时未来日期应回退一年');
  assert.equal(parsePublishedDate('3 小时前', now), '2026-11-10');
  assert.equal(parsePublishedDate('2 天前', now), '2026-11-08');
  assert.equal(parsePublishedDate('昨天', now), '2026-11-09');
  assert.equal(parsePublishedDate('没有时间信息', now), '');
  const filled = backfillDates([{ title: 't', snippet: '5 小时前 新闻', url: 'https://a.example/x' }], now);
  assert.equal(filled[0].date, '2026-11-10', '兜底结果没回填日期');
});

test('同一问题 20 分钟内命中缓存：不再发请求、不重复扣费，说明里注明是缓存', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/v1/tools/search')) {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [
        { title: '缓存专用结果', url: 'https://a.example/cache', summary: '摘要', content: '正文内容', rerank_score: 2.1, date: '2026-11-10', site_name: 'test' },
      ] }) };
    }
    throw new Error('不该有第二次请求');
  };
  try {
    saveSettings({ search: { enabled: true, provider: 'deepseek', dailyMax: 20, readPages: true, fetchDailyMax: 10 } });
    kvSet(`search_day:${shanghaiDayKey()}`, '0');
    const first = await searchWeb('缓存测试专用查询');
    const second = await searchWeb('缓存测试专用查询');
    assert.equal(first.ok, true);
    assert.equal(calls, 1, `同一问题发了 ${calls} 次请求`);
    assert.equal(second.cached, true);
    assert.match(formatSearchNote(second), /缓存的结果/);
  } finally { globalThis.fetch = original; }
});

test('日期形状的数字串不算隐私：20261110 放行，会员号照样挡', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, text: async () => BING_FIXTURE }; };
  try {
    saveSettings({ search: { enabled: true, provider: 'scrape', dailyMax: 20, readPages: false } });
    kvSet(`search_day:${shanghaiDayKey()}`, '0');
    const byDate = await searchWeb('截至20261110最新的模型');
    assert.equal(byDate.ok, true, '日期形状的数字串被当成了隐私');
    assert.ok(calls >= 1);
    const byAccount = await searchWeb('查一下 1990000111223 这个号');
    assert.equal(byAccount.privacyBlocked, true, '13 位号码没被挡');
  } finally { globalThis.fetch = original; }
});
