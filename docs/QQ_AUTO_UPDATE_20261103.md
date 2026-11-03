# QQ 自动升级、桌面通知与 NapCat 启动（2026-11-03）

## 一、事实（都在这台机器上量到）

- QQ 会自己把新版本包下载进 `安装目录/versions/`。现役装的是 **9.9.28-46928**，盘上还躺着一个 **9.9.36-53644.zip（1.14 GB，10/16 下的）**。
- 换不换由 `versions/config.json` 的 `readyVersion` 决定；实测它一直是空字符串（10/30 那次开机也没应用），但 QQ 联网 + 腾讯云控随时可能把它写上。
- **没有官方关闭途径**：安装目录里没有 update/upgrade 程序（热更新是顶层 QQ.exe 读那两个 JSON 做的），注册表 `HKCU\Software\Tencent\QQNT` 只有一个 `version` 值，`%APPDATA%\QQ\Preferences` 里没有更新字段；QQ 设置界面那个勾选框只管"自动下载并安装"，值藏在 Partitions 的库里，且服务端可以强制。
- NapCat 官方 v4.18.42 的发布说明里**一个 QQ 版本号都没写**，`guide/boot/Shell` 那页兼容说明也没写支持哪些 QQ 版本 —— 所以"9.9.36 会不会打坏 NapCat"我们没有依据，只报版本、不报结论。
- GitHub API 在这台机器（共享出口 IP）会 403 限流；`releases.atom` 订阅源不占限额，实测能拿到 `v4.18.42`。

## 二、她每 12 小时做的对账

`src/napcat-versions.js`：官方最新版（API→订阅源兜底）+ 本地装过哪版（`napcat/.napcat-release`）+ QQ 的 versions 目录（已装、待装、**已扣住**、`readyVersion`）。结果进 `kv(napcat_versions)` → `/api/status`、`/api/qq/setup` → 控制台 QQ 面板。

- 任一项查不到就写"未查到/未读到（原因）"，`curVersion`/`readyVersion` 读不到是 `null`（未读到），不和"确实空着"混成一个空串。
- 顶栏只在**真有需要跟进**时才占一条：`needsUpgrade !== true` 就不报（QQ 有包但 NapCat 已是最新 → 只写面板）。
- 事件只报状态变化：`qq_pending_update` / `napcat_upgrade_available` / `qq_upgraded`（只认版本往上走，变低多半是回滚，报"QQ 自己升到了"就是假消息）。实测两条重复对账只记一条。
- 上次有任何一项没查到，下次间隔缩到 2 小时，免得 GitHub 抖一下就一整天瞎着。

## 三、扣住 QQ 的待装包（可逆）

```bash
node tools/hold-qq-update.mjs --show       # 只读
node tools/hold-qq-update.mjs --hold       # 把 versions/<新版本>.zip 改名成 .zip.held-<时间戳>
node tools/hold-qq-update.mjs --release    # 改回原名（放行）
```

2026-11-03 已执行 `--hold`，扣住 9.9.36-53644（复核：待装 无｜已扣住 9.9.36-53644，对账报告同步刷新）。

说清楚做不到的部分：**扣住不等于关掉更新**。改名只是让这一次启动没包可解，QQ 联网后云控可能重下一个新的；所以她的做法是每次对账重新看一遍，真换上去了立刻报 `qq_upgraded` 并把版本对比塞进断线横幅。改的是文件名（不删文件、不动 ACL、不动注册表），一条命令可回退；登录态在 `%APPDATA%\QQ\auth\login.enc`，与 versions 目录无关，所以不会因此掉登录。

## 四、升级 NapCat：一条命令，但由你点头

```bash
node tools/upgrade-napcat.mjs --check
node tools/upgrade-napcat.mjs --apply
node tools/upgrade-napcat.mjs --rollback "D:\RuanJian\BiZhi\data\napcat-backup-<时间戳>"
```

`--apply` 今天真跑过一次（v4.18.42 重装 v4.18.42，验证脚本本身）：备份 759 个文件/112 MB → 下载 34.3 MB，sha256 `02e5ff0f…82829d` **和手工那次记的完全一致** → 按显式 PID 退掉机器人小号的 QQ（taskkill /PID，绝不按名字杀）→ 换 684 个文件（合并后 694，`config/`、`cache/` 原样）→ 重新拉起。护栏：备份文件数不齐就停在备份、大小对不上不装（订阅源兜底时拿不到官方大小就明说"官方大小没取到"，改按包内结构校验）、新版少一半不覆盖、覆盖后必须验证两个保留目录还在、每步失败都打印可直接执行的回滚命令。

