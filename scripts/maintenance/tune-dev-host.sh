#!/usr/bin/env bash
# 🍞 AI Breadcrumb — @COUPLED docs/DEV-HOST-TUNING.md（同一份操作的程序化版本）
# @WHY 手工多行粘贴在这台机器上会只执行一部分行（实测：chmod 生效、sed/mkswap/swapon 没跑），
#   于是把两项需要 root 的宿主机调优写成幂等脚本：默认 dry-run，--apply 才动系统，每步自带验证。
# @GOTCHA nginx 1.18 不支持 `http2 on;`（需 ≥1.25.1）；`sed -i` 打 sites-enabled 的 symlink 会把
#   链接替换成普通文件 → 这里只改 sites-available 本体 + --follow-symlinks。
# @CONTRACT 只做两件事：nginx 开 HTTP/2、加/撤 4GB swap。不重启服务（只 reload nginx）。
# 📖 docs/DEV-HOST-TUNING.md
set -uo pipefail

NGINX_CONF="${NGINX_CONF:-/etc/nginx/sites-available/pi-dev-dev.ftai.cc}"
SWAPFILE="${SWAPFILE:-/swapfile}"
SWAP_SIZE="${SWAP_SIZE:-4G}"
SYSCTL_CONF=/etc/sysctl.d/90-pi-dev-swap.conf
NGINX_BIN=$(command -v nginx || echo /usr/sbin/nginx)

APPLY=0
UNDO_SWAP=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --undo-swap) UNDO_SWAP=1; APPLY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（可用：--apply / --undo-swap / --help）" >&2; exit 2 ;;
  esac
done

if [ "$APPLY" = 1 ] && [ "$(id -u)" != 0 ]; then
  echo "FAIL: --apply 需要 root（当前 uid=$(id -u)）" >&2
  exit 1
fi

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
run() { if [ "$APPLY" = 1 ]; then "$@"; else say "  [dry-run] $*"; fi; }

FAILED=0
noteable() { FAILED=1; say "  ✗ $*"; }

say "模式：$( [ "$APPLY" = 1 ] && echo 'APPLY（会改系统）' || echo 'dry-run（只打印将做什么）' )"
say "nginx 配置：$NGINX_CONF"
say "swapfile：$SWAPFILE（$SWAP_SIZE）"

# ── 1. nginx HTTP/2 ─────────────────────────────────────────────────────────
step "1/2 nginx HTTP/2"

if [ ! -f "$NGINX_CONF" ]; then
  noteable "找不到 $NGINX_CONF"
