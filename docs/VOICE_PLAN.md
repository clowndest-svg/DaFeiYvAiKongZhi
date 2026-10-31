# 语音方案：QQ「打语音」与去机器感（2026-10-31）

外部评审来自 ChatGPT 四轮对谈（内置浏览器逐轮反驳）。**它的第一版有六条被我用实测或源码推翻或改写**，最终定稿见文末裁决表；全过程记录在 [VOICE_REVIEW.md](VOICE_REVIEW.md)。

## 0. 先说清楚做不到的事

OneBot v11 和 NapCat 都没有语音通话（VoIP/RTC）动作，只有 `record` 语音消息段（全仓库搜 voip/rtc/WebRTC 零命中）。她能做到的极限是：

- 你连发语音，她把相邻几条并成一个回合再回；
- 你发新语音时，**还没提交发送的旧回答会被作废**；
- 已经提交给 NapCat 的那条**收不回来**，她也不知道你有没有在播、播到哪。

所以这不是"电话"，是**可打断的异步语音会话**。界面和文档不许写成实时通话。

## 1. 本机实测（不是估计）

| 项 | 实测值 | 方法 |
|---|---|---|
| edge-tts 可调参数 | 只有 voice/rate/volume/pitch，无 SSML/style | `voice/pyenv` 里 `python -m edge_tts --help` |
| zh 音色目录 | 目录内 12 项（8 个 zh-CN + 台/港 + local-piper） | `--list-voices` |
| 云 TTS 端点 | 阿里 401 / 火山 404 / MiniMax 404 / 讯飞 404 —— 只是可达，没有 key 就没验证过能力 | HEAD 探测 |
| 本机内存 / 显存 | 空闲 3.36GB；GTX1650 4GB 已占 1.33GB | PowerShell + nvidia-smi |
| GitHub 下行 | 1.33–2.4 MB/s（matcha 75MB 实测 30 秒下完） | 真实下载计时 |
| 本地 matcha 中文 TTS | 加载 2.8–3.5s；RTF P50 0.11 / P95 0.14（2 线程，270 次生成、720 秒音频）；增量 RSS 192MB；输出 22050Hz | `data/local-tts-trial/bench.json` |
| 同步 generate 是否阻塞主线程 | **是**：单次 132–382ms 全程占用，10ms 监测回调 0 次触发 | `data/local-tts-trial/loopblock.out` |

结论：GPT 最初"本地 TTS 一律否决"只覆盖了 PyTorch 克隆路线；已装的 `sherpa-onnx-node` 导出 `OfflineTts`（vits/matcha/kokoro/zipvoice），零新依赖、纯 CPU、离线、不占显存，**这台机器跑得动**——它据此撤回了原判断。但原生推理必须待在子进程里。

许可提醒：`matcha-icefall-zh-baker` 的训练集 data-baker **仅供非商业使用**，所以它只能作为个人自用的可选引擎，不许进任何对外交付包。

## 2. 协议与现状缺陷（源码定位）

