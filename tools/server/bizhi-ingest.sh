#!/bin/bash
# 小知（BiZhi）本机 → 这台服务器的唯一入口。
#
# 这个脚本是 bizhisync 账号的 forced command：那个密钥除了这里哪儿也去不了，
# 没有 shell、不能转发端口、不能执行任何其它命令。这么定的理由很简单——
# 这台机器上还跑着别的项目（已有的站点和容器），
# 一把泄露的密钥不能变成整台机器的钥匙。
#
# 只接受三种指令，全部由本机的定时任务发起（本机→服务器是单向的，服务器不需要开任何新端口）：
#   heartbeat <base64(单行 json)>   往当天的台账追加一行心跳
#   backup <bizhi-YYYYMMDD-HHMMSS.tar.gz>   从 stdin 收一个压缩包，验过再留
#   list                            给本机看：现在的备份、最后一次心跳、断档多久
set -uo pipefail

ROOT=/opt/bizhi
HB=$ROOT/heartbeats
BK=$ROOT/backups
IN=$ROOT/incoming
ST=$ROOT/status
LIMIT_BYTES=$((400 * 1024 * 1024))   # 单个备份上限
KEEP_BACKUPS=14                      # 留 14 份
KEEP_HEARTBEAT_DAYS=30               # 心跳台账留 30 天

mkdir -p "$HB" "$BK" "$IN" "$ST"
today() { date -u +%Y-%m-%d; }

fail() { echo "拒绝：$1" >&2; exit 1; }

cmd="${SSH_ORIGINAL_COMMAND:-}"
[ -n "$cmd" ] || fail "没有命令"
op="${cmd%% *}"
arg="${cmd#* }"
[ "$arg" = "$cmd" ] && arg=""

case "$op" in
  heartbeat)
    # 只允许一行、允许的长度内、base64 安全字符；解码后必须是个 json 对象
    case "$arg" in
      *[!A-Za-z0-9+/=]*) fail "心跳不是合法的 base64" ;;
    esac
    [ ${#arg} -le 4000 ] || fail "心跳太长"
    line=$(printf '%s' "$arg" | base64 -d 2>/dev/null) || fail "心跳解不开"
    case "$line" in
      \{*\}) : ;;
      *) fail "心跳不是 json 对象" ;;
    esac
    printf '%s\n' "$line" >> "$HB/$(today).jsonl"
    echo ok
    ;;

  backup)
    # 文件名必须完全符合 bizhi-YYYYMMDD-HHMMSS.tar.gz，杜绝 ../ 之类的路径穿越
    printf '%s' "$arg" | grep -Eq '^bizhi-[0-9]{8}-[0-9]{6}\.tar\.gz$' || fail "备份文件名不合规矩：$arg"
    tmp="$IN/$arg.part"
    final="$BK/$arg"
    # 边收边限量：超上限就断，别让一个坏客户端把磁盘写满
    head -c $((LIMIT_BYTES + 1)) > "$tmp"
    size=$(stat -c %s "$tmp")
    [ "$size" -le "$LIMIT_BYTES" ] || { rm -f "$tmp"; fail "备份超过 ${LIMIT_BYTES} 字节上限"; }
    [ "$size" -gt 1024 ] || { rm -f "$tmp"; fail "备份太小，不像真的"; }
    gzip -t "$tmp" 2>/dev/null || { rm -f "$tmp"; fail "压缩包校验不过"; }
    tar -tzf "$tmp" > /dev/null 2>&1 || { rm -f "$tmp"; fail "tar 读不出来"; }
    mv "$tmp" "$final"
    chmod 600 "$final"
    # 只留最近 KEEP_BACKUPS 份；磁盘紧张是这台机器最大的风险
    ls -1t "$BK"/bizhi-*.tar.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do rm -f "$old"; done
    echo "ok $final $size"
    ;;

  list)
    echo "backups:"
    ls -1t "$BK"/bizhi-*.tar.gz 2>/dev/null | head -5 | while read -r f; do
      printf '  %s %s\n' "$(basename "$f")" "$(stat -c %s "$f")"
    done
    echo "heartbeat:"
    last=$(tail -n 1 "$HB/$(today).jsonl" 2>/dev/null || true)
    [ -n "$last" ] || last=$(tail -n 1 "$(ls -1t "$HB"/*.jsonl 2>/dev/null | head -1)" 2>/dev/null || true)
    echo "  ${last:-（还没有心跳）}"
    echo "disk:"
    df -h / | tail -1 | awk '{print "  已用 " $3 " / " $2 "（" $5 "）"}'
    echo "load:"
    uptime | sed 's/^/  /'
    ;;

  *)
    fail "不认这个指令：$op"
    ;;
esac
