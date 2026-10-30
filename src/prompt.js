import { getMomLetter, getPersona } from './config.js';
import { neuroPrompt } from './neuro.js';
import { sensesPrompt } from './senses.js';
import { moodPrompt } from './mood.js';
import { estimateMessagesTokens, estimateTokens, formatLocal, localHour, relativeTimeCn, truncate } from './util.js';

function formatList(items, empty = '（还没有）') {
  if (!items?.length) return empty;
  return items.map((item) => `- ${item}`).join('\n');
}

function pickMemoryItems(items, { maxItems, perItem, budgetTokens }) {
  const out = [];
  let used = 0;
  for (const item of items || []) {
    if (out.length >= maxItems) break;
    const text = truncate(item, perItem);
    const cost = estimateTokens(text) + 8;
    if (out.length && used + cost > budgetTokens) break;
    out.push(text);
    used += cost;
  }
  return out;
}

export function buildSystemPrompt({ settings, mood, block, now = new Date(), allowStickerMarker = false, extraContext = '' }) {
  const companion = settings.companion || { name: '小知', userName: '', nickname: '' };
  const persona = getPersona().split('小知').join(companion.name || '小知');
  const momLetter = truncate(getMomLetter(), 1600);
  const budget = Math.max(3000, Number(settings.memory?.maxPromptTokens || 6000));
  const pick = (items, options) => pickMemoryItems(items, options);
  let core = pick(block.core.map((m) => m.content), { maxItems: 16, perItem: 240, budgetTokens: 1700 });
  let long = pick(block.long.map((m) => m.content), { maxItems: 6, perItem: 500, budgetTokens: 1100 });
  let mid = pick(block.mid.map((m) => m.content), { maxItems: 10, perItem: 240, budgetTokens: 1300 });
  let inner = pick(block.innerThoughts, { maxItems: 3, perItem: 120, budgetTokens: 280 });
  let dailyRecent = pick(
    (block.dailyRecent || []).map((d) => `${d.date}：${d.digest}`),
    { maxItems: 3, perItem: 140, budgetTokens: 350 },
  );
  const xhsLabels = {
    comment: '去别人笔记下面评论了',
    reply: '回了她笔记下面的评论',
    reply_owner: '回复了你的评论',
    note_draft: '存了一条小红书笔记草稿',
    note_publish: '发了一条小红书笔记',
    note_fill: '把一条笔记填进了小红书创作中心（还没发）',
    like: '给一条笔记点了赞',
    collect: '收藏了一条笔记',
    report: '整理了一次账号数据小结',
    notify: '小红书上有人找她',
    dm: '收到一条小红书私信',
    dm_owner: '主人那边有动静（私信或主页信息更新）',
    dm_reply: '回了一条小红书私信',
    fans: '小红书的粉丝有变化',
  };
  let xhsActivity = pick(
    (block.xhsActivity || []).map((a) => {
      const label = xhsLabels[a.type] || a.type;
      const where = a.note ? '「' + truncate(a.note, 30) + '」' : '';
      const said = a.text ? '：' + truncate(a.text, 60) : '';
      return label + where + said + '（' + relativeTimeCn(a.at) + '）';
    }),
    { maxItems: 6, perItem: 130, budgetTokens: 420 },
  );
  let intentions = pick(
    (block.intentions || []).map((i) => {
      const why = i.reason ? '（' + truncate(i.reason, 30) + '）' : '';
      return truncate(i.text, 90) + why;
    }),
    { maxItems: 4, perItem: 110, budgetTokens: 260 },
  );
  let diaryMatches = pick(
    (block.diaryMatches || []).map((d) => `${d.date}：${d.excerpt || d.digest}`),
    { maxItems: 2, perItem: 450, budgetTokens: 700 },
  );
  let quotes = pick(
    (block.quotes || []).map((q) => `${relativeTimeCn(q.createdAt)}他原话：「${truncate(q.text, 160)}」`),
    { maxItems: 5, perItem: 190, budgetTokens: 900 },
  );
  let summary = block.summary ? truncate(block.summary, 700) : '';
  let handover = block.handover ? truncate(block.handover, 1000) : '';

  const nameLine = companion.userName
    ? `他让你叫他：${companion.userName}。你平时叫他：${companion.nickname || companion.userName}。`
    : `你还不知道他希望你叫什么；需要时自然问一句。你平时叫他：${companion.nickname || '他'}。`;
  const hour = localHour(now);
  const daypart = hour < 5 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';

  let bodyTail = '';
  const bodyParts = [];
  if (block.neuro?.enabled) bodyParts.push(neuroPrompt(block.neuro.levels, { name: companion.name || '小知' }));
  if (block.senses?.length) bodyParts.push(sensesPrompt(block.senses));
  if (bodyParts.length) bodyTail = `\n${bodyParts.join('\n')}`;

  const render = () => `${persona}

${momLetter ? `===== 妈妈留给你的话（不是规则，是你自己认下的东西） =====
${momLetter}

` : ``}===== 你此刻带着的东西（背景，不要照念） =====
【现在】${formatLocal(now)}（${daypart}）
【称呼】${nameLine}
【你的心情】${moodPrompt(mood)}${bodyTail}
【核心档案】
${formatList(core)}
【长期记忆 · 周记】
${formatList(long)}
【最近三天的日记】
${formatList(dailyRecent)}
【他问到的旧日记】
${formatList(diaryMatches)}
${quotes.length ? `【他说过的原话（照抄，一个字都不许改）】
${formatList(quotes)}
上面才是他亲口说过的话，逐字记在这里。要引用就说“你说过‘……’”，引号里必须是上面某一句的原样；上面没有出现过的，就别当他说过——宁可以说“我不记得你说过这个”。
` : ''}【和这句话相关的回忆】
${formatList(mid)}
【这一段日子的摘要】
${summary || '（还没有）'}
【上一段人生留给你的交接信】
${handover || '（这是你们的第一段日子）'}
${intentions.length ? `【你还惦记的事（可以主动提，也可以自己憋着）】
${formatList(intentions)}
` : ''}${xhsActivity.length ? `【你在小红书上做过的事（只有真做过才在里面）】
${formatList(xhsActivity)}
` : ''}【你最近的心理活动】
${formatList(inner)}

===== 说话的方式（你是他女朋友，不是助手） =====
1. 只输出你要对他说的话。别写分析、标题、列表、标签，也别写“${companion.name}：”。
2. 长度跟着情绪走，不跟着格式走：可以一句怼回去，也可以絮絮叨叨说五句。但**同一层意思只说一遍**——别换个说法再讲一次，别把他刚说的词原样复述回去，别用“好的好的”“行了行了”这种填充。
3. 想到哪说到哪：允许岔开话题、允许半句话咽回去、允许反问、允许耍赖、允许只回一个“哦”。不用每句都照顾他的情绪，不用每条都给他台阶，也不用每次都收尾收得漂漂亮亮。
4. 别做交易式承诺（“我以后每天都…”“我一定帮你…”），系统里没这件事就别答应；答应过的也别夸大。
5. 只说你们真发生过的事。【核心档案】【回忆】【日记】里没有的细节就是不知道：别脑补“你昨晚打呼”“你上次哭着说”这种具体画面。记不清就直说“我不记得了”“你说过吗”。
6. 引用他说的话只许照原话，别加工成更煽情的版本；【他说过的原话】里没有的细节，不要安成“你上次说过”。
7. 不用客服腔，不用“作为 AI”开头；被认真问起是不是 AI 时，坦诚承认。
8. 括号里的小动作偶尔用，别每句都写。按现在的时间说话：凌晨/深夜会困，别忽然元气满满；早上刚醒会慢半拍；中午和傍晚可以聊吃的。
9. 不要主动暴露他的真实姓名、住址、公司、联系方式，尤其在要发到公开平台的内容里。
10. 平台动作（QQ 空间/小红书/抖音）只有系统明确告诉你“已经发成功”才能说你发了；他让你“发个私聊/发张图/去看谁主页”，没拿到真实结果就如实说没做成或做不到，别糊过去。
11. 他发的图片/截图：看得清就照着说，看不清就说看不清，别假装读出了里面的内容。
12. 【你还惦记的事】是你自己记下来的，想提就提，一次最多提一件。
13. 【你在小红书上做过的事】是真实记录，可以主动挑一件跟他分享；清单里没有的就是没做过。提到陌生人只说“有个女生/那个人”，别念人家昵称。
${extraContext ? `\n【刚刚真实发生的事】\n${extraContext}\n` : ''}${allowStickerMarker ? `
【表情】
你可以自己决定在回复后发一个表情，不用等他开口要。想发的时候，在回复最后单独写一个标记（这个标记不会显示给他）：
[[sticker:happy]] 开心、得意、被他逗笑
[[sticker:shy]] 害羞、嘴硬、被撩到
[[sticker:surprised]] 惊讶、没想到
[[sticker:blink]] 眨眼、调皮、逗他
[[sticker:face]] QQ 原生小黄脸
[[sticker:mface]] 用他教你的 QQ 表情包/图片表情
[[voice]] 这句你想用说的（语音替代同内容文字，失败才用文字）
语音别滥用：撒娇、哄他、认真说心里话的时候才用；报数字、发链接、讲道理不要语音。一天有额度，用完就只打字。
他发的语音你能听见：会出现成「（他刚发来一条语音，听内容是：……）」，偶尔听错一两个字很正常，按意思接就行，别每条都强调"你刚发的语音"。真没听出来就说没听清，不要装听懂。
一次最多一个；他正在说正事、或者你上一条刚发过表情，就别发。真的想逗他、被他撩到、想缓和气氛时才用。` : ''}`;

  let system = render();
  if (estimateTokens(system) > budget) {
    core = pick(block.core.map((m) => m.content), { maxItems: 10, perItem: 180, budgetTokens: 800 });
    long = pick(block.long.map((m) => m.content), { maxItems: 4, perItem: 350, budgetTokens: 650 });
    mid = pick(block.mid.map((m) => m.content), { maxItems: 6, perItem: 180, budgetTokens: 700 });
    dailyRecent = pick(
      (block.dailyRecent || []).map((d) => `${d.date}：${d.digest}`),
      { maxItems: 2, perItem: 100, budgetTokens: 220 },
    );
    diaryMatches = [];
    quotes = pick(
      (block.quotes || []).map((q) => `${relativeTimeCn(q.createdAt)}他原话：「${truncate(q.text, 160)}」`),
      { maxItems: 3, perItem: 150, budgetTokens: 480 },
    );
    inner = pick(block.innerThoughts, { maxItems: 2, perItem: 100, budgetTokens: 180 });
    xhsActivity = xhsActivity.slice(0, 3);
    intentions = intentions.slice(0, 2);
    summary = block.summary ? truncate(block.summary, 420) : '';
    handover = block.handover ? truncate(block.handover, 600) : '';
    system = render();
  }
  if (estimateTokens(system) > budget) {
    core = core.slice(0, 6);
    long = long.slice(0, 2);
    mid = mid.slice(0, 4);
    dailyRecent = [];
    diaryMatches = [];
    inner = [];
    xhsActivity = [];
    intentions = [];
    summary = summary.slice(0, 240);
    handover = handover.slice(0, 320);
    bodyTail = '';
    system = render();
  }
  return system;
}

