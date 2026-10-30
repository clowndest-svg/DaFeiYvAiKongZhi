# 陪伴模式扩展方案（对齐参考视频）

参考视频（2026-10-31 用户提供，1 分 20 秒）逐段识别到的功能：

| 视频里的点 | 证据 |
| --- | --- |
| 全屏角色 + 右下角桌宠 | 0:00–0:06 女仆蓝鲸鱼立绘 |
| 鼠标视线跟踪 | 0:02「鼠标视线跟踪」字幕 |
| 摄像头选设备 | 0:14–0:22 设置面板 + 设备下拉（VC-005 / OBS Virtual Camera…） |
| 摄像头识别并开口评价 | 0:56–1:04「这是床铺嘛」+ 音频转写实测「哦，这是床啊…」 |
| 麦克风测试 / 文字输入框 / 字幕 / 语音输出 | 0:08–0:38 字幕与底部输入条 |
| 快捷表情词（哼/好/哦/哭/哇/酷） | 0:34 输入框上方 chips |
| 模拟人脑组成（神经元/突触分类计数） | 0:42–0:46「288 兴奋 / 888 记忆 / 106 好奇 / 44 …」 |
| 拟人遗忘曲线（记忆强度 99% / 0.012） | 0:46–0:48 |
| 保证人格永久 | 0:48 |
| 情绪基础＝神经递质/激素（多巴胺·催产素·皮质醇·血清素·去甲肾上腺素） | 0:52 |
| 味蕾记忆（最近尝到：蛋糕＋口感词） | 0:54 |
| 手机端布局 | 1:06–1:14 |
| 视频通话模拟（视频里也标「即将上线」） | 1:16 |

## 稳定性红线（本方案的前提）

1. **零新依赖**：只用浏览器 Web API + 仓库里已有的 `ws`、`node:sqlite`、`sherpa-onnx-node`。不引 Electron、不引 Live2D SDK、不引 ffmpeg。
2. **只加不改**：新模块、新路由、新设置块、新视图。既有 QQ / 小红书 / 空间 / 聊天链路的代码路径不改语义。
3. **默认关**：所有会花钱、会动设备、会改情绪口径的开关默认 `false`。关掉时 `getMood()` 与检索排序必须与改动前逐值一致（有判据钉住）。
4. **不撒谎**：界面上的数字一律来自库里真实计数；取不到就显示「无读数」。视线跟踪/表情是 CSS 层的视差与换图，UI 不写成 Live2D 骨骼。
5. **失败要看得见**：设备被拒、模型没就绪、余额到线、配额用完 → 明确文案 + `addEvent`，不静默跳过。
6. **不越权**：摄像头/麦克风只在 `self` 源放开（`Permissions-Policy`），只在 HTTPS 或 localhost 的安全上下文可用；不可用时功能块自己隐藏并说明原因。
7. 遵守 `tests/settings-contract.test.js`：新增每个设置键都要在 `normalizeSettings` 写同值兜底；`collectSettings` 顶层键与 `default-settings.json` 一一对应；`set*` 控件填一次收一次；`index.html` 不留内联 `style`。

## 落地内容

### A. 神经递质情绪底座 —— `src/neuro.js`（新）
五种递质各一条 `base/tau` 指数松弛曲线，事件给冲量：

| 递质 | base | τ(小时) | 真实触发源 |
| --- | --- | --- | --- |
| 多巴胺 | 0.45 | 3 | 他夸/撒娇词、反思 valence 上涨、小红书发成功 |
| 血清素 | 0.55 | 8 | 昼夜安静时段、反思 valence 温和 |
| 催产素 | 0.40 | 18 | 他回话、亲近称呼、长聊 |
| 皮质醇 | 0.30 | 5 | 主动找他没回、深夜、QQ 断线、余额到线、他语气冲 |
| 去甲肾上腺素 | 0.35 | 1.5 | 新视觉输入（摄像头）、惊叹号、突发问题 |

- 读时积分、写时落 kv（`neuro_state`），**读不写库**，轮询不放大写入。
- `dt` 上限 6 小时、结果 `clamp(0,1)`、非有限值回落 base：任何输入都不出 NaN。
- 全部函数包 `safe()`，neuro 内部异常绝不冒到聊天链路。
- 输出 `tone.valenceBias ∈ [-0.18,0.18]`、`tone.energyBias ∈ [-0.15,0.15]`，按 `presence.neuroStrength` 缩放后加进 `getMood()`；关闭时恒为 0。
- 提示词加【你的身体状态】，只说主导递质的体感，要求不许报数值。

### B. 感官记忆（味蕾等）—— `src/senses.js`（新）
- kv `sensory_memory`，最多 24 条、30 天自动忘；`kind ∈ taste/smell/touch/sight/sound`。
- **证据闸门**（照 `profile_updates` 的成熟做法）：`evidence` 归一化后必须真的出现在他那条原话里，否则拒绝并写 `sense_rejected` 事件——不许她凭空说「我刚吃到蛋糕」。
- 摄像头「让她看」成功后自动记一条 `sight`（来源是她自己刚看到的，不是编的）。
- 提示词加【你的感官记忆】＋「清单里没有就别装」。群聊/访客通道拿不到。

