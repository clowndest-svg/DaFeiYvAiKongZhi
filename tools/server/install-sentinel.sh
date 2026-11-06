#!/bin/bash
# 在这台服务器上装"小知的哨兵接收端"。幂等：重复跑只会把脚本刷成新版本，不会改动别的服务。
#
# 只动这四样，都不碰现有项目（轻塑 / douyin-tool / 1Panel / docker）：
#   1) /opt/bizhi 目录树（独立目录，权限 700，属主是新加的受限账号）
#   2) /usr/local/sbin/bizhi-ingest（接收脚本）
#   3) 一个没有 shell、只能跑那一个脚本的账号 bizhisync + 它的专用密钥
#   4) 一条清理用的 cron（只删 /opt/bizhi 下面自己的旧文件）
set -euo pipefail

ROOT=/opt/bizhi
USER_NAME=bizhisync
SCRIPT=/usr/local/sbin/bizhi-ingest
SRC="$(dirname "$0")/bizhi-ingest.sh"
[ -f "$SRC" ] || { echo "找不到 $SRC"; exit 1; }

install -m 755 "$SRC" "$SCRIPT"

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --home-dir "$ROOT" --shell /sbin/nologin "$USER_NAME"
fi

# 这个账号的 shell 就是接收脚本本身：就算客户端不带命令、或者绕开 forced command 乱请求，
# 能跑起来的也只有这一个脚本（它不认识的一律拒绝）。用 nologin 反而更糟——
# 那种情况下 sshd 连 forced command 都不执行，只回一句 "account is currently not available"。
usermod -s "$SCRIPT" "$USER_NAME"

mkdir -p "$ROOT/backups" "$ROOT/incoming" "$ROOT/heartbeats" "$ROOT/status" "$ROOT/.ssh"
chmod 700 "$ROOT" "$ROOT/backups" "$ROOT/incoming" "$ROOT/heartbeats" "$ROOT/status" "$ROOT/.ssh"

KEY="$ROOT/.ssh/id_bizhi_sentinel"
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N '' -C 'bizhi-sentinel' -f "$KEY" >/dev/null
  echo "=== 新密钥私钥（只打印这一次，请存到本机 data/sentinel/ 里，不要提交进仓库） ==="
  cat "$KEY"
  echo "=== 以上是私钥 ==="
fi
chmod 600 "$KEY"

# forced command：这把密钥只能调用那一个脚本，且禁止各种转发
PUB=$(cat "$KEY.pub")
{
  echo "command=\"$SCRIPT\",no-agent-forwarding,no-X11-forwarding,no-port-forwarding,no-user-rc,restrict $PUB"
} > "$ROOT/.ssh/authorized_keys"
chmod 600 "$ROOT/.ssh/authorized_keys"
chown -R "$USER_NAME:$USER_NAME" "$ROOT"

# 心跳和备份都留久了会吃磁盘——这台机器 40G，只给自己划一条明确的清理线
if ! crontab -l -u "$USER_NAME" 2>/dev/null | grep -q bizhi-prune; then
  {
    crontab -l -u "$USER_NAME" 2>/dev/null || true
    echo '# bizhi-prune：只清 /opt/bizhi 自己的旧数据，不碰任何别的服务'
    echo '30 4 * * * find /opt/bizhi/heartbeats -name "*.jsonl" -mtime +30 -delete'
    echo '35 4 * * * ls -1t /opt/bizhi/backups/bizhi-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f'
    echo '40 4 * * * find /opt/bizhi/incoming -name "*.part" -mmin +60 -delete'
  } | crontab -u "$USER_NAME" -
fi

echo "装好了：$SCRIPT / 账号 $USER_NAME / 目录 $ROOT"
ls -ld "$ROOT" && id "$USER_NAME"
