# 后台运行与服务器分工

## Windows

应用、QQ 和 SnowLuma 留在 Windows，继续使用原数据库。Linux 服务器不运行本机 Windows 注入组件，也不新建第二套会话、记忆或预算库。

操作者双击项目目录的 `install-autostart.vbs` 即可一次性启用，全程隐藏 PowerShell。也可在项目目录执行：

```powershell
powershell.exe -NoProfile -File .\tools\install-background.ps1
```

计划任务以当前用户的普通交互登录权限运行，登录 Windows 后启动隐藏的 WScript 包装器及 Node 守护，不弹 PowerShell。任务不保存密码、不提权、不开放端口。已有服务会被观察，不重复启动。主程序仍有数据目录互斥锁。

进程已退出且能确认不存在时才重启，十五分钟最多三次并退避；活进程健康异常、进程权限不可读或身份不明时，只记录待检查，不强杀。重试历史持久化在 data/background-state.json，不能通过重启守护绕过次数上限。守护自身崩溃由隐藏 WScript 包装器按 5/15/45 秒限次拉起，计划任务失败重试作为第二层回退。SnowLuma 恢复前校验固定文件摘要和完整配置，自动注入始终关闭。运行时恢复不自动登录 QQ，也不自动选择任何主号/小号进程；需要重新加载时，由操作者核对实际登录身份。

手动停止 `stop-all.ps1` 会先写入停止标记，防止守护立即拉回服务。重新运行安装命令可解除停止。双击 `remove-autostart.vbs` 可卸载，也可执行：

```powershell
powershell.exe -NoProfile -File .\tools\install-background.ps1 -Remove
```

此前自动审批拒绝代理启动第三方运行时，因此安装启用步骤由操作者执行。代码和策略测试不能代替实机隐藏启动、重启恢复及重启 Windows 验收。已手动启动的高权限运行时可能对普通权限守护不可见，此时保持待检查，不尝试提权或重复运行。

## 服务器

本次只读盘点显示服务器约 4GB 内存，已有模型、语音、管理面板、容器和 API。适合增加低负载运维检查；不增加模型，不迁移活动 SQLite，不重启或修改既有业务，不开放新端口。业务健康接口与已有失败的独立监测单元分别记录，不能把监测失败直接解释成业务宕机。

`deploy/bizhi-host-health.*` 每五分钟生成一次主机指标及固定服务状态快照，报告不含聊天、Cookie、密钥、命令行或环境变量。使用动态低权限用户、只读系统、48MB 内存和 5% CPU 上限，单次超时 30 秒；每日一个快照，仅保留七天。报告在 `/var/lib/bizhi-host-health/latest.json`，不对公网提供访问。

部署仅新增 `/opt/bizhi-ops/server-health.py` 与两个同名前缀 systemd 单元。撤回时先 `systemctl disable --now bizhi-host-health.timer`，再停止对应 oneshot 并删除这两个单元；既有业务服务不受影响。服务器快照不包含业务数据库；如需异地备份，应另行确定数据范围、加密密钥及恢复演练。
