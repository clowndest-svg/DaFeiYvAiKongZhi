# QQ 自动升级的对账方案（2026-11-03）

## 事实先行（都在这台机器上量到）

- QQ 会自己下载更新包并放进 `安装目录/versions/`。现役装的是 **9.9.28-46928**，而 **9.9.36-53644 的包已经在盘上**（`qqVersions()` 实测），也就是说下次 QQ 重启就会换上，不会先问任何人。
- NapCat 是按 QQ 版本做注入的，QQ 换了版本它不一定跟得上。今天升到的 **v4.18.42** 就是官方最新版（`napcat/.napcat-release` 记着 tag/sha256/备份路径）。
- GitHub 的 API 在这台机器上会**限流**（共享出口 IP，实测直接返回 403 `API rate limit exceeded`）。所以"官方最新版"必须有第二条路：`releases.atom` 订阅源不占 API 限额，实测能拿到 `v4.18.42`。

## 她会做什么

1. **每 12 小时对一次账**（调度器步骤「版本对账」）。上次有任何一项没查到就缩到 2 小时再试，免得 GitHub 抖一下就一整天瞎着。判据在 `versionCheckDue()`，纯函数可单测。
2. **读三处真值**：官方最新版（API→订阅源）、本地装过哪一版（`napcat/.napcat-release`）、QQ 装了哪些版本 / 下了哪些待装包（`versions/` 目录扫描 + 注册表里的 QQ 安装位置）。
3. **说清楚**：结果进 `kv(napcat_versions)` → `/api/status` 与 `/api/qq/setup` → 控制台 QQ 面板逐行列出。查不到的那一项写「未查到/未读到（原因）」，不拿猜测填数。
4. **只在真有东西要跟进时占顶栏**：QQ 已下载待装包 → 一条 warn；NapCat 落后官方 → 一条 info。单纯没查到不报警（那是未测，进面板看）。
5. **断线横幅顺手带一句版本**：只有确实查出 NapCat 落后时才补，避免把无关噪音塞进最要紧的那句话里。
6. **状态一变才记事件**：`qq_pending_update` / `napcat_upgrade_available` / `qq_upgraded`（版本只认往上走，变低多半是回滚，不能报"QQ 自己升到了"）。同一状态重复对账不刷屏，实测两条只记一条。

## 她故意不做什么

装第三方二进制这一步留给人点头——代价大、出问题不容易看出来，而且会顺带把 QQ 关掉。所以她只发现、只说，不动手。

## 一条命令升级

```bash
node tools/upgrade-napcat.mjs --check    # 只查：在用的是哪版、官方最新、QQ 装了什么、有没有待装包
node tools/upgrade-napcat.mjs --apply    # 真升：备份→下载→比大小与 sha256→停 QQ→换文件（保留 config/ cache/）→重启
node tools/upgrade-napcat.mjs --rollback "D:\RuanJian\BiZhi\data\napcat-backup-<时间戳>"
```

`--apply` 的护栏（都在 `tests/napcat-versions.test.js` 里钉着）：

- 先整目录备份，且**备份文件数必须等于现役文件数**，不等就停在备份这一步（现役目录没动）。
- 下载大小要和 GitHub 标的对上；订阅源兜底时拿不到官方大小，就明说「官方大小没取到」，改按包内结构校验（必须有 `napcat.mjs` 与 `NapCatWinBootHook.dll`），不许假装校验过。
- 记下 sha256 进 `.napcat-release`，`.previous` 留上一版记录。
- 新版文件数少于现役一半 → 停手不覆盖；覆盖后必须验证 `config/`、`cache/` 还在。
- 任何一步失败都打印可直接执行的回滚命令。

## 实测证据（2026-11-03 07:01）

- 生产 `/api/status`：`versions.napcatInstalled=v4.18.42`、`napcatLatest=v4.18.42`、`needsUpgrade=false`、`qqInstalled=9.9.28-46928`、`qqPendingUpdate=[9.9.36-53644]`；顶栏只有那一条 `qq-update` warn。
- 事件表只有一条 `qq_pending_update`（第二次手动对账没有重复刷屏）。
- 两次生产轮换后 `qq.connected=true`、同账号实例仍是 1 个（PID 21096），QQ 没被带走、也没多开。
- 判据：`tests/napcat-versions.test.js` 16 条，全量 419 条 0 红；18 条变异全部被抓红。订阅源解析用**当天从 GitHub 取的真实样本**标定（`tests/fixtures/napcat-releases.sample.atom`）——之前那条判据是我凭空写的 `/tags/` 形态，代码跟着样本一起错、两边自洽却永远读不到版本号，真机第一次跑就暴露了。

## 还没做的

- QQ 自身的自动更新没关（关它要动 QQ 的设置项）。现在的策略是"它会升，我盯着并说清楚"。想彻底不让它自己升，得另外查它的更新开关落在哪个配置里。
- `--apply` 的真链路（下载/解压/换文件/重启）还没跑过第二次：今天那次是手工做的，脚本把它固化了，但没有再真跑一遍。所以判据只钉得住"该做的检查写在代码里"。
