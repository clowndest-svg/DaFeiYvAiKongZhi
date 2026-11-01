# 语音轮验收（2026-10-31）

方案见 [VOICE_PLAN.md](VOICE_PLAN.md)，与 ChatGPT 的四轮对谈及谁改了谁的判断见 [VOICE_REVIEW.md](VOICE_REVIEW.md)。

## 结果

| 检查 | 实际结果 |
|---|---|
| 语法 `npm run check` | 126/126 通过（本轮 +9 个新文件） |
| 全量测试 `npm test` | **296 项 / 291 通过 / 0 失败 / 5 跳过**（上一轮基线 255/250，本轮新增 41 项语音判据） |
| 界面体检 `npm run audit:ui` | 25 组（5 视口 × 5 视图）全部达标，设置页新增四个控件后仍 0 溢出 0 遮挡 0 过小 |
| 新增判据 | voice-style 10 项、voice-call 20 项（含 C01–C12 竞态交叉 + C08b）、voice-off-equivalence 6 项、local-tts 5 项（本机装了权重，真跑用例是绿的，不是跳过） |
| 本地 matcha 中文 TTS 准入实测 | 270 次生成、累计 720 秒音频：2 线程 RTF P50 0.11 / P95 0.14；增量 RSS 192MB；加载 2.8–3.5 秒；输出 22050Hz；系统可用内存最低仍 2.56GB |
| 事件循环 | 单次同步 `generate` 期间 10ms 监测回调 **0 次**触发（132–382ms 全程占用）→ 本地推理必须待在子进程 |
| QQ 端到端（真机） | **未测量** —— NapCat 没在跑，守卫也禁止我拉起它。延迟分段打点已就位，界面显示「未测量」而不是编一个数 |
| 试听对比接口真跑 | 隔离实例 7793：7 个引擎全出声、7 个音频文件落盘，墙钟 6.3 秒。`local-matcha` 给出真实时长 4.47 秒（21 个字），`local-piper` 与所有 edge mp3 如实报 `null`（这台机器没有 mp3 解码器，不拿估算冒充精确时长） |

**跑出来才发现的 bug**：试听名单第一版写成「取目录里前 10 个 zh 音色 + 两个本地引擎」，而 `.slice(0, 10)` 把本地那两个切掉了 —— 界面点了半天，比对里永远没有本地音色。改成显式名单（基线女声 + 差异大的四个 + 两个本地），并复跑到 7/7 出声才算数。这条不是评审出来的，是"能力必须真跑一遍"抓出来的。

**全量跑还抓出一个能带崩主进程的隐患**：`超时` 用例之后有一条 `write EPIPE` 的异步活动冒成 uncaughtException —— 我在子进程已被 kill 之后仍然往它的 stdin 写请求。这在生产里意味着"本地音色出问题可以把整个小知带走"，违反 GPT 的第三条红线。修了两处：`child.stdin.on('error')` 必须接住，写之前检查流还在不在，写失败就当本轮 TTS 失败。修完连跑两遍 5/5 绿、无孤儿 worker。

## 判据标定：五组"故意改坏"，全部变红

自动判据不拿正反样本标定过就不算存在。每改坏一处就跑一次对应用例，然后还原：

| 变异 | 结果 |
|---|---|
| M1 去掉提交点的回合复核（`assertCurrentWork` 里那条 call 检查） | **红 2 条**（C08、C08b）——但这是补强之后才有的，见下 |
| M2 `isCurrent()` 恒为真 | **红 7 条**（C02×3、C05、C09、C10、C12 一类） |
| M3 取消"提交单只结算一次"的保护 | **红 1 条**（C11 迟到 ACK 重复扣额度） |
| M4 让朗读层吃掉阿拉伯数字 | **红 1 条**（"数字被吃掉了"） |
| M5 打开开关就多摇一次随机数（塞进新旧共用的路径） | **红 1 条**："随机数消费次数从 6 变成 8，概率闸门不再等价" |

**标定揪出来两条空判据（这是它真正的价值）**：

1. C08 原来只断言"挂断后 `isCurrent` 为假"，没断言发送被拦住 —— M1 全绿通过，说明"提交点复核"这条保险根本没被覆盖。补了 C08 的发送断言和新的 C08b（作废发生在校验之后）之后 M1 才变红。
2. 关闭态等价判据原来是**两条空轨迹在比**：夹具的入站事件没带 `self_id`，消息在 `handleRaw` 的身份闸门就被丢了，两边都是 0 个发送帧、0 次随机数，所以 M5 打不红。加了正向断言（发送帧 ≥2、轨迹里必须出现桩回复、随机数消费 >0）并补上 `self_id`/`channel.selfId` 之后，基线绿、M5 红。
   这条正是我以前踩过的坑："两边一致"证明不了"两边都真的跑了"。

## 判据钉住了什么

