# 用你自己的服务器做异地备份（可选）

> 不需要服务器也能用：默认「只备份在本电脑」，数据库自动保留 7 份快照。本文只在你想把备份放到另一台 Linux 服务器时使用。

## 1. 在控制台选模式

设置 →「界面与系统」→ 异机哨兵 → 备份方式选「备份到自己的服务器」，填服务器地址、SSH 用户名、本机私钥路径，保存。卡片会显示上次报平安/存档时间和健康状态；不选服务器时这些字段自动隐藏。

## 2. 服务器准备（一次性）

在服务器上以 root 执行仓库里的安装脚本（幂等，只动 `/opt/bizhi`、一个专用账号和一条 cron，不碰其他服务）：

```bash
bash tools/server/install-sentinel.sh
```

它会创建无 shell 权限、`ssh` 时只能执行接收脚本的账号 `bizhisync`，并生成专用密钥。把对应私钥下载回本机，路径填进控制台。

## 3. 验证

- 控制台点「现在就报一次」→ 状态显示上次报平安时间；
- 点「现在就存一份」→ 显示存档大小；
- 服务器上 `ls /opt/bizhi/backups` 能看到新文件。

## 4. 健康检查（可选）

仓库自带 `tools/server-health.py`，每 5 分钟输出只读 JSON（内存/磁盘/负载/服务状态）。部署：

```bash
install -m 755 tools/server-health.py /opt/bizhi-ops/server-health.py
```

systemd 单元里用环境变量指定要监控的服务名，例如：

```
Environment=BIZHI_HEALTH_SERVICES=sshd,docker
```

## 5. 安全与回滚

- 私钥只存本机，`data/sentinel/` 已被 git 忽略；不要提交。
- 连接是单向的：本机 → 服务器；服务器端不跑常驻进程、不开新端口。
- 回滚：控制台切回「只备份在本电脑」即可停止一切远程发送；服务器端删除 `/opt/bizhi` 与 `bizhisync` 账号、卸载 cron 即完全移除。
