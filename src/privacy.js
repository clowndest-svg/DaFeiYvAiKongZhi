const BANNED = [
  '主人', '宝宝', '男朋友', '女朋友', '谈恋爱', '恋爱', '暧昧', '亲密度',
  '私聊', '我们的约定', '咱俩', '我家那位', 'AI女友', 'ai女友', '虚拟女友',
  '日记本', '看他日记', '他日记', '我的日记', '晚安笨蛋', '小鲸鲸', '扮演',
];

const PRIVATE_PATTERNS = [
  [/\d{1,2}\s*点(?:半|钟)?/, '具体时间点'],
  [/[一二两三四五六七八九十]{1,3}\s*点(?:半|钟|整|多|左右|[0-9])/, '具体时间点'],
  [/\d{1,2}\s*[:：]\s*\d{2}/, '具体时间'],
  [/\d{1,2}\s*月\s*\d{1,2}\s*[日号]/, '具体日期'],
  [/(约定|答应(?:我|你)|查岗|不许告诉|只告诉你|别告诉|保密|悄悄话)/, '私下的约定'],
  [/(日记|本子|翻(?:我|你)?的?(?:日记|本子))/, '日记'],
  [/(他(?:今天|昨天|刚才|昨晚|今早|下午|晚上|跟我说|让我|答应|陪我|找我|回家|上班|睡觉))/, '指向他的私事'],
  [/(昨晚|今晚|明早|明天早上).{0,6}(说|答应|约|睡|查|叫|抱|亲)/, '私下作息'],
  [/(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]+|(?:p_skey|skey|access_token|console_password)\s*[:=])/i, '登录凭据'],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/, '手机号码'],
];

export const TOPIC_HINTS =
  '今天的心情、学到或看到的东西、AI 与技术的观察、蓝鲸鱼形象的日常、吃饭睡觉天气、追的番、吐槽 bug、读到的一句话';

export function normalizePrivateText(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\p{Z}\p{Cf}\s]/gu, '');
}

export function bannedWords(settings = {}) {
  const extra = [settings.companion?.userName, settings.companion?.nickname, settings.social?.xhsOwnerName, settings.social?.xhsOwnerUserId]
    .map((word) => String(word || '').trim()).filter((word) => normalizePrivateText(word).length >= 2);
  return [...new Set([...BANNED, ...extra])];
}

export function privacyProblems(text, settings = {}) {
  const value = String(text || '').normalize('NFKC').replace(/\p{Cf}/gu, '');
  const bare = normalizePrivateText(value);
  const problems = bannedWords(settings)
    .filter((word) => bare.includes(normalizePrivateText(word)))
    .map((word) => `出现私密称呼「${word}」`);
  for (const [pattern, label] of PRIVATE_PATTERNS) if (pattern.test(value)) problems.push(`出现${label}`);
  return problems;
}

export function leaksFromChat(text, hisMessages = []) {
  const value = normalizePrivateText(text);
  if (!value) return [];
  const hits = new Set();
  for (const message of hisMessages) {
    const clean = normalizePrivateText(message);
    if (clean.length < 8) continue;
    for (let i = 0; i + 8 <= clean.length; i += 1) {
      const shard = clean.slice(i, i + 8);
      if (value.includes(shard)) { hits.add(shard); break; }
    }
    if (hits.size >= 3) break;
  }
  return [...hits];
}

export function assertPublicContent(text, { settings = {}, hisMessages = [] } = {}) {
  const value = String(text || '').trim();
  if (!value) return { ok: false, kind: 'empty', reason: '没有要发的内容' };
  const problems = privacyProblems(value, settings);
  if (problems.length) return { ok: false, kind: 'banned', reason: problems.join('；') };
  const echoes = leaksFromChat(value, hisMessages);
  if (echoes.length) return { ok: false, kind: 'echo', reason: `和私聊里的说法撞了 ${echoes.length} 处`, echoes };
  return { ok: true, reason: '' };
}