- **过期回合非法提交 = 0**：C05 的两种顺序都跑了真 `OneBotChannel` + 假 ws —— 合成期间新语音到达时，`send_private_msg` 帧数必须为 0，且额度退回；没有新输入时同一回合正常提交恰好一条。
- **提交边界原子性**：`markCommitting` 与真正写 ws 帧之间不留 await；C09 用真的 `channel.generation += 1` 复现"换号后旧回合还想发"，判据是零包。
- **额度四态**：`RESERVED → COMMITTING → CONFIRMED / UNKNOWN / REFUNDED`；C11 验"超时之后迟到 ACK 不能重复扣"（二次结算被拒），C12 验"作废那条要还额度、已提交那条不许当成没发"。
- **关闭态等价（四层）**：同一批消息在 `callEnabled` 开/关下跑两遍，逐条比发送轨迹、比 `Math.random` 消费次数、比定时器个数、比 kv 新增键、比本地 TTS 调用数 —— 全等才绿。
- **朗读文本不改意思**：数字多重集必须相等、否定词只增不减、不许残留 markdown、超长只能整句降级；另加一条"逐字保住正文汉字"的样本级判据（这条抓出了一个真 bug：断句时把窗口中间几个字吞了）。
- **诚实降级**：没装权重时 `localTtsStatus().missing` 报得出缺哪些文件（含 matcha 包里根本没带的 vocos 声码器），`synthesize` 直接拒绝并给出 `npm run tts:install-local`，且此时不 spawn 任何进程。

## 我自己造成的第二次生产事故（已修复）

**经过**：跑新判据时我直接 `node --test tests/xxx.test.js`，绕过了 `tools/test.mjs` 的 `--import=tests/helpers/isolate.mjs` 隔离，于是测试把假 QQ 号写进了**生产 `config/settings.json` 和生产库**。

**实际污染**（对比当天 00:00 的自动备份逐项核出来）：

| 被写坏的东西 | 污染值 | 恢复值 | 依据 |
|---|---|---|---|
| kv `qq_owner_id` | 10000002 | 237\*\*\*\*670（主人号，打码） | 00:00 备份 |
| kv `qq_self_id` | 10000001 | 283\*\*\*\*971（NapCat 登录号，打码） | 00:00 备份 + NapCat 配置文件名 + 空间 feed uin 三处一致 |
| kv `qzone_cookie_bad` | 「NapCat 登录号 283\*\*\*\*971 不是机器人小号 10000001」 | 空 | 生产实例拿假 `botAccount` 去比对，把当天 13:03 还验证通过的 Cookie 误判成失效 |
| kv `qzone_cookie_alert_at` / `checked_at` / `qq_identity_alert_at` | 测试时刻 | 备份值 | 让下一次真实检查重新计时 |
| kv `voice_day:2026-10-31` | 2 | 0 | 当天 00:00 备份里没有这个键，两条都是测试提交计入的 |
| 事件表 **46** 条测试噪声与误报 | id 623→679：`qq_call_tts_error` 16、`qq_call_begin` 10、`qq_call_end` 10、`qq_call_stale` 4、`qq_call_voice` 2、`qq_call_voice_error` 2、`qq_identity_mismatch` 1、`qzone_cookie_expired` 1 | 逐条列出 id 后删除；`qq_down`（QQ 通道真的断了 65 分钟）这类真实事件保留 |
| `settings.qq` 的 `botAccount/sendStickers/selfFollowUp/sleepyMode` | 假号 + 三个 false | 283\*\*\*\*971（NapCat 登录号，打码）+ 三个 true | 02:49 的 file-history 快照 + 三处一致的机器人号证据 |
| `settings.tts` 的 `callEnabled/callDailyMax/callMinIntervalSeconds` | true / 80 / 0 | false / 40 / 8 | 默认值 |

**没有丢东西**：`data/bizhi.db`、`bizhi.db-wal`、`config/settings.json` 三份修复前副本都留在 `data/*.before-repair-1435`；真实消息 144 条、记忆 66 条、群白名单、`companion`（鲸鲸）、`presence.speakReplies=true` 等今天真实改动逐项复核过仍在。有一条消息命中我搜「在干嘛」的关键词，核对后确认是 10-29 主人真实发言，**没有删**。

**根因不是"我下次小心"**：`src/config.js` 现在自己识别测试进程 —— 只要 `NODE_TEST_CONTEXT` 或 `BIZHI_TEST_MODE=1` 成立而没给 `BIZHI_DATA_DIR`，就强制改到 `data/test-isolated-guard-<pid>`，并在 stderr 喊一声，生产文件碰不到。这类"测试能不能碰生产"的门以后应当都长在代码里，而不是靠我记得带环境变量。

**恢复后的生产事实**：`startedPid 13844`（带账号进程守卫），`/api/health` 200，`verify-node` 全绿（`mock=false`、Key 已配、144 消息 / 66 记忆、人格锚一致、QQ/NapCat/Chrome/Edge 进程 41→41 一个没动）。QQ 仍是 `danger`，原因和这轮无关：NapCat 没运行。

## 没有做

- 没做真机 QQ 端到端延迟测量（需要 NapCat 在线，主人点头才能动）。
- 没接云 TTS：连通性只有 401/404 这一层证据，**没有 key 就没验证过任何一个云引擎能不能合成出可播放的音频**，所以代码里没有云引擎的桩，设置里也没有"配了但不通"的假开关。
- 没做 PyTorch 本地克隆（GPT-SoVITS / CosyVoice2 / F5-TTS），没下 Kokoro（350MB，收益未证）。
- 没让本地 Matcha 成为默认引擎：它进的是"默认关闭的可选音色"，取代 edge 需要连续负载 + 真实 QQ 播放 + 盲听三关都过。
- 没做播放中打断、消息撤回、群聊语音、自动唤醒词。
