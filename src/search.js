// 联网查资料：她以前只能靠记忆里那点东西，被问"最新"的事只能说不知道（有时还会说成"我这边没网"）。
// 这里给她一条真实的搜索路：只走公开搜索引擎的网页结果，不装依赖、不要 key。
//
// 三条硬规矩：
// 1) 查询词里像有主人隐私（账号、住址、真名、公司）就不发出去，宁可说搜不了；
// 2) 搜到的是外部信息，不是她的记忆，注入时必须带着"怎么用、怎么报出处"的说明；
// 3) 搜不到/被墙/超时都如实报原因，界面显示"未测"而不是拿旧数据冒充。

import { loadSettings } from './config.js';
import { addEvent, kvGet, kvSet } from './db.js';
import { logger } from './logger.js';
import { privacyProblems } from './privacy.js';
import { shanghaiDayKey } from './util.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_BYTES = 2 * 1024 * 1024;

// 明显在要"新鲜信息"的说法。刻意做窄：日常情绪话不该触发外网请求。
const FRESH = /(最新|最近|这几天|这两天|今天|现在|刚刚|刚才|新闻|发布|上线|更新|出了什么|发生了什么|比分|赛果|战绩|股价|行情|汇率|天气|价格|多少钱|版本号|版本|榜单|排名|什么时候)/;
const ASK = /(搜|查|看看|知道吗|听说|有什么|是什么|有没有|多少|几点|怎样|怎么样)/;
const EXPLICIT = /^\s*[\/／]?\s*(搜一下|搜索|搜|查一下|查查|查|帮我查|上网查|上网搜|google)/i;
// 情绪/日常话不搜：别把"想你了"发去搜索引擎。
// 光有 ASK 词表会漏掉「最近发布了什么新东西」这种说法，所以再认"疑问句形状"：
// 带问号，或者句尾落在疑问词上。只判断句尾是因为「最近好累啊什么都不想做」中间也有"什么"，
// 但那是陈述自己的状态，不该被拖去上网搜。
const QTAIL = /(什么|啥|吗|呢|多少|几点|多久|哪\S{0,2}|怎么|怎样|咋|是否|如何|有没有|是不是|能不能|几个)[!！。.,，、;；~～\s]*$/;
// 问的是她本人（"你最近有没有好好吃饭"），是要陪伴不是要资料。
const ABOUT_HER = /(你|您|你们|小知)[^我他她]{0,4}(有没有|是不是|知不知道|记不记得|想不想|要不要|爱不爱|在不在)/;
const PERSONAL = /(想你了|想你|抱抱|亲亲|晚安|早安|爱你|生气|难过|委屈|辛苦了|在吗|在干嘛|吃了吗|嗯+|哦+|哈哈+|嘻嘻)/;

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
  return FRESH.test(value) && (ASK.test(value) || QTAIL.test(value) || /[?？]/.test(value));
}

// 把口语摘成查询词：去掉称呼、语气词和"帮我"这类壳，只留信息部分。
export function buildQuery(text) {
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
  value = value.trim();
  return value.slice(0, 60);
}

export function searchCountToday() {
  return Number(kvGet(`search_day:${shanghaiDayKey()}`, '0') || 0);
}

function bumpSearchCount() {
  const key = `search_day:${shanghaiDayKey()}`;
  kvSet(key, String(searchCountToday() + 1));
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

// 返回 { ok, engine, items, ms, reason }：任何一步失败都不抛，交给上层如实说明。
// 「最近」「新」这种单字词，Bing 会把词典页和歌页顶到最前面；那不是资料，是噪音。
// 只按标题形状过滤，正主（新闻、官网、文档）不会中招。
const DEFINITION_NOISE = /(汉语[^）)]{0,6}[）)]|百度百科|汉典|组词|拼音|歌词|单曲|网易云音乐|的意思|的解释)/;