## 五、桌面通知：改成服务端弹 Windows 气泡

原来那条是浏览器原生 `Notification`：要控制台页面开着**且可见**（`liveRefresh` 在 `document.hidden` 时直接 return），还要在那个浏览器里点过一次权限——而他需要知道的恰恰是人不在电脑前的时候。现在：

- `src/notify.js` 用隐藏窗口的 powershell 弹系统气泡（NotifyIcon 气球提示）。进程守卫禁 wscript/cscript，但 powershell 不在禁列，这条路可用。
- 三条触发：**断了 ≥5 分钟**、**发现刚生成的登录二维码（要扫码）**、**断了 ≥10 分钟她自己恢复不了**。每件事按状态指纹只弹一次（同一次断连不每分钟弹）。
- 失败要看得见：弹不成写事件 `qq_notify_failed` 并把 powershell 退出码/错误存进 `kv(qq_desktop_notify)`，面板写"上次自检没弹成（原因）"；而且**不记进"已通知"台账**，否则下次真断了就再也不弹。
- 诚实边界：我们能证明的是"命令成功退出（实测 `ok:true, exitCode:0`）"，看不到屏幕就确认不了气泡真冒出来了。所以设置页留了「测试桌面通知」，点一下 3 秒内见分晓。
- 想关掉：`POST /api/qq/notify/toggle {on:false}`（设置项 `qq.desktopNotify`，默认开——他 2026-11-03 明确要开）。

## 六、NapCat 启动路线（这次推翻了旧结论）

- 实测 `detached: true`（哪怕 windowsHide + stdio 落文件）会让 **QQ.exe 自己新建一个可见控制台**：窗口类名 `ConsoleWindowClass`、标题就是 `D:\RuanJian\qq\QQ.exe`。仓库里那条老判据是对的。
- `wscript + .vbs` 那条路（本意是"既隐藏又脱离进程树"）**实测什么都不启动**：命令行里的引号在 VBScript 里要套两层，只套一层时字符串在中途被截断，wscript 静默失败、日志里一行都没有；而它一旦"没被观察到成功"，代码就会走保底**再起一个**——同账号堆到 8 个实例、互相挤下线，就是这么来的。vbs 生成器和守卫为它开的口子都已删掉（wscript 重新全禁）。
- 现在：`detached: false` + `windowsHide: true` + stdio 落文件（继承我们那个隐藏控制台，实测可见控制台 0 个）；**整个函数只 spawn 一次**；成功信号是"机器人小号的 QQ 根实例出现了"（不是看启动器——它注入完就自己退出）；20 秒等不到就如实返回失败并记日志，绝不重试第二次。
- "活过部署"不需要 detach：启动器自己退出后 QQ 就成了孤儿进程，`taskkill /T` 从我们这边够不到它。轮换脚本现在把这件事变成真检查（`napcat-survival: qqBefore/qqAfter/qqKept`），实测 `qqKept: true`；顺带修掉了"启动器退出手动算一次失败"的假红。

## 七、判据与实测数字

- 新增/重写判据：`tests/napcat-versions.test.js` 20 条、`tests/qq-desktop-notify.test.js` 6 条、`tests/qq-recovery.test.js` 加了启动形状与导出齐全两条。全量 **430 条 / 425 过 / 0 红 / 5 跳过**；界面体检 **30 组全部达标**。
- 变异标定：这批共 **24 条变异全部被抓红**。其中三条是判据自己不够严被抓出来的——`listOwned('napcat').length` 在守卫里也出现（宽松断言被顶掉）、`logger.warn` 只要出现一次就算过、以及订阅源解析最初用的是我**凭空写的样本**（代码跟着样本一起错，真机第一次跑就报"未查到"，现在改成当天真实响应 `tests/fixtures/napcat-releases.sample.atom`）。
- 我这次还写坏过两次产品代码并被测试逮住：删 vbs 时连带删了 `listBotQqRoots`/`shouldStartNapCat`（全量测试没红，因为测试里不真起进程 → 已补一条"导出必须齐"的判据）。

## 八、现在要他做的一件事

**扫一次码。** 重装 NapCat + 反复强退之后，小号 QQ 这次没能快速登录：NapCat 在 `15:55` 报出二维码（`napcat/cache/qrcode.png`），控制台顶栏现在挂着"她在等你扫码"。用手机 QQ（必须登录的是机器人小号）扫控制台里的码即可；扫之前她不会去动 NapCat。
