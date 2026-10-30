# 陪伴模式验收（2026-10-31 凌晨）

对应方案：[PRESENCE_PLAN.md](PRESENCE_PLAN.md)。参考视频逐段功能见方案文档开头的对照表。

## 结果

| 检查 | 实际结果 |
|---|---|
| 语法检查 `npm run check` | 115/115 通过 |
| 全量测试 `npm test` | **243 项 / 238 通过 / 0 失败 / 5 跳过**（基线 195/190/0/5，新增 48 条判据，零回归） |
| 原有浏览器端到端 `tests/browser.e2e.js` | **通过，pageErrors=0**（确认新代码没弄坏既有页面） |
| 新增真机端到端 `tests/presence.e2e.js` | **通过，46 秒，pageerror=0，非预期失败请求=0** |
| 变异验证 | 共跑 10 次，8 次按预期变红；2 次为等价变异，逐条如实记录见下 |

## 真机验证到的东西（不是模拟，是实际执行）

- **假摄像头**：`--use-fake-device-for-media-stream` 起流，`videoWidth=1280`，`enumerateDevices` 列出 `fake_device_0`，抓帧 `toDataURL` 出图非黑屏。
- **让她看**：`POST /api/presence/look` → 真实落一条 user+assistant 对话、额度 `cameraToday=1`、`brain.links.look=1`、感官记忆收下 `sight` 一条、去甲肾上腺素出现非零 delta。
- **假麦克风**：浏览器 `AudioContext` 采集 → JS 线性重采样 16k 单声道 → 手写 WAV 头 → 上传 → 本机 SenseVoice 真解码（假设备只出一个标点，界面如实显示「没听出字来」，不假装听到内容）。
- **识别完临时文件**：`presence-tmp` 目录残留 0 个文件。
- **她的声音**：`POST /api/presence/speak` → 服务端 edge-tts 真出 mp3 → `<audio>` 实测 `duration=2.184~2.6s`、`readyState=4`、非暂停。
- **视线跟踪**：在舞台内取两点，`translate3d` 的 x 分量真的从负变正（不是恒 0）。
- **窄屏**：768/390/337 无横向溢出；**并且量出并修掉一个真 bug**——陪伴栅格缺 `≤900px` 断点，390px 下递质条被压成 0 宽（`barW=0`），补断点后 `barW=212 / fillW=95`。
- **交互稳定性**：另一条真 bug——状态每 4 秒轮询会重建快捷表情按钮，导致点击永远落空（Playwright 报 `element is not visible` / 元素被换掉）。改成按内容签名幂等重建，遗忘曲线列表同样处理。
- **桌宠小窗**：`?view=pet` 下导航与读数侧栏 `display:none`，立绘高度 >200px。
- **关开关的实例**：`cameraEnabled:false` 时 `/api/presence/look` 直接 403，不静默。

## 变异验证（把产品改坏，看判据会不会红）

| 改坏的地方 | 结果 |
|---|---|
| 递质关掉也照样影响心情 | 红 ✔ |
| 感官记忆不查证据直接收 | 红 ✔ |
| 遗忘曲线无视开关永远生效 | 红 ✔ |
| 麦克风没开也照收音频 | 红 ✔ |
| 大脑读数写死一个数 | 红 ✔ |
| 每日上限不生效 | 红 ✔ |
| 权限头退回 `camera=()` | 红 ✔ |
| 念话不排队、每次都另起一条链 | 红 ✔ |
| 去掉「同一条消息不重念」的按 id 去重 | **绿——等价变异** |
| 去掉「新台词顶掉旧台词」的 seq 作废 | **绿——等价变异** |

后两条如实记录：真正防止重放历史的机制是**念话串行排队 + 后来的台词覆盖前一条**（去掉排队，判据立刻变红）。按 id 去重和 `seq` 作废在这条端到端流程里观测不到差异——试过用「刷新后念话请求数不变」和「过期后再来一句，多发的合成 ≤4」两种判据去区分，都区分不出（干净态与变异态都是 6 次）。保留这两行是因为它们防的是可预见的长句场景，但**不宣称它们被测试覆盖**。

## 生产切换（含一次自伤事故）

现役实例是用上一轮留下的 `data/node-restart-20261031/` 那套「带账号进程守卫」的启停机制跑的，本轮沿用同一机制，没有换成仓库里的 `start-bizhi-hidden.vbs`（那会绕开守卫）。