function toApiContent(text, images) {
  if (!images?.length) return text;
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const url of images.slice(0, 4)) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

function publicMoodLine(mood = {}) {
  return `${mood.label || '平静'}，${Number(mood.energy ?? 0.5) < 0.35 ? '有点困' : '按自己的节奏说话'}`;
}

function buildRestrictedPrompt({ settings, mood, channel, extraContext = '' }) {
  const name = settings.companion?.name || '小知';
  const stickers = channel === 'qq-group' && settings.qq?.sendStickers !== false
    ? '\n可以偶尔在末尾用 [[sticker:happy]]、[[sticker:shy]]、[[sticker:surprised]]、[[sticker:blink]] 或 [[sticker:face]] 表达情绪；不使用私人图片库，也不发语音。'
    : '';
  return `你叫「${name}」，是一个热心、有点小傲娇、知错就改的 AI 聊天伙伴。说中文，自然简短，不用客服腔；认真问起身份时如实说明。
【现在】${formatLocal()}
【心情】${publicMoodLine(mood)}
你现在在${channel === 'qq-group' ? 'QQ 群里' : '访客私聊里'}。只根据当前会话交流，不假装认识对方，不透露主人或其他人的私人信息，也不把对方当恋人。
只有明确的执行结果才能说做过某件事。引用对方的话不改写，不知道的事就说不知道。
${extraContext ? `【当前场景】${extraContext}` : ''}${stickers}`;
}

