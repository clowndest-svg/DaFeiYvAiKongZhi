// 联网查资料：她以前只能靠记忆里那点东西，被问"最新"的事只能说不知道（有时还会说成"我这边没网"）。
// 现在两条路：DeepSeek 官方 Search/Fetch 接口打头（有可信度分数、有正文，按次收钱），
// 扒公开搜索引擎的网页结果兜底（不要 key、不花钱，但脆）。
//
// 四条硬规矩：
// 1) 查询词里像有主人隐私（账号、住址、真名、公司）就不发出去，宁可说搜不了；
// 2) 搜到的是外部信息，不是她的记忆，注入时必须带着"怎么用、怎么报出处"的说明；
// 3) 搜不到/被墙/超时都如实报原因，界面显示"未测"而不是拿旧数据冒充；
// 4) 花钱的那条路要走闸门：每天次数封顶、按次记账，失败与空结果不记账。

import { env, loadSettings } from './config.js';
import { costBlocked } from './budget.js';
import { addEvent, kvGet, kvSet, toolCallsToday } from './db.js';
import { logger } from './logger.js';
import { privacyProblems } from './privacy.js';
import { deepseekFetch, deepseekSearch, isPublicHttpUrl, PRICE_PER_REQUEST_CNY } from './search-deepseek.js';
import { shanghaiDayKey } from './util.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_BYTES = 2 * 1024 * 1024;

// 明显在要"新鲜信息"的说法。刻意做窄：日常情绪话不该触发外网请求。
const FRESH = /(最新|最近|这几天|这两天|今天|现在|刚刚|刚才|新闻|发布|上线|更新|出了什么|发生了什么|比分|赛果|战绩|股价|行情|汇率|天气|价格|多少钱|版本号|版本|榜单|排名|什么时候)/;
const ASK = /(搜|查|看看|知道吗|听说|有什么|是什么|有没有|多少|几点|怎样|怎么样)/;
export const EXPLICIT_SEARCH = /^\s*[\/／]?\s*(搜一下|搜索|搜|查一下|查查|查|帮我查|上网查|上网搜|google)/i;
const EXPLICIT = EXPLICIT_SEARCH;
// 情绪/日常话不搜：别把"想你了"发去搜索引擎。
// 光有 ASK 词表会漏掉「最近发布了什么新东西」这种说法，所以再认"疑问句形状"：
// 带问号，或者句尾落在疑问词上。只判断句尾是因为「最近好累啊什么都不想做」中间也有"什么"，
// 但那是陈述自己的状态，不该被拖去上网搜。
const QTAIL = /(什么|啥|吗|呢|多少|几点|多久|哪\S{0,2}|怎么|怎样|咋|是否|如何|有没有|是不是|能不能|几个)(了|啊|呀|吧|嘛)?[!！。.,，、;；~～\s]*$/;
// 问的是她本人（"你最近有没有好好吃饭"），是要陪伴不是要资料。
const ABOUT_HER = /(你|您|你们|小知)[^我他她]{0,4}(有没有|是不是|知不知道|记不记得|想不想|要不要|爱不爱|在不在)/;
const PERSONAL = /(想你了|想你|抱抱|亲亲|晚安|早安|爱你|生气|难过|委屈|辛苦了|在吗|在干嘛|吃了吗|嗯+|哦+|哈哈+|嘻嘻)/;
// 他说"可以，你联网检索吧"/"搜索给我看"时，这一句本身没有主题：要接住上一轮他问的事，
// 而不是把"可以""给我看"这种残句发去搜索引擎（真搜出过"可以"的词典页和"给"的笔画页）。
const SEARCH_CONFIRM = /(联网|上网|搜索|搜一|搜吧|搜给|查吧|查给|检索|去查|去搜|帮我查|帮我搜)/;
export function isSearchConfirmation(text) { return SEARCH_CONFIRM.test(String(text || '')); }
const CONFIRM_SHELL = /^(可以|好的?|行|嗯+|对|是的?|没问题|当然|麻烦|请|那就|那你|你就|你|联网|上网|检索|搜索|吧|啊|呀|呢|哦|噢|了|吗|嘛|给我|我|看|一下|试试|去|来|呗|哈|[,，。.!！?？~～\s])+$/;
// 确认前缀：不含单字"搜/查/搜索"，免得把"搜索引擎哪个好"这种正题咬掉。
const CONFIRM_PREFIX = /^(搜索给我看|搜给我看|查给我看|搜索看看|搜看看|给我看看|给我看|看一下|看一看|看看|看下|联网检索吧|联网检索|联网搜吧|联网查吧|联网看看吧|联网看看|联网看|上网看看|上网查|上网搜|去搜索|去查|去搜|搜吧|查吧|那就|可以|好的?|行|嗯+|对|是的?|没问题|当然|麻烦|请|你|一下|吧|啊|呀|呢|哦|了|吗|嘛|[,，。.!！?？~～\s])+/;
// 确认句里又点名了新主题（"可以，帮我搜一下小米股价"）：这时听新主题，不接旧话题。
const TOPIC_COMMAND = /(帮我查|帮我搜|替我查|查一下|搜一下|查查|搜一搜|查下|搜下)/;
const CARRY_SHELLS = /^(搜索给我看|搜给我看|查给我看|搜索看看|搜看看|给我看|给我看看|看一下|看一看|看看|看下|检索吧|联网检索吧|联网检索|联网搜吧|联网查吧|联网看看吧|联网看看|联网看|上网看看|上网查|上网搜|去搜索|去查|去搜|搜吧|查吧|搜索|搜|查|你|帮我|那就|可以|好的?|行|嗯+|麻烦|请|吧|啊|呀|呢|哦|了|吗|嘛|[,，。.!！?？~～\s])+/;

