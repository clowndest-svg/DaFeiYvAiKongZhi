// 朗读文本层：把「书面的回答」变成「可以说出口的话」。
// 只做确定性改写——不加语气词、不换个说法、不动数字。语义安全的边界由判据钉住：
// 数字集合不变、否定词不许变少、不残留 markdown、超长时按整句降级而不是中段截断。

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;
const MARKDOWN_LEFT = /[*_#`>~|]|https?:\/\/\S+|\[[^\]]*\]\([^)]*\)/i;

// 「→」「——」这类符号在朗读里会变成 Silence 或乱念，直接换成标点。
function replaceSymbols(text) {
  return String(text)
    .replace(/[→←⇒]/g, '，')
    .replace(/[—–]/g, '，')
    .replace(/[·▪•◦]/g, '，')
    .replace(/【([^】]*)】/g, '$1')
    .replace(/《([^》]*)》/g, '$1');
}

function stripMarkup(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    // 链接语法必须在剥裸 URL 之前处理，否则 [文字](https://…) 会先被剥成 [文字]( 剩下空壳。
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^[\s>]*[-*+]\s+/gm, '')
    .replace(/^\s*\d{1,2}[.、]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/[|]{1,2}/g, '，')
    .replace(/\s{2,}/g, ' ');
}

function tidyPunctuation(text) {
  return String(text)
    .replace(/([。！？、，；])\1{1,}/g, '$1')
    .replace(/([！?？])\s*[。]/g, '$1')
    .replace(/^[，、；:\s]+/u, '')
    .replace(/[，、；:\s]+$/u, '')
    .replace(/([，、；])(?=\s*[，、；])/g, '')
    .trim();
}

// 只在「这一句确实太长」时插一个句号，位置取最靠前的逗号/分号；
// 没有内部停顿可下刀就不动它——宁可长，也不要断错地方。
export function splitLongSentences(text, { maxSentenceChars = 28 } = {}) {
  return String(text)
    .split(/(?<=[。！？])/)
    .map((sentence) => {
      const body = sentence.trim();
      if (body.length <= maxSentenceChars) return sentence;
      const window = body.slice(0, maxSentenceChars);
      const cut = window.search(/[，,；;、]([^，,；;、]*)$/);
      if (cut < 0) return sentence;
      // 逗号换成句号，后半截必须从 cut+1 接着走 —— 早先用 slice(maxSentenceChars) 会把
      // 中间那段字直接吞掉（判据里"数字被吃掉"就是它咬的）。
      const head = body.slice(0, cut + 1).replace(/[，,、]$/, '。');
      const tail = body.slice(cut + 1).replace(/^[，,、；]/, '');
      if (!tail) return sentence;
      return `${head}${tail}`;
    })
    .join('');
}

export function naturalizeForSpeech(text) {
  // 先按原样剥 markdown（此时还在行首，^- 与 ^# 命中得到），再才压成一行送进 TTS。
  const raw = String(text || '').trim();
  if (!raw) return { speech: '', removed: [] };
  let value = raw;
  const removed = [];
  const step = (label, before, fn) => {
    const after = String(fn(before));
    if (after !== before) removed.push(label);
    return after;
  };
  value = step('markdown', value, stripMarkup);
  value = step('emoji', value, (input) => input.replace(EMOJI, ' '));
  value = step('符号', value, replaceSymbols);
  value = step('折行', value, (input) => input.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' '));
  value = step('断句', value, (input) => splitLongSentences(input));
  value = step('标点', value, tidyPunctuation);
  return { speech: value, removed };
}

const digitsOf = (text) => String(text).match(/\d/g) || [];
const negationsOf = (text) => String(text).match(/[不没别无需]|没有|不是|不用|别/g) || [];

// 数字与否定词是"改坏意思"的两条最短路径，这里逐字比，不做「差不多就行」。
export function semanticDrift({ before, after }) {
  const b = digitsOf(before);
  const a = digitsOf(after);
  const missingDigits = b.filter((d) => {
    const i = a.indexOf(d);
    if (i < 0) return true;
    a.splice(i, 1);
    return false;
  });
  return {
    droppedDigits: missingDigits,
    negationBefore: negationsOf(before).length,
    negationAfter: negationsOf(after).length,
    markdownLeft: MARKDOWN_LEFT.test(String(after)),
  };
}

// 说不下的内容不硬砍：整句丢掉，丢到能进语音时长预算；一句都放不下就改文字。
export function planSpokenReply(reply, { maxChars = 60, minChars = 4 } = {}) {
  const source = String(reply || '').trim();
  const { speech, removed } = naturalizeForSpeech(source);
  if (!speech) return { mode: 'text', text: source, reason: '没有可以说出口的内容', removed };
  if (speech.length < minChars) return { mode: 'text', text: source, reason: '短到不值得占用语音额度', removed };
  const drift = semanticDrift({ before: source, after: speech });
  if (drift.droppedDigits.length || drift.negationAfter < drift.negationBefore || drift.markdownLeft) {
    return { mode: 'text', text: source, reason: '改写会丢事实，原文用文字发', removed, drift };
  }
  if (speech.length <= maxChars) return { mode: 'voice', text: speech, reason: '', removed, drift };
  const sentences = speech.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);
  const kept = [];
  let used = 0;
  for (const sentence of sentences) {
    if (used + sentence.length > maxChars) break;
    kept.push(sentence);
    used += sentence.length;
  }
  if (!kept.length || used < minChars) {
    return { mode: 'text', text: source, reason: '第一句就超出语音时长预算，改文字', removed, drift };
  }
  return { mode: 'voice', text: kept.join(''), reason: `只说前 ${kept.length} 句，剩下的用文字发`, removed, drift, trimmed: true, dropped: sentences.length - kept.length };
}