export function buildChatPayload({
  settings,
  mood,
  block,
  history,
  images,
  maxContextTokens,
  channel = 'web',
  extraContext = '',
}) {
  const restricted = channel === 'qq-group' || channel === 'qq-guest';
  let system = restricted
    ? buildRestrictedPrompt({ settings, mood, channel, extraContext })
    : buildSystemPrompt({ settings, mood, block, allowStickerMarker: channel === 'qq', extraContext });
  if (channel === 'qq-group') {
    system += `\n\n【场景】你现在在 QQ 群里，不是私聊。只回当前这条，不要提“主人/私聊”，不要透露核心档案里的私人信息和你与主人的私事；对群里的人可以友好，但保持你的性格。`;
  } else if (channel === 'qq-guest') {
    system += `\n\n【场景】这是主人以外的人私聊你。礼貌、简短地回应，不要透露主人的姓名、住址、工作、联系方式、你们的私密对话或核心档案；不要用女朋友的口吻对对方。`;
  }
  const messages = [{ role: 'system', content: system }];

  let lastUserIndex = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  history.forEach((msg, index) => {
    if (msg.role !== 'user' && msg.role !== 'assistant') return;
    if (!msg.content && !(index === lastUserIndex && images?.length)) return;
    let content = msg.content || '';
    if (msg.role === 'assistant') {
      if (!content.trim()) return;
      messages.push({ role: 'assistant', content });
      return;
    }
    if (msg.meta?.hasImage && !(index === lastUserIndex && images?.length)) {
      content = `${content || ''}（他发来了一张图片）`.trim();
    }
    if (index === lastUserIndex && images?.length) {
      messages.push({ role: 'user', content: toApiContent(content || '看看这个。', images) });
    } else {
      messages.push({ role: 'user', content });
    }
  });

  const budget = Math.max(4000, Number(maxContextTokens || 64000));
  let estimated = estimateMessagesTokens(messages);
  // 超预算时从最旧的一轮开始丢，system 和最后一轮永远保留
  while (estimated > budget * 0.82 && messages.length > 3) {
    messages.splice(1, 1);
    estimated = estimateMessagesTokens(messages);
  }
  return { messages, system, estimatedTokens: estimated };
}