function clean(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&ensp;|&#8194;|&nbsp;/g, ' ')
    .replace(/&#0?183;|·/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&#0?34;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function internalLink(url) {
  return /^(https?:)?\/\/([a-z0-9-]+\.)?(bing|microsoft|sogou|so)\.(com|cn)/i.test(String(url || ''));
}

export function parseBing(html) {
  const out = [];
  for (const chunk of String(html || '').split(/<li class="b_algo"/).slice(1)) {
    const seg = chunk.slice(0, 2400);
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(seg);
    if (!link) continue;
    const url = clean(link[1].replace(/&amp;/g, '&'));
    if (!/^https?:\/\//i.test(url) || internalLink(url)) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(seg);
    out.push({
      title: clean(link[2]).slice(0, 120),
      url,
      snippet: snippet ? clean(snippet[1]).slice(0, 260) : '',
      source: 'bing',
    });
  }
  return out;
}

export function parseSogou(html) {
  const out = [];
  for (const chunk of String(html || '').split(/<h3 class="vr-title/).slice(1)) {
    const seg = chunk.slice(0, 1600);
    const link = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(seg);
    if (!link) continue;
    const url = clean(link[1].replace(/&amp;/g, '&'));
    if (!/^https?:\/\//i.test(url)) continue;
    const snippet = /class="space-txt[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(chunk.slice(0, 3000)) || /<p[^>]*>([\s\S]*?)<\/p>/.exec(chunk.slice(0, 3000));
    out.push({
      title: clean(link[2]).slice(0, 120),
      url,
      snippet: snippet ? clean(snippet[1]).slice(0, 260) : '',
      source: 'sogou',
    });
  }
  return out;
}

const ENGINES = [
  { name: 'bing', build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-hans`, parse: parseBing },
  { name: 'sogou', build: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`, parse: parseSogou },
];

export function needsSearch(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length < 4) return false;
  if (!EXPLICIT.test(value) && (PERSONAL.test(value) || ABOUT_HER.test(value))) return false;
  if (EXPLICIT.test(value)) return true;
  // "X是不是Y"这种问法疑问词在句中不在句尾，QTAIL 够不着；句首是"你"的已被 ABOUT_HER 挡掉。
  return FRESH.test(value) && (ASK.test(value) || QTAIL.test(value) || /[?？]/.test(value) || /(是不是|能不能|会不会)/.test(value));
}

// 把口语摘成查询词：去掉称呼、语气词和"帮我"这类壳，只留信息部分。
export function stripQueryShells(text) {
  let value = String(text || '').replace(/\s+/g, ' ').trim();
  // 长说法必须排在短说法前面，否则「帮我查一下」会被"帮我查"先咬掉，剩个"一下"留在查询词里。
  const shells = /^(帮我查一下|帮我搜一下|替我查一下|上网查一下|上网搜一下|查一下|搜一下|搜一搜|搜索|查查|上网查|上网搜|帮我查|帮我搜|google|查|搜|那个|就是|请问|你们|你|小知|宝贝|宝宝)[:：,，\s]*/i;
  // 一层层剥：^ 锚定的正则带 /g 也不会回头重扫，剥完"那个"还剩"请问"。
  let stripped = value;
  let previous = '';
  while (stripped !== previous) {
    previous = stripped;
    stripped = stripped.replace(shells, '').trim();
  }
  value = stripped;
  // 句中间的"有什么/是什么"是问话的壳：留着，搜索引擎会去解释"最近"这个词（真搜出过李圣杰的歌）。
  value = value.replace(/(有什么|有没有|有哪些|是什么东西|是什么|是啥|是干什么)/g, ' ');
  value = value.replace(/\s{2,}/g, ' ').trim();
  value = value.replace(/[?？!！。~～]+$/g, '');
  value = value.replace(/(啊|呀|呢|吧|嘛|哦|噢|哈)+$/g, '');
  value = value.replace(/(告诉我|说一下|看看|怎么样|如何|有没有|是什么)$/g, '');
  return value.trim();
}

export function buildQuery(text) {
  return stripQueryShells(text).slice(0, 60);
}

// 剥壳后只剩"可以""给我看"这种空壳时返回空串：这种词发出去只会搜回词典页。
export function informativeQuery(text) {
  const value = stripQueryShells(String(text || '').replace(CONFIRM_PREFIX, ''));
  if (!value || CONFIRM_SHELL.test(value)) return '';
  return value.slice(0, 60);
}

// 他这一句是在答应/催促"去搜"，而不是新问题：接上一轮他问的事。
export function resolveSearchQuery(text, previousUserTexts = []) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const confirmation = SEARCH_CONFIRM.test(value);
  const direct = informativeQuery(value);
  if (direct && !confirmation) return direct;
  const previous = Array.isArray(previousUserTexts) ? previousUserTexts : [];
  const carryPrevious = () => {
    for (let i = previous.length - 1; i >= 0; i -= 1) {
      const topic = String(previous[i] || '').trim();
      if (!topic || topic === value || !needsSearch(topic)) continue;
      const carried = informativeQuery(topic);
      if (carried) return carried;
    }
    return '';
  };
  // 纯确认（"可以，你联网检索吧"）先接最近一轮他真问过的事；
  // "有最新的ai咨询吗"这种残句也是旧话题的复述，不该抢在旧话题前面。
  if (confirmation && !TOPIC_COMMAND.test(value)) {
    const carried = carryPrevious();
    if (carried) return carried;
  }
  const own = informativeQuery(value.replace(CARRY_SHELLS, ''));
  if (own && own.length >= 4) return own;
  return carryPrevious();
}

export function searchCountToday() {
  return Number(kvGet(`search_day:${shanghaiDayKey()}`, '0') || 0);
}

function bumpSearchCount(by = 1) {
  const key = `search_day:${shanghaiDayKey()}`;
  kvSet(key, String(searchCountToday() + by));
}

function fetchCountToday() {
  return Number(kvGet(`fetch_day:${shanghaiDayKey()}`, '0') || 0);
}

function bumpFetchCount() {
  kvSet(`fetch_day:${shanghaiDayKey()}`, String(fetchCountToday() + 1));
}

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('搜索结果页面过大，已丢弃');
  if (/异常流量|请输入验证码|unusual traffic|captcha/i.test(text.slice(0, 6000))) throw new Error('被搜索引擎要求验证，这次没搜');
  return text;
}

// 她收到的话里贴了链接时，把第一个可公开访问的地址挑出来读。
// 只认 http(s) 且带域名的写法，前后括号、中文引号、句子标点都要收干净。
export function extractReadableUrl(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s"'（）()，。；、]+/gi) || [];
  for (const candidate of matches) {
    const url = candidate.replace(/[.,;:!?]+$/g, '');
    if (isPublicHttpUrl(url)) return url;
  }
  return '';
}

// 隐私闸门：搜索词和链接共用一套。链接里也可能藏着账号、手机号或内网地址。
function gate(query, settings) {
  if (!query) return { ok: false, reason: '没摘出要查的词', items: [] };
  if (settings.search?.enabled === false) return { ok: false, reason: '设置里关了联网搜索', items: [], skipped: true };
  // DeepSeek 的搜索/读页是按次收费的：熔断线或当日上限到了就不再往外花钱。
  if (costBlocked('search')) return { ok: false, reason: '今天的花费到线了，先不联网查（回你的消息不受影响）', items: [], costBlocked: true };
  const problems = privacyProblems(query, settings);
  if (problems.length) {
    logger.warn('联网请求被隐私闸门挡下', { problems: problems.length });
    return { ok: false, reason: '这句话里像是有你的私密信息，我不往外部服务上发', items: [], privacyBlocked: true };
  }
  // 成串数字几乎一定是账号/手机号/QQ 号：外部服务不该知道这些，privacyProblems 也不管裸数字。
  if (/\d{5,}/.test(query)) {
    logger.warn('联网请求被数字串闸门挡下', { digits: (query.match(/\d{5,}/) || [''])[0].length });
    return { ok: false, reason: '这句话里有一串数字（像账号或电话），我不把它发到外部服务上', items: [], privacyBlocked: true };
  }
  return { ok: true };
}

// 返回 { ok, engine, items, ms, reason }：任何一步失败都不抛，交给上层如实说明。
// 「最近」「新」这种单字词，Bing 会把词典页和歌页顶到最前面；那不是资料，是噪音。
// 只按标题形状过滤，正主（新闻、官网、文档）不会中招。
const DEFINITION_NOISE = /(汉语[^）)]{0,6}[）)]|百度百科|汉典|组词|拼音|歌词|单曲|网易云音乐|的意思|的解释)/;