- **事故**：我自己新写的轮换脚本里，PowerShell 探针在端口刚释放时会拿到一个空的 `OwningProcess`，`Get-CimInstance` 报「无效查询」是终止错误 → `execFileSync` 抛异常 → 脚本停在「已停旧进程」和「未起新进程」之间，**7788 空了约 3 分钟**。
- **恢复**：改用既有的 `start-node.mjs` 起回来（PID 29808），`/api/health` 200。
- **修工具**：探针改成 `$ErrorActionPreference="SilentlyContinue"` + 丢弃 stderr；脚本默认只做检查，必须显式 `--rotate` 才动进程；每一步失败都打印回退命令。已用只检查模式复跑验证：`ownership verified`、`check-only`、服务未受影响。
- **本机代理坑**：`curl http://127.0.0.1:7788` 会被 mihomo 截走并返回 **502**（不是服务挂了），本地健康检查必须加 `--noproxy '*'`。

切换后的实测验收（对生产实例，不是模拟）：

| 项 | 结果 |
|---|---|
| 监听者归属 | PID 29808 / node.exe / 入口 `src/index.js` / 守卫在位 |
| 登录 + `/api/status` | 200；`mock=false`、Key 已配、心情「懒懒的温柔」、140 条消息、66 条记忆（真实数据完好） |
| `/api/presence/state` | 200；六个开关全部 `false`；大脑读数取到真实值（记忆 66 / 消息 140 / 日记 2 / 周记 1）；人格锚校验 `545109d6abc2`；本机识别就绪 |
| 关闭态的 `/api/presence/look` | 403「摄像头是关的：设置页「陪伴与感官」里打开才能让她看」 |
| 账号进程 | QQ/NapCat/Chrome/Edge **43 → 43，missing=0、added=0**（没有任何进程被杀或被新拉起来） |
| `getMood()` 新增开销 | 实测 0.205 → 0.815 ms/次（+0.61ms）；按 4 秒轮询算占空比 0.046%，不做额外缓存 |

**QQ 仍是断开的**（`/api/status` 报 `qq:danger`）：NapCat 在本机当前就没运行，而这个启动带了「禁止控制 QQ/NapCat/小红书浏览器进程」的守卫（上一轮按你的要求加的，本轮保留）。要恢复 QQ，需要你在场时关掉该守卫或用 `start-all-hidden.vbs` 重新起，再按设置页「用机器人小号重新登录」。

## 稳定性措施与验证

- 零新依赖：`package.json` 依赖未变（只有 `ws` + 可选 `sherpa-onnx-node` + dev `playwright`）。
- 只加不改：新增 `neuro.js / senses.js / brain.js / forgetting.js / presence.js` 五个模块；对既有文件的改动都是"开关关掉时逐字等价"的加法。已用判据钉住两处最危险的：`getMood()` 在递质关闭时与 `getMoodRaw()` 完全一致；遗忘曲线关闭时检索顺序与旧口径逐条一致。
- 心情不会被自我放大：递质只影响读出来的心情，`applyMood` 写库走 `getMoodRaw()`，有判据。
- 新接口全部走既有鉴权（会话 cookie + Origin/CSRF + JSON 内容类型），`hear/look/speak` 进 `EXPENSIVE_API` 互斥锁并吃 20 次/分钟的操作限速；`state/curve` 是只读轮询口，明确**不加锁**（有判据防止误加）。
- 配额分账：控制台念话用 `presence_speak_day`，不抢 QQ 的 `tts.maxPerDay`；且合成失败不计次。
- 清理：`presence_look_day/presence_speak_day` 进 30 天 KV 清扫；`presence-tmp` 超 1 小时的残留由 `maintenance()` 兜底删除。
- 群聊/访客通道拿不到感官记忆与递质段（判据钉住）。

## 没有做或不保证

- 没有做实时视频通话（WebRTC）、Live2D 骨骼跟踪、唇形同步、桌面端打包。
- 没有新增真实 QQ / 小红书 / 空间的公开发送或私信；本轮不触碰这些通道。
- 假麦克风只能证明"链路通"，不能证明真人语音的识别准确率——那属于 `npm run test:local` 的语音往返用例。
- 递质/遗忘曲线/感官记忆这三套内在模型是**表达层**，不是对神经科学的主张；界面上给的是她自己的状态读数，不承诺与人类生理等价。
- 平台页面结构变化、模型幻觉、精确账单仍不能靠本地测试作绝对保证。