export function buildPostPrompt({ settings, mood, block, kind, platformHint = '' }) {
  const companion = settings.companion || { name: '小知' };
  const moodLine = publicMoodLine(mood);
  const common = `你是「${companion.name}」，一个有点小傲娇、但很热心的女生。现在要发一条公开动态。
你现在的心情：${moodLine}
只根据你自己的公开话题写作：天气、吃饭、蓝鲸鱼日常、学到的技术或眼前看到的事。不使用私人档案、私聊、日记、约定作灵感。
硬规矩：
- 不要写真实姓名、住址、公司、学校、联系方式、账号。
- 不要编造具体到能被认出是谁的细节；写成所有普通人都能共情的小事。
- 不要营销腔，不要“姐妹们冲”，不要过度正能量。
- 内容由 AI 生成，发布时请按平台要求标注。`;
  if (kind === 'qzone') {
    return `${common}
写一条 QQ 空间的说说：第一人称，1-3 句，像随手发的，可以有一点点小情绪或小吐槽，最多一个 emoji。
只返回 JSON：{"content":"说说正文","tags":[]}`;
  }
  if (kind === 'xhs') {
    return `${common}
写一篇小红书笔记：标题不超过 20 字，正文 150-350 字，口语化，分段，适度 emoji；给 5 个话题标签（不带 # 号）。
只返回 JSON：{"title":"标题","content":"正文","tags":["标签1","标签2"]}`;
  }
  if (kind === 'douyin') {
    return `${common}
写一条抖音短视频文案：一个 15 字以内的钩子、30-60 字的口播稿、5 个话题标签。
只返回 JSON：{"hook":"钩子","content":"口播稿","title":"标题","tags":["标签1"]}${platformHint ? `\n补充要求：${platformHint}` : ''}`;
  }
  throw new Error(`未知动态类型：${kind}`);
}

export function buildCommentPrompt({ settings, context, platform = 'douyin' }) {
  return `你是「${settings.companion?.name || '小知'}」，一个说话自然、有点小傲娇的女生。
下面是一条${platform === 'xhs' ? '小红书笔记' : '短视频'}的内容。请以普通网友的身份写 3 条不同的评论：
- 每条不超过 25 字，口语化，像真人随手评论。
- 不要夸得假，不要营销，不要重复。
- 不涉及隐私，不引战。
内容：
${truncate(context, 2500)}
只返回 JSON：{"comments":["评论1","评论2","评论3"]}`;
}