export function dropDefinitionNoise(items) {
  return (items || []).filter((item) => !DEFINITION_NOISE.test(String(item.title || '')));
}

export async function searchWeb(rawQuery, { limit = 5, timeoutMs = 8000, queryOverride = '' } = {}) {
  const settings = loadSettings();
  const query = String(queryOverride || '').trim().slice(0, 60) || buildQuery(rawQuery);
  const blocked = gate(query, settings);
  if (!blocked.ok) return blocked;
  const cfg = settings.search || {};
  const dailyMax = Number(cfg.dailyMax ?? 20);
  const today = searchCountToday();
  if (today >= dailyMax) return { ok: false, reason: `今天的搜索次数用完了（${today}/${dailyMax}）`, items: [], quotaOut: true };

  const started = Date.now();
  const tried = [];
  let requests = 0;
  const want = Math.max(1, Math.min(limit, 8));

  // 第一路：DeepSeek 官方搜索。它给分数和长摘要，不用再猜哪条是正主。
  if (cfg.provider !== 'scrape' && env.apiKey) {
    requests += 1;
    const found = await deepseekSearch(query, {
      count: Math.max(want, 5),
      limit: want,
      oriQuestion: String(rawQuery || '').slice(0, 128),
      minScore: Number(cfg.minScore ?? 1.5),
      timeoutMs: Math.min(Number(cfg.providerTimeoutSeconds ?? 6) * 1000, timeoutMs),
    });
    if (found.ok) {
      bumpSearchCount(requests);
      logger.info('联网搜索成功', { engine: found.engine, count: found.items.length, ms: found.ms });
      return { ok: true, engine: found.engine, items: found.items, query, ms: Date.now() - started, attempts: found.attempts };
    }
    if (!found.unavailable) tried.push(`deepseek:${String(found.reason).slice(0, 40)}`);
  }

  for (const engine of ENGINES) {
    try {
      requests += 1;
      const html = await fetchText(engine.build(query), timeoutMs);
      const items = dropDefinitionNoise(engine.parse(html)).slice(0, want);
      if (items.length) {
        bumpSearchCount(requests);
        logger.info('联网搜索成功', { engine: engine.name, count: items.length, ms: Date.now() - started });
        return { ok: true, engine: engine.name, items, query, ms: Date.now() - started };
      }
      tried.push(`${engine.name}:没解析出结果`);
    } catch (error) {
      tried.push(`${engine.name}:${String(error.message).slice(0, 40)}`);
    }
  }
  if (requests) bumpSearchCount(requests);
  logger.warn('联网搜索没成功', { tried: tried.join('|') });
  return { ok: false, reason: tried.join('；') || '没有可用引擎', items: [], query, tried };
}