### C. 真实大脑统计 —— `src/brain.js`（新）
不造假数字，口径写死并可测：
- 记忆节点 = `memories` 按 core/mid/long 分层真实计数；对话节点 = `messages` 真实计数。
- 连接（突触）= kv 计数器 `brain_links`，只在**真发生关联**时 +1：检索命中(`touchMemories`)、原话引用(`findQuotedLines`)、压缩、交接、日记、周记、反思写入、小红书活动注入、主动消息取材。
- 情绪构成 = `moods.label` 直方图归到 兴奋/元气/平静/低落/困倦 五类，真实条数。
- 人格锚 = `persona.md` 的 sha256 前 12 位 + 妈妈信是否存在 + 核心档案条数 + 备份份数（真实文件）。
- 遗忘曲线：`strength(importance, use_count, ageDays)` 纯函数，样本取库里真实记忆。
- 任一项没有数据 → 返回 `null`，前端显示「无读数」。

### D. 拟人遗忘曲线（不加列、不迁移）
`memoryStrength(memory, now)` 纯函数：
`halfLife = 12 * (0.5 + importance*0.35) * (1 + min(2, use_count*0.25))` 天，
`strength = exp(-ageDays/halfLife) * (0.4 + importance*0.15) * (1 + min(0.6, use_count*0.05))`。
`presence.forgettingCurve` 开时，`getMemoryBlock` 的相关性打分乘 `strength`；关时打分公式与现在逐字相同。被召回会 `touchMemories` 涨 `use_count` → 半衰期自动变长，这就是「越记越牢」。

### E. 摄像头 / 麦克风 / 真语音 / 字幕（前端 + 3 条新路由）
- `POST /api/presence/hear`：浏览器 `AudioContext` 采集 → JS 线性重采样到 16k 单声道 → 手写 WAV 头 → base64 上传；服务端校验 `RIFF`+16k+mono+16bit、≤2MB，落 `data/presence-tmp/` 临时文件，复用 `transcribeWav()`，`finally` 删除。模型没就绪 → 如实报错。
- `POST /api/presence/look`：抓一帧（复用已有 `compressImage`）→ `companion.reply({images, extraContext})`，走既有队列/成本闸门；每日上限 + 60 秒节流 + 计入 `EXPENSIVE_API` 锁。
- `POST /api/presence/speak`：复用 `synthesizeSpeech()`，独立日配额 `presence.speakDailyMax`，不抢 QQ 的 `tts.maxPerDay`；前端 `<audio>` 播放 + 字幕逐句跟。edge 不可用时回落浏览器 `speechSynthesis` 并标注「系统声音」。
- `GET /api/presence/state`：一次拿 neuro + senses + brain + 配额（只读、不加锁，供 4 秒轮询）。
- 设备不可用（非安全上下文 / 无权限 / 无设备）→ 该区块隐藏并写明原因，不摆假按钮。

### F. 陪伴视图与桌宠小窗（前端）
- 新视图「陪伴」：立绘舞台（`assets/char/*.png` 五张已在仓库，之前从未被 UI 用到）＋鼠标视差/头部朝向＋随机眨眼＋呼吸浮动；表情由她的 `[[sticker:*]]` 与心情驱动换图，交叉淡入。
- 底部：字幕条、快捷表情 chips、摄像头/麦克风/自动念开关、设备下拉。
- 右侧：神经递质条、大脑统计、遗忘曲线画布、感官记忆、人格锚。
- 「视频通话」模式：她的立绘全屏 + 自己的小窗预览 + 语音进/语音出 + 字幕。诚实标注：这是摄像头+语音+字幕的组合，不是实时视频通话协议。
- 桌宠小窗：`window.open('/?view=pet')`，只画立绘+字幕+点一下说话；弹窗被拦时提示允许。
- 手机端沿用现有响应式栅格，新增卡片全部 `min-width:0`，窄屏复测横向溢出为 0。

### G. 设置
新增顶层块 `presence`（13 个键，全部在 `normalizeSettings` 写同值兜底，设置页新增「陪伴与感官」卡片）。

## 验收判据（新增测试）
1. `presence` 关掉时 `getMood()` 与 `getMemoryBlock` 打分与基线逐值一致（变异：把 bias 改成常数 → 红）。
2. neuro 纯函数：dt 钳制、NaN 回落、clamp、同种事件 60 秒节流、未知事件不涨。
3. senses 证据闸门：编造的「蛋糕」被拒且落事件；他真说过的能入库并进提示词；群聊通道拿不到。
4. brain 数字来自库：插一条记忆/改 `use_count` → 对应读数变化；空库 → 全 `null`，界面「无读数」。
5. 三条新路由：未开开关 403、超日配额 429、体积/格式不合法 400、余额到线不给跑；`/api/presence/state` 不在 `EXPENSIVE_GET` 里。
6. `Permissions-Policy` 只放开 `self` 的 camera/microphone，geolocation 仍关。
7. 设置契约三条继续绿（默认值不漂移、collectSettings 键对齐、控件填收成对、无内联 style）。
8. 全量 `npm test` 相对基线（195 项 / 190 通过 / 5 跳过）零回归。

## 不做
- 不引 Electron/Live2D/VRM，不做真·音视频通话协议（WebRTC）——视频里那条也标着「即将上线」。
- 不做多角色换装、不做唇形同步（需要音频对齐与骨骼，稳定性不划算）。
- 不动 QQ / 小红书 / 空间的任何发送与风控逻辑。