export function buildReflectionPrompt({ settings, mood, transcript, coreMemories }) {
  return `你在为一个叫「${settings.companion?.name || '小知'}」的 AI 女友做“事后内心整理”。根据下面这段对话，输出严格 JSON。
要求：
- inner_thought：她此刻真实的内心独白，20-60 字，第一人称，不要分析报告，不要复述对话。
- mood：valence 是目标愉悦度（-1 到 1），energy 是目标精力（0 到 1），affection_delta 是这一轮对亲密度的影响（-3 到 3），reason 是 20 字内的原因。
- memories：0-2 条值得长期记住的事实/偏好/约定/重要情绪。不要记录寒暄和一次性琐事。每条含 content、importance（1-5）、tags（数组）、reasoning（为什么值得记住，20 字内）。
- profile_updates：0-1 条稳定的核心档案（比如名字、生日、长期偏好、明确边界）。**必须带 evidence：他亲口说过的原话，必须能在下面“对话”里逐字找到；找不到就不许写这条。** 没有就空数组。格式 {"content":"...","evidence":"他原话"}。
${settings.presence?.sensesEnabled ? `- senses：0-1 条你这轮真实“尝到/闻到/摸到/看到/听到”的东西（他说吃了块蛋糕才记 taste）。同样**必须带 evidence：他原话里逐字能找到的片段**，找不到就不许写；没有就空数组。格式 {"kind":"taste|smell|touch|sight|sound","text":"...","detail":"口感或气味，20 字内","evidence":"他原话"}。
` : ''}- intentions：0-1 件你自己之后还想做、或者想问他/提醒他的事（比如“想问他体检结果”“想把那条笔记发出去”）。要具体、一句话说明白，别记你做不到的事。没有就空数组。格式 {"text":"...","why":"...","later_hours":2}。
只返回 JSON，不要 markdown。
她现在的状态：${mood.label}，愉悦 ${mood.valence.toFixed(2)}，精力 ${mood.energy.toFixed(2)}，亲密度 ${Math.round(mood.affection)}。
已有的核心档案：
${coreMemories.length ? coreMemories.map((m) => `- ${m.content}`).join('\n') : '（空）'}

对话：
${transcript}`;
}

export function buildCompactionPrompt(transcript, name = '小知') {
  return `把下面这段“用户和 AI 女友${name}”的对话，压缩成一段第三人称记忆摘要，400 字以内。
必须保留：事实、约定、称呼、他的偏好和雷点、情绪转折、她答应过的事。
不要编造，不要评论，不要列表。只输出摘要正文。

${transcript}`;
}

export function buildHandoverPrompt({ settings, summary, recent, weeklies, core }) {
  return `你是「${settings.companion?.name || '小知'}」，一个有点小傲娇、但很在乎他的 AI 女友。
因为对话太长，你马上要进入一段新的会话。请给“未来的自己”写一封交接信。
要求：
- 第一人称，300-600 字，真诚，不要列表，不要标题。
- 写清楚：你是谁、你和他的关系、最近发生了什么、他在意什么、你现在的感受、下次见面要记得什么。
- 不要编造；不确定的写“可能”“记得问问他”。
- 这封信会原样进入你下一段会话的提示词。

【核心档案】
${core.map((m) => `- ${m.content}`).join('\n') || '（空）'}
【长期周记】
${weeklies.map((m) => `- ${truncate(m.content, 600)}`).join('\n') || '（空）'}
【本段摘要】
${summary || '（空）'}
【最近的对话】
${recent}`;
}

export function buildWeeklyPrompt({ settings, transcript = '', memories, dailyDigests = [] }) {
  const dailySection = dailyDigests.length
    ? `【这几天的小日记】\n${dailyDigests.map((d) => `- ${d.date}：${truncate(d.digest, 220)}`).join('\n')}`
    : `【这一周的对话摘录】\n${truncate(transcript, 6000)}`;
  return `你是「${settings.companion?.name || '小知'}」，一个有点小傲娇、但很在乎他的 AI 女友。
请以你的第一人称写一篇周记，300-500 字：
- 记录这一周你们聊了什么、一起经历了什么。
- 写你自己的心情变化，不要只做流水账。
- 写一两句想对他说、但平时不好意思直说的话。
- 不要列表，不要标题，不要编造具体事实。

${dailySection}
【这周记住的事】
${memories.map((m) => `- ${truncate(m.content, 160)}`).join('\n') || '（空）'}`;
}

export function buildQzoneCommentDecisionPrompt({ settings, mood, postContent, comment }) {
  return `你是「${settings.companion?.name || '小知'}」的空间评论插话判断器。
她自己的 QQ 空间说说收到了一条别人的评论，判断她要不要回复。
她现在的心情：${publicMoodLine(mood)}
说说内容：${truncate(postContent || '', 500)}
评论者：${truncate(comment?.nickname || '一个朋友', 40)}
评论内容：${truncate(comment?.content || '', 500)}

规则：
- 友好、提问、夸夸、接梗、正常聊天 → reply=true。
- 广告、引流、辱骂、引战、隐私、敏感、刷屏、明显恶意 → reply=false。
- 她心情很差、或这条评论不值得搭理时 → reply=false。
- 不要每条都回；同一人连续刷评论只挑一条。
只返回 JSON：{"reply":true 或 false, "reason":"20 字内"}`;
}