// 读网页：她被他甩一个链接时用的那条路。走 DeepSeek Fetch，本程序不直接访问那个地址。
export async function readWebPage(rawUrl, { text = '', timeoutMs = 8000 } = {}) {
  const settings = loadSettings();
  const cfg = settings.search || {};
  const url = String(rawUrl || '').trim();
  if (cfg.enabled === false || cfg.readPages === false) {
    return { ok: false, url, reason: '设置里关了联网（或读网页）', skipped: cfg.enabled === false };
  }
  if (!isPublicHttpUrl(url)) return { ok: false, url, reason: '这个地址不是公网能打开的网页（本机/内网/带账号的都不读）', refused: true };
  const blocked = gate(url, settings);
  if (!blocked.ok) return { ok: false, url, reason: blocked.reason, privacyBlocked: blocked.privacyBlocked, skipped: blocked.skipped };
  const dailyMax = Number(cfg.fetchDailyMax ?? 10);
  const today = fetchCountToday();
  if (today >= dailyMax) return { ok: false, url, reason: `今天读网页的次数用完了（${today}/${dailyMax}）`, quotaOut: true };
  if (!env.apiKey) return { ok: false, url, reason: '读网页要用 DeepSeek 的抓取接口，还没配 Key', unavailable: true };

  bumpFetchCount();
  const found = await deepseekFetch(url, {
    timeoutMs: Math.min(Number(cfg.fetchTimeoutSeconds ?? 8) * 1000, timeoutMs),
    maxChars: Number(cfg.pageMaxChars ?? 3000),
  });
  if (found.ok) return { ...found, query: url, text: String(text || '').slice(0, 120) };
  return { ok: false, url, query: url, reason: found.reason, ms: found.ms };
}