export function dropDefinitionNoise(items) {
  return (items || []).filter((item) => !DEFINITION_NOISE.test(String(item.title || '')));
}

export async function searchWeb(rawQuery, { limit = 5, timeoutMs = 8000 } = {}) {
  const settings = loadSettings();
  const query = buildQuery(rawQuery);
  if (!query) return { ok: false, reason: '没摘出要查的词', items: [] };
  if (settings.search?.enabled === false) return { ok: false, reason: '设置里关了联网搜索', items: [], skipped: true };
  const problems = privacyProblems(query, settings);
  if (problems.length) {
    logger.warn('搜索被隐私闸门挡下', { problems: problems.length });
    return { ok: false, reason: '这句话里像是有你的私密信息，我不往搜索引擎上发', items: [], privacyBlocked: true };
  }
  // 成串数字几乎一定是账号/手机号/QQ 号：搜索引擎不该知道这些，privacyProblems 也不管裸数字。
  if (/\d{5,}/.test(query)) {
    logger.warn('搜索被数字串闸门挡下', { digits: (query.match(/\d{5,}/) || [''])[0].length });
    return { ok: false, reason: '这句话里有一串数字（像账号或电话），我不把它发到搜索引擎上', items: [], privacyBlocked: true };
  }
  const dailyMax = Number(settings.search?.dailyMax ?? 20);
  const today = searchCountToday();
  if (today >= dailyMax) return { ok: false, reason: `今天的搜索次数用完了（${today}/${dailyMax}）`, items: [], quotaOut: true };

  const started = Date.now();
  const tried = [];
  for (const engine of ENGINES) {
    try {
      const html = await fetchText(engine.build(query), timeoutMs);
      const items = dropDefinitionNoise(engine.parse(html)).slice(0, Math.max(1, Math.min(limit, 8)));
      bumpSearchCount();
      if (items.length) {
        logger.info('联网搜索成功', { engine: engine.name, count: items.length, ms: Date.now() - started });
        return { ok: true, engine: engine.name, items, query, ms: Date.now() - started };
      }
      tried.push(`${engine.name}:没解析出结果`);
    } catch (error) {
      bumpSearchCount();
      tried.push(`${engine.name}:${String(error.message).slice(0, 40)}`);
    }
  }
  logger.warn('联网搜索没成功', { tried: tried.join('|') });
  return { ok: false, reason: tried.join('；') || '没有可用引擎', items: [], query };
}

// 注入提示词的那一段。写清"这是外部结果、不是你的记忆"，并要求报出处。
export function formatSearchNote(found, { now = new Date() } = {}) {
  if (!found || !found.ok || !found.items?.length) {
    if (found?.skipped) return '';
    const why = found?.reason || '没查到原因';
    return `【联网搜索的结果】你刚试着查「${found?.query || '这件事'}」，没搜到（${why}）。如实告诉他这次没查到，别编，也别提"我这边没网"这种你没说过的话。`;
  }
  const when = now.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const lines = found.items.map((item, i) => `${i + 1}. ${item.title}\n   ${item.snippet || '（没有摘要）'}\n   来源 ${item.url}`);
  return `【刚刚联网搜到的】（${found.engine}，${when}，查的是「${found.query}」）
${lines.join('\n')}
怎么用：这些是网上刚查到的外部信息，不是你自己记得的事。可以说"我查到…"，并挑一条把来源网址发给他；
带"X 天前/小时前"的说明时效，别讲成刚发生；几条互相矛盾就直说不确定；观点要说是谁的观点；
他没问就别展开成长篇报道，一两句说完就停，让他接着问。搜不到的部分直说没查到。`;
}

export function searchStatus() {
  const settings = loadSettings();
  return {
    enabled: settings.search?.enabled !== false,
    today: searchCountToday(),
    dailyMax: Number(settings.search?.dailyMax ?? 20),
    engines: ENGINES.map((e) => e.name),
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