else
  VER=$("$NGINX_BIN" -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')
  say "  nginx 版本：${VER:-未知}"
  # 版本比较：>= 1.25.1 用 `http2 on;`，否则用 listen 参数形态（1.9.5+）
  use_on_directive=0
  if [ -n "$VER" ]; then
    IFS=. read -r maj min patch <<<"$VER"
    if [ "${maj:-0}" -gt 1 ] || { [ "${maj:-0}" -eq 1 ] && [ "${min:-0}" -gt 25 ]; } \
      || { [ "${maj:-0}" -eq 1 ] && [ "${min:-0}" -eq 25 ] && [ "${patch:-0}" -ge 1 ]; }; then
      use_on_directive=1
    fi
  fi

  if grep -qE '^[[:space:]]*(listen[^;]*http2|http2[[:space:]]+on;)' "$NGINX_CONF"; then
    say "  已经是 HTTP/2 形态，跳过改写"
  else
    TMP=$(mktemp)
    if [ "$use_on_directive" = 1 ]; then
      say "  写法：server 块加一行 \`http2 on;\`（≥1.25.1）"
      # 在第一个 server 块的 listen 443 之后插入，避免重复插入
      awk '{print} /^[[:space:]]*listen[^;]*443[^;]*ssl[^;]*;/ && !done {print "    http2 on;"; done=1}' \
        "$NGINX_CONF" > "$TMP"
    else
      say "  写法：把 443 的两条 listen 改成 listen … http2;（1.9.5–1.25.0）"
      sed --follow-symlinks \
        -e 's/^\([[:space:]]*\)listen 443 ssl;/\1listen 443 ssl http2;/' \
        -e 's/^\([[:space:]]*\)listen \[::\]:443 ssl ipv6only=on;/\1listen [::]:443 ssl ipv6only=on http2;/' \
        "$NGINX_CONF" > "$TMP"
    fi
    say "  改动预览："
    diff -u "$NGINX_CONF" "$TMP" | sed 's/^/    /' || true
    if [ "$APPLY" = 1 ]; then
      cp "$NGINX_CONF" "/root/pi-dev-nginx-$(date +%F-%H%M%S).bak"
      cat "$TMP" > "$NGINX_CONF"
      say "  已改（备份在 /root/pi-dev-nginx-*.bak）"
    fi
    rm -f "$TMP"
  fi

  if [ "$APPLY" = 1 ]; then
    if "$NGINX_BIN" -t 2>&1 | sed 's/^/    /'; then
      systemctl reload nginx && say "  nginx reload 完成"
    else
      noteable "nginx -t 失败 → 已**不** reload（配置保持原样，服务未受影响）"
    fi
  else
    say "  [dry-run] $NGINX_BIN -t && systemctl reload nginx"
  fi
fi

# ── 2. swap ────────────────────────────────────────────────────────────────
step "2/2 swap"

if [ "$UNDO_SWAP" = 1 ]; then
  if /sbin/swapon --show=NAME 2>/dev/null | grep -qx "$SWAPFILE"; then
    run /sbin/swapoff "$SWAPFILE" && say "  已 swapoff"
  fi
  [ -f "$SWAPFILE" ] && run rm -f "$SWAPFILE" && say "  已删除 $SWAPFILE"
  run sed -i "\\#^$SWAPFILE #d" /etc/fstab
  say "  已撤销（swappiness 配置文件保留：$SYSCTL_CONF）"
else
  active=$(/sbin/swapon --show=NAME 2>/dev/null | grep -c "^$SWAPFILE$")
  if [ "$active" = 1 ]; then
    say "  已是启用的 swap，跳过"
  else
    if [ ! -f "$SWAPFILE" ]; then
      run fallocate -l "$SWAP_SIZE" "$SWAPFILE"
    else
      say "  $SWAPFILE 已存在（$(stat -c '%s bytes, mode %a' "$SWAPFILE")）"
    fi
    run chmod 600 "$SWAPFILE"
    run /sbin/mkswap "$SWAPFILE"
    if [ "$APPLY" = 1 ]; then
      if /sbin/swapon "$SWAPFILE" 2>&1 | sed 's/^/    /'; then
        say "  swapon 成功"
      else
        noteable "swapon 失败（容器缺 CAP_SYS_ADMIN 时会 EPERM）→ 可跑 --undo-swap 收回那 4GB"
      fi
    else
      say "  [dry-run] /sbin/swapon $SWAPFILE"
    fi
    if ! grep -q "^$SWAPFILE" /etc/fstab 2>/dev/null; then
      run bash -c "echo '$SWAPFILE none swap sw 0 0' >> /etc/fstab"
    fi
    if [ ! -f "$SYSCTL_CONF" ]; then
      run bash -c "echo 'vm.swappiness=10' > $SYSCTL_CONF && sysctl -q --system"
    fi
  fi
fi

# ── 3. 验收 ────────────────────────────────────────────────────────────────
step "验收"

# curl < 8 在 HTTPS 下默认不提供 h2 ALPN，必须显式 --http2，否则量到的是 1.1（假阴性）
http_version=$(curl -s -o /dev/null -w '%{http_version}' --http2 --max-time 8 https://dev.ftai.cc/ 2>/dev/null || echo '?')
say "  公网 HTTP 版本：${http_version}（期望 2）"
[ "$http_version" = "2" ] || { [ "$APPLY" = 1 ] && noteable "HTTP/2 未生效" || true; }

swap_now=$(/sbin/swapon --show=NAME,TYPE 2>/dev/null | tr '\n' ' ')
say "  当前 swap：${swap_now:-（无）}"
say "  swappiness：$(cat /proc/sys/vm/swappiness 2>/dev/null)"
say "  磁盘：$(df -h / | awk 'NR==2{print $4" 可用 / "$5" 已用"}')"

step "结论"
if [ "$APPLY" != 1 ]; then
  say "  dry-run 结束，未改动任何系统文件。确认上面预览后加 --apply 执行。"
elif [ "$FAILED" = 0 ]; then
  say "  完成。HTTP/2 期望值 2；swap 见上行（无输出=未启用）。"
else
  say "  有步骤未通过（见上面 ✗）。可用 --undo-swap 收回 swap 文件，nginx 可还原 /root/pi-dev-nginx-*.bak。"
fi
exit "$FAILED"