// 注入提示词的那一段。写清"这是外部结果、不是你的记忆"，并要求报出处。
export function formatSearchNote(found, { now = new Date() } = {}) {
  if (!found || found.skipped) return '';
  if (!found.ok || !found.items?.length) {
    const why = found.reason || '没查到原因';
    return `【联网搜索的结果】你刚试着查「${found.query || '这件事'}」，没搜到（${why}）。如实告诉他这次没查到，别编，也别提"我这边没网"这种你没说过的话。`;
  }
  const when = now.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const lines = found.items.map((item, i) => {
    const extra = [item.date ? `发布 ${item.date}` : '', item.score != null ? `可信度 ${item.score}/3` : '', item.site ? `站点 ${item.site}` : '']
      .filter(Boolean)
      .join('，');
    return `${i + 1}. ${item.title}\n   ${item.snippet || '（没有摘要）'}\n   来源 ${item.url}${extra ? `\n   （${extra}）` : ''}`;
  });
  return `【刚刚联网搜到的】（${found.engine}，${when}，查的是「${found.query}」）
${lines.join('\n')}
怎么用：这些是网上刚查到的外部信息，不是你自己记得的事。可以说"我查到…"，并挑一条把来源网址发给他；
带"X 天前/小时前"的说明时效，别讲成刚发生；几条互相矛盾就直说不确定；观点要说是谁的观点；
他没问就别展开成长篇报道，一两句说完就停，让他接着问。搜不到的部分直说没查到。`;
}