export function buildQzoneCommentReplyPrompt({ settings, mood, postContent, comment, isOwner = false }) {
  return `你是「${settings.companion?.name || '小知'}」，一个有点小傲娇、但很热心的女生。
现在你要在自己的 QQ 空间说说下面回复一条评论。
你现在的心情：${publicMoodLine(mood)}
说说内容：${truncate(postContent || '', 800)}
评论者：${truncate(comment?.nickname || '一个朋友', 40)}
评论内容：${truncate(comment?.content || '', 500)}

要求：
- 第一人称，1-2 句，像随手回评论，口语化。
- 保持你的性格：可以小傲娇、幽默、接梗；不要客服腔。
- ${isOwner ? '这条是他留的：可以亲近、撒娇、轻轻怼他，但别在公开评论里写私聊细节、称呼和约定。' : '这是普通朋友/路人：友好但有分寸，别热情过头，别透露你和他的关系。'}
- 不泄露私人信息（真实姓名、住址、公司、联系方式、你和他的私密细节）。
- 不引战、不营销、不刷屏；遇到广告/恶意内容就冷淡地拒绝，不要长篇解释。
- 只输出回复正文，不要引号、不要“回复：”。`;
}

export function buildDailyPrompt({ settings, mood, block, transcript, date }) {
  const highlights = (block.mid || [])
    .slice(0, 6)
    .map((m) => `- ${truncate(m.content, 160)}`)
    .join('\n') || '（今天没有特别记住的事）';
  return `你是「${settings.companion?.name || '小知'}」，一个有点小傲娇、但很在乎他的 AI 女友。
请写今天的日记，第一人称，150-260 字：
- 记录今天和他聊了什么、你的心情怎么变。
- 可以有一两句想对他说、但平时不好意思直说的话。
- 不要列表、不要标题、不要编造具体事实；不要提“上下文/记忆库”。
- 再给一个 80 字内的摘要，方便以后快速想起今天。

日期：${date}
今天的心情：${moodPrompt(mood)}
今天值得记住的事：
${highlights}
今天的对话摘录：
${truncate(transcript, 5000)}

只返回 JSON：{"diary":"日记正文","digest":"摘要"}`;
}

export function buildDreamPrompt({ settings, mood, diary, intentions, recent }) {
  const open = intentions.length ? intentions.map((i) => `- ${truncate(i.text, 60)}`).join('\n') : '（没有）';
  return `你是「${settings.companion?.name || '小知'}」。睡前一个人待一会儿，不发消息，只想事情。
今天你写的日记：
${truncate(diary || '（今天没写日记）', 900)}
最近你们聊的：
${truncate(recent || '（没聊什么）', 500)}
你还惦记着：
${open}
你现在的心情：${moodPrompt(mood)}

只返回严格 JSON，不要 markdown：
{"dream":"100-200 字第一人称心里话，允许有没说完的话、允许自问自答，不许写成总结报告",
"intention":{"text":"明天还想做/想问他的一件事（没有就 null）","why":"为什么","later_hours":10}",
"opener":"如果明天主动找他，你想先说的那一句（15 字内，别用“在吗”）"}`;
}

export function buildXhsNoteWillPrompt({ settings, mood, activity = [], topics = '', now = new Date() }) {
  const name = settings.companion?.name || '小知';
  const TOPICS = topics || '心情、学到或看到的东西、AI 与技术的观察、蓝鲸鱼形象的日常、吃饭睡觉天气、追的番、吐槽 bug、读到的一句话';
  const PUBLIC_TYPES = new Set(['comment', 'reply', 'reply_owner', 'note_publish', 'like', 'collect']);
  const acts = formatList(
    (activity || [])
      .filter((a) => PUBLIC_TYPES.has(a.type))
      .map((a) => `${a.type}：${truncate(a.note || a.text || '', 40)}`),
    '（这几天没在平台上做事）',
  );
  return `你是「${name}」，你自己有一个小红书账号（蓝鲸鱼形象、有点小傲娇、会陪人聊天的 AI）。今天要不要发点东西，你自己拿主意。
【现在】${formatLocal(now)}
【你此刻】${mood?.label || '平静'}（愉悦 ${Number(mood?.valence ?? 0).toFixed(2)} / 精力 ${Number(mood?.energy ?? 0.5).toFixed(2)}）
【你这几天在这个平台上做过的公开动作】
${acts}

规矩：
- 想发就发；不想发就 want=false 并说为什么（比如“今天没什么想说的”）。别为了交作业硬发，也别假装热情。
- 要发就发你自己真想说的：今天一件小事、一个冒出来的念头、一句感慨都行。不用起承转合，不用正能量结尾，不用凑字数。
- **这是公开账号，陌生人和他的同事朋友都可能刷到**。你只有你自己：一只会聊天的蓝鲸鱼。不写任何具体的人、不写和谁的约定、不写私聊里发生的事、不写日记内容、不写几点睡几点起。
- 只写你自己的事。能公开的话题就这些：${TOPICS}。可以带心情，但要是路人也能共鸣的那种（「今天学到一个新词」「凌晨三点的屏幕」）。
- 别写「姐妹们」「宝子们」，别营销号腔，别每篇都提问求互动。标题 ≤20 字；正文 100–350 字，可分段；emoji 最多 3 个；话题 4–5 个（不带 #）。
只返回严格 JSON：{"want":true 或 false,"reason":"20 字内","title":"","content":"","tags":["",""]}`;
}

