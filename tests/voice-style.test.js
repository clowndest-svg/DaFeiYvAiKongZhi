import test from 'node:test';
import assert from 'node:assert/strict';
import { naturalizeForSpeech, planSpokenReply, semanticDrift, splitLongSentences } from '../src/voice-style.js';

test('书面腔被改成可朗读的短句，且剥掉 markdown 与 emoji', () => {
  const { speech, removed } = naturalizeForSpeech('## 结论\n- **今天**很累 :)\n- 我们[聊聊](https://example.com/a)这件事');
  assert.ok(!/[#*_`\[\]]/.test(speech), `还留着 markdown 记号：${speech}`);
  assert.ok(!/https?:/.test(speech), `还留着链接：${speech}`);
  assert.ok(speech.includes('聊聊'), '链接的锚文本要留下');
  assert.ok(removed.length >= 2, '至少改动过 markdown 与符号两类');
});

test('长句只在真有内部停顿处断，不硬挤', () => {
  const long = '我今天在会议室里听他讲了整整两个小时的项目规划然后我整个人都不好了。';
  const split = splitLongSentences(long, { maxSentenceChars: 28 });
  assert.ok(split.includes('。'), '应当在窗口内的停顿处插句号');
  assert.strictEqual(split.replace(/。/g, '。').replace(/[。]/g, '').length, long.replace(/[。]/g, '').length, '断句只许加标点，不许动字');
  const short = splitLongSentences('我没事。', { maxSentenceChars: 28 });
  assert.strictEqual(short, '我没事。', '短句不该被动');
});

test('语义安全：数字、否定词在改写后必须一个都不能少', () => {
  const before = '这个药不能和酒一起喝，晚上十点以后别吃，一天最多 3 次。';
  const { speech } = naturalizeForSpeech(before);
  const drift = semanticDrift({ before, after: speech });
  assert.deepStrictEqual(drift.droppedDigits, [], '数字被吃掉了');
  assert.ok(drift.negationAfter >= drift.negationBefore, '否定词变少了，意思会反');
  assert.ok(speech.includes('不能') && speech.includes('别'), '否定词必须原样在');
});

test('数字与时间是硬线：一旦丢数字就整条退回原文发文字', () => {
  // 用一个真的会丢数字的输入来证明这条闸门不是摆设：链接里的数字被剥掉后触发降级。
  const risky = '记得 18 点吃药，详情看 https://a.com/dose1 这页。';
  const plan = planSpokenReply(risky, { maxChars: 60 });
  assert.strictEqual(plan.mode, 'text', '链接里的数字被抹掉就必须改文字发，不能冒险念错');
  assert.strictEqual(plan.text, risky);
});

test('说不下的长回答按整句降级，绝不中段截断', () => {
  const long = '今天怎么啦？听起来你有点累。要不要先喝口水，然后我们慢慢说。你别急着回答我。';
  const plan = planSpokenReply(long, { maxChars: 24 });
  assert.strictEqual(plan.mode, 'voice');
  assert.ok(/[。！？]$/.test(plan.text), `必须停在句子边界：${plan.text}`);
  assert.ok(plan.text.length <= 24);
  assert.ok(plan.dropped >= 1, '应当报告丢了整句，而不是切一半');
});

test('第一句就超预算时不硬发碎片，改文字', () => {
  const plan = planSpokenReply('我们现在就把这件事从头到尾重新梳理一遍并且逐条落实下去吧', { maxChars: 10 });
  assert.strictEqual(plan.mode, 'text');
  assert.match(plan.reason, /第一句就超出/);
});

test('太短的内容不值得占用语音额度', () => {
  const plan = planSpokenReply('嗯', { maxChars: 60, minChars: 4 });
  assert.strictEqual(plan.mode, 'text');
  assert.match(plan.reason, /短到不值得/);
});

test('正常口语短句原样通过，改写不多此一举', () => {
  const plan = planSpokenReply('回来啦？今天累不累。', { maxChars: 60 });
  assert.strictEqual(plan.mode, 'voice');
  assert.strictEqual(plan.text, '回来啦？今天累不累。');
});

test('改写不许吞掉任何一个字：只许动标点和装饰，正文汉字必须逐字保住', () => {
  const samples = [
    '我们今天先在会议室过一遍方案，然后再决定要不要把排期往后挪两个星期，你觉得怎么样？',
    '别熬夜了，明天还要早起，听话。',
    '刚看到你说嗓子哑了，我记得你上次也是这样，后来喝了三天热水才好。',
    '这个问题我不太确定，我们查查看再说。',
    '**重要**：三点半开会，我提前十分钟叫你。',
  ];
  const cjkOnly = (value) => String(value).replace(/[^一-龥a-zA-Z0-9]/g, '').split('').sort().join('');
  for (const sample of samples) {
    const { speech } = naturalizeForSpeech(sample);
    assert.equal(cjkOnly(speech), cjkOnly(sample.replace(/\*\*/g, '')), `改写吞字了：${sample} → ${speech}`);
  }
});

test('空输入不给语音也不给假内容', () => {
  assert.strictEqual(planSpokenReply('   ', { maxChars: 60 }).mode, 'text');
  assert.strictEqual(naturalizeForSpeech('').speech, '');
});