| 现状 | 位置 | 问题 |
|---|---|---|
| 发语音决策 | [src/channels/onebot.js:1041](../src/channels/onebot.js#L1041) | 18% 概率闸门 + 只回 ≤60 字，撑不起连续对话 |
| 每日额度 | `voiceBudgetLeft` 同文件 | 只有一个日计数（默认 8），没有会话额度、没有最小间隔 |
| 输入聚合 | 同文件 496–518 | 已有 2200ms 防抖，但**每条消息都重置定时器 → 连发可以无限推迟 flush** |
| 作废机制 | `assertCurrentWork` 同文件 1407 | 只校验账号 generation，没有回合概念 |
| 朗读文本 | [src/tts.js:166](../src/tts.js#L166) | 只压空格 + 截断；书面长句直接进 TTS，截断还可能改意思 |
| 音频校验 | `sendRecordToTarget` | 时长/格式完全不检查，mp3 盲丢给 NapCat |

## 3. 定稿设计

### 3.1 语音会话（`src/voice-call.js`，默认关）

- 进入：主人私聊发 `/语音聊天`（或"打语音"）；退出：`/挂断`、`/退出语音`、空闲 120 秒、累计 8 分钟、通道断线、重启不恢复。
- **作废发生在消息入站时，不是 flush 时**：新语音到达立刻抬高 `currentTurnGeneration`，旧回合的 ASR/LLM/TTS 结果不许进入发送链。
- 每回合一个 `Object.freeze` 的 scope 快照 `{sessionId, turnGeneration, accountGeneration, ownerId}`，复用现有那一个 `AsyncLocalStorage` 实例，不再新建第二个；`assertCurrentWork` 加一级"有 sessionId 才校验回合"，**旧路径不带 sessionId 时行为不变**。
- 账号世代与回合世代是两个独立计数器，不合并成一个数字。
- 聚合窗口沿用 2200ms；会话模式下追加 `firstMessageAt + 5000ms` 的硬上限，防止连发饿死 flush。关闭时这条不生效（逐字等价）。
- 发送边界：最后一次校验与实际提交之间不许有 `await`；提交后状态只能进 `CONFIRMED / UNKNOWN`，**UNKNOWN 不许自动重发**，也不许返还额度。
- 预算：`RESERVED → COMMITTED → CONFIRMED/UNKNOWN/REFUNDED`，跨进程重启从 kv 恢复。普通散发仍受 `tts.maxPerDay`（默认 8）约束；会话单场 12 条；账号每日语音总量 40 条；两次语音提交之间最小间隔 8 秒。三个计数（单场 / 当日总 / 当日散发）都在同一裁决点检查。
- 慢回合反馈：语音超 5 秒仍未提交时，发**一次**文字"收到你的语音啦，等我一下。"——只声明收到了，不假装听懂；不计语音额度，但计入消息总预算；挂断则定时器立刻失效。触发率长期 >30% 说明是链路慢而不是偶发，要先查耗时而不是调阈值。

### 3.2 去机器感（分三层，前两层零依赖）

1. **朗读文本层**（`src/voice-style.js`，确定性规则，不加第二次 LLM 调用）：剥 markdown / emoji / 链接语法但保留文字；把超过 28 字的句子**只插入标点**断成短句；不注入"嗯/那个"这类假口头禅（固定频率插入会变成另一种机器感）；超长按整句降级为文字，**绝不中段截断**。安全底线：数字集合不变、否定词不许丢、专有名词与时间原样保留 —— 这些是判据，不是愿望。
2. **韵律层**：语音会话里让 DeepSeek 直接产出 25–45 字的口语短句（走现成的 `extraContext`），会话模式跳过 18% 概率闸门；`rate/pitch` 原有的小幅心情抖动保留但设边界，另加 `--volume`（默认空 → 不传 → 命令行逐字不变）。
3. **引擎层**：音色目录加两项 `local-matcha`（可选、需本机下过权重）与既有 `local-piper`；`tts.voice` 选了谁就先走谁，失败按原链回退 edge → piper → SAPI。

**自然度不由我断言**。做法是 `POST /api/voice/compare`：同一句文本喂给候选音色的全部若干引擎，控制台并排试听，用户点"就用这个"写回 `tts.voice`。GPT 要求的两轮分离实验（先同文本比模型、再同模型比文本处理）就是靠这个界面完成的——文本固定，所以差异只可能来自引擎。

## 4. 判据

| 判据 | 覆盖 |
|---|---|
| 12 组确定性竞态交叉 C01–C12（含"校验成功→新语音插入→提交"这种情况 B，和超时后迟到 ACK、额度只剩 1 时作废） | 过期回合非法提交次数 = 0；假时钟 + 注入延迟，不靠随机跑次数 |
| 关闭态等价：调用数量 + 调用轨迹 + 外部副作用（QQ/ws/fs/子进程）+ 最终状态四层全比 | 且静态约束：关闭时不得 new OfflineTts、不得 spawn、不得注册会话专属 timer/listener |
| 朗读文本语义安全 | 数字多重集相等、否定词计数不减、无 markdown 残留、超长走整句降级 |
| 本地引擎门禁 | 无权重时如实报"未安装"并跳过，不打桩；worker 崩溃只让本轮失败，主服务不受影响 |

不做：PyTorch 本地克隆常驻、Kokoro（350MB，收益未知）、每轮固定占位文字、把一条长回答拆成多条语音、为"自然"人为插入随机等待。