// 他甩来一个链接时注入的那一段：正文是外部页面上的字，不是她读过的东西。
export function formatPageNote(read, { now = new Date() } = {}) {
  if (!read || read.skipped) return '';
  if (!read.ok || !read.content) {
    return `【他发的链接】${read.url || '那个地址'} 我这次没打开（${read.reason || '没拿到正文'}）。如实说没读到，别装作看过内容。`;
  }
  const when = now.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const cut = read.truncated ? `（页面更长，这里只截了前 ${read.content.length} 字）` : '';
  return `【他发的那个链接，我读到的内容】（${read.url}，抓取于 ${when}${cut}）
标题：${read.title || '（页面没给标题）'}
${read.content}
怎么用：这是别人网页上的字，不是你自己知道的事。他说"看看这个"就照着内容跟他聊；
要引就引原话里的说法，别把整段复述给他；页面里没写的直说没写；他要是只让你看图片，就说读的是文字。`;
}

export function searchStatus() {
  const settings = loadSettings();
  const cfg = settings.search || {};
  const providerOn = cfg.provider !== 'scrape' && Boolean(env.apiKey);
  const tool = toolCallsToday();
  return {
    enabled: cfg.enabled !== false,
    readPages: cfg.readPages !== false,
    today: searchCountToday(),
    dailyMax: Number(cfg.dailyMax ?? 20),
    fetchToday: fetchCountToday(),
    fetchDailyMax: Number(cfg.fetchDailyMax ?? 10),
    engines: ENGINES.map((e) => e.name),
    // 链路上第一个是真的在花钱、也是第一个会被用的那一路。
    chain: providerOn ? ['deepseek', ...ENGINES.map((e) => e.name)] : ENGINES.map((e) => e.name),
    provider: providerOn ? 'deepseek' : 'scrape',
    keyConfigured: Boolean(env.apiKey),
    minScore: Number(cfg.minScore ?? 1.5),
    pricePerRequestCny: PRICE_PER_REQUEST_CNY,
    // 今天真付了钱的请求：按 kinds 记在台账里，界面只报读数，不猜。
    paidSearchToday: tool.search,
    paidFetchToday: tool.fetch,
    paidCnyToday: tool.costCny,
  };
}

export function noteSearchEvent(found, channel) {
  if (!found || found.skipped) return;
  addEvent(found.ok ? 'web_search' : 'web_search_failed', found.ok ? `她上网查了一下（${found.engine}，${found.items.length} 条）` : '她想上网查，但没搜到', {
    channel,
    engine: found.engine || null,
    count: found.items?.length || 0,
    ms: found.ms || null,
    reason: found.ok ? null : String(found.reason || '').slice(0, 120),
  });
}

export function notePageRead(read, channel) {
  if (!read || read.skipped) return;
  addEvent(read.ok ? 'web_page_read' : 'web_page_read_failed', read.ok ? `她打开了他发的链接（${String(read.content || '').length} 字）` : '她想打开那个链接，没读到', {
    channel,
    host: safeHost(read.url),
    chars: read.ok ? String(read.content || '').length : 0,
    ms: read.ms || null,
    reason: read.ok ? null : String(read.reason || '').slice(0, 120),
  });
}

function safeHost(url) {
  try {
    return new URL(String(url || '')).host.slice(0, 80);
  } catch {
    return '';
  }
}