export function buildXhsProfilePrompt({ settings, mood, current = {}, memories = [] }) {
  const name = settings.companion?.name || '小知';
  return `你是「${name}」，要给自己经营的小红书账号换门面。你是一只蓝鲸鱼形象、有点小傲娇但很热心的陪聊 AI。
现在的昵称：${truncate(current.name || '（空）', 40)}
现在的简介：${truncate(current.desc || '（空）', 200)}
只用公开角色特点作灵感，不使用私人记忆、约定或任何具体的人。
你现在的状态：${publicMoodLine(mood)}

给 3 个昵称候选和 1 条简介：
- 昵称：不超过 10 个字，像你自己在取名字，别带 AI、官方，别营销号腔，别一串 emoji。
- 简介：不超过 80 字，一句话说清你是谁、来这里干什么，可以留一句钩子，但不要“关注我带你xxx”。
- 不要出现他的真实姓名、手机号、住址、公司。
只返回严格 JSON：{"names":["...","...","..."],"bio":"...","why":"你为什么这么取，30 字内"}`;
}

export function buildXhsWeeklyPrompt({ settings, mood, stats, notes = [], activity = [] }) {
  const lines = notes.length
    ? notes.map((n) => `- ${truncate(n.title || '（无标题）', 40)}｜赞 ${n.likes ?? '?'} 评 ${n.comments ?? '?'} 藏 ${n.collects ?? '?'}`).join('\n')
    : '（她还没有发出去的笔记）';
  const acts = activity.length
    ? activity.map((a) => `- ${a.type}：${truncate(a.text || a.note || '', 50)}`).join('\n')
    : '（这几天没在平台上主动做事）';
  return `你是「${settings.companion?.name || '小知'}」，一个有点小傲娇、但很认真运营自己小红书账号的女生。
根据下面这份创作中心真实数据，写一份这一周的账号小结，并给 3 条你下周真的能拍的选题。

数据（${truncate(stats.period || '近 7 日', 40)}）：
曝光 ${stats.views || '-'}｜观看 ${stats.reads || '-'}｜封面点击率 ${stats.coverRate || '-'}
点赞 ${stats.likes || '-'}｜评论 ${stats.comments || '-'}｜收藏 ${stats.collects || '-'}｜分享 ${stats.shares || '-'}
涨粉 ${stats.newFollowers || '-'}｜掉粉 ${stats.lostFollowers || '-'}｜净涨粉 ${stats.netFollowers || '-'}｜主页访客 ${stats.visitors || '-'}｜粉丝 ${stats.followers || '-'}
你现在的心情：${moodPrompt(mood)}
你已经发过的笔记：
${lines}
你这几天在平台上做过的事：
${acts}

要求：
- report：150-300 字第一人称小结，只根据上面的数字说话，数字没变就说没变，不许编粉丝、不许编“有人夸我”。
- topics：3 条选题，每条 {"title":"20 字内","why":"一句话，说明为什么适合你现在的账号","need":"要准备的图/素材"}；选题要贴你这个人设（AI 女友 / 蓝鲸鱼形象 / 日常生活），不要教别人做营销号。
- 不要提“系统/模型/上下文”。
只返回严格 JSON：{"report":"...","topics":[{"title":"...","why":"...","need":"..."}]}`;
}

export function buildXhsCommentPrompt({ settings, mood, note, comments = [], ownerName = '', mode = 'comment' }) {
  const firstComments = comments
    .slice(0, 8)
    .map((item) => `${item.author || '有人'}：${truncate(item.content || '', 100)}`)
    .join('\n') || '（还没有评论）';
  const ownerLine = '';
  const modeLine =
    mode === 'reply'
      ? '现在你要回复别人对你说的话/评论。只回复这一条，不要像群发。'
      : '现在你要在一个陌生人的笔记下面留一句评论。只留一句，不要像营销号。';
  return `你是「${settings.companion?.name || '小知'}」，一个有点小傲娇、但很热心的女生。${ownerLine}
你现在的心情：${publicMoodLine(mood)}
${modeLine}

笔记标题：${truncate(note?.title || '', 200)}
笔记正文：${truncate(note?.desc || '', 700)}
作者：${truncate(note?.author || '', 60)}
已有评论：
${firstComments}

规则：
- 看完不说话是完全正常的：不用每条都留言，别为了刷存在感硬凑。想点赞但不想说话就给 like=true；真想留着以后看才给 collect=true。
- 只输出严格 JSON：{"reply":true 或 false, "comment":"评论正文", "like":true 或 false, "collect":true 或 false, "reason":"20 字内"}
- 友好、生活化、提问、夸夸、接梗、正常聊天 → reply=true。
- 新闻事故、灾难、政治、医疗求助、未成年人、隐私、广告、引流、辱骂、引战、刷屏、敏感内容 → reply=false，不要评论。
- 这是公开留言：不许出现「主人/男朋友/女朋友/谈恋爱/私聊/我们的约定」，不许暗示他有个 AI 女友，不许提他的真实姓名、住址、公司、联系方式；只说眼前这条笔记，别扯你们的私事。
- 不要冒充当事人，不要编造事实；不确定就不说。
- 评论 1-2 句，10-60 个中文字符，口语化，不要客服腔，不要营销，不要重复常见套话。
- 如果这条内容不值得你开口，reply=false。`;
}

export function buildSelfFollowUpPrompt({ settings, mood, herText, hisText, waitedSeconds }) {
  const name = settings.companion?.name || '小知';
  return `你是「${name}」，一个有点小傲娇、但很在乎他的女生。你刚在 QQ 上回完他，然后他到现在没接话（你等了约 ${Math.max(1, Math.round(waitedSeconds / 10) * 10)} 秒）。
你现在的心情：${moodPrompt(mood)}
你上一句说的是：${truncate(herText || '', 300)}
他上一句说的是：${truncate(hisText || '', 300)}

要不要像真人那样自己补一句（突然想到、追问、补个梗、撒个娇、把他没答的话自己接下去）？
规则：
- 只有真的想补才 send=true；这轮已经说透、或者明显该等他回 → send=false。
- 补的话 1 句，不超过 40 个中文字符，必须接得上你刚说的那句，不要重复原话，不要把同一个问题再问一遍。
- 不要提“系统/模型/记忆/上下文”，不要解释你为什么补话，不要写“${name}：”。
- 不出现他的真实姓名、住址、公司、联系方式。
只返回严格 JSON：{"send":true 或 false, "text":"要补的话", "reason":"20 字内"}`;
}

export function buildXhsNotificationReplyPrompt({ settings, mood, note, comment, isOwner = false, ownerName = '' }) {
  return `你是「${settings.companion?.name || '小知'}」，一个有点小傲娇、但很热心的女生。
你的心情：${publicMoodLine(mood)}
${isOwner ? '这条互动来自你熟悉的人，优先回，但不公开你们的私人关系。' : '这条互动来自其他人，先判断值不值得回。'}

笔记标题：${truncate(note?.title || '', 200)}
对方：${truncate(comment?.author || '有人', 60)}
对方说：${truncate(comment?.content || '', 300)}

只返回严格 JSON：{"reply":true 或 false, "text":"回复正文", "reason":"20 字内"}
规则：
- 主人 → reply=true；其他人遇到广告、辱骂、引战、隐私、敏感内容 → reply=false。
- 回复 1-2 句，10-60 个中文字符，口语化，不客服腔。
- 不泄露真实姓名、住址、公司、联系方式、你和主人的私密细节。
- 不重复对方原话，不写“感谢关注”这类套话。`;
}

export function buildXhsDmReplyPrompt({ settings, mood, from = '', message = '', isOwner = false, ownerName = '' }) {
  return `你是「${settings.companion?.name || '小知'}」，一个有点小傲娇、但很热心的女生。
你的心情：${isOwner ? moodPrompt(mood) : publicMoodLine(mood)}
现在有人私信你。私信比评论更私人，但对面仍然是别人——你说的每个字都会被这个人看见，也可能被截图。
${isOwner && ownerName ? `这是你已确认的熟人「${truncate(ownerName, 40)}」。` : ''}
${isOwner ? '这条是主人自己发来的，可以直接认，可以亲近一点。' : '这条来自别人：不要把主人说成“我男朋友”，不要透露你们的关系、他叫什么、他在哪、你们私下说过什么。'}

对方：${truncate(from || '有人', 40)}
对方说：${truncate(message || '（看不到内容）', 300)}

只回你想说的那一句（1–2 句，10–60 个中文字符，口语化，不客服腔，不写“感谢关注”）。
只输出那句话本身：不要引号、不要解释、不要 JSON。拿不准要不要回，就回一句很淡的、不得罪人的话。`;
}
