#!/usr/bin/env bash
# ============================================================
# rollback-qa.sh —— 质量系统上线回滚（nginx / qa-server / 静态目录 三者**独立**可回滚）
# ------------------------------------------------------------
# 用法：
#   bash rollback-qa.sh            # 全部回滚（nginx → qa-server → 静态目录）
#   bash rollback-qa.sh nginx      # 只回滚 nginx 配置（30 秒内恢复，生产立刻可用）
#   bash rollback-qa.sh server     # 只停 qa-server（不动 nginx、不删静态目录）
#   bash rollback-qa.sh static     # 只删 /var/www/html/quality（不动进程与 nginx）
#
# 【隔离保证】本脚本**不触碰**：
#     /var/www/html/index.html   （生产前端）
#     /opt/prod-server/*         （生产后端与数据）
#   ⇒ 最坏情况下（qa-server 起不来 / nginx 配错），生产排单系统的静态文件与后端
#     始终未被修改；把 nginx 恢复回去，生产立刻回到原样。
#
# 【为什么备份里存 .origin 侧车文件】
#   线上实际配置是 /etc/nginx/sites-available/default（sites-enabled/default 是软链），
#   不是常见的 conf.d/*。所以回滚**不能**用「从备份文件名反推目录」的写法（会猜错），
#   改为部署时把原文件的绝对路径写进 <backup>.origin，回滚时照读。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

HOST="${QA_HOST:-root@111.231.167.192}"
SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=10)
SITE="https://127.0.0.1"
CURL=(curl -sk --max-time 15)
MODE="${1:-all}"

step() { printf '\n========== %s ==========\n' "$1"; }
ok()   { printf '✅ %s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*"; }
die()  { printf '\n❌ %s\n' "$*" >&2; exit 1; }

rscript() { ssh "${SSH_OPTS[@]}" "$HOST" 'bash -s'; }
http_code() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$1"; }

case "$MODE" in
  all|nginx|server|static) : ;;
  *) die "未知参数：$MODE（可用：all | nginx | server | static）" ;;
esac

# ------------------------------------------------------------
# ① nginx 回滚（恢复最近一份备份 → nginx -t 校验 → reload）
# ------------------------------------------------------------
rollback_nginx() {
  step "① nginx 配置回滚"
  rscript <<'EOS' || return 1
set -euo pipefail
BKDIR=/etc/nginx/qa-conf-backups
LATEST=$(ls -1t "$BKDIR"/*.bak-* 2>/dev/null | grep -v '\.origin$' | head -1 || true)
if [ -z "${LATEST:-}" ]; then
  echo "⚠️  未找到 nginx 备份（$BKDIR），跳过 nginx 回滚"
  exit 0
fi
ORIGIN="$LATEST.origin"
if [ -f "$ORIGIN" ]; then
  CONF=$(head -1 "$ORIGIN")
else
  echo "❌ 备份缺少 $ORIGIN 侧车文件，无法确定原文件路径，请人工处理"
  echo "   备份文件：$LATEST"
  exit 1
fi
echo "   备份：$LATEST"
echo "   目标：$CONF"
cp -p "$LATEST" "$CONF"
if nginx -t > /tmp/qa-nginx-rollback-t.log 2>&1; then
  systemctl reload nginx
  echo "✅ nginx 已回滚并 reload"
else
  echo "❌ 回滚后的配置仍不合法，请人工介入（未 reload，线上仍跑当前生效配置）"
  sed -n '1,40p' /tmp/qa-nginx-rollback-t.log
  exit 1
fi
EOS
}

# ------------------------------------------------------------
# ② qa-server 停止（不删除任何数据、不动 nginx）
# ------------------------------------------------------------
rollback_server() {
  step "② 停止 qa-server（保留 /opt/qa-server 全部数据与日志）"
  rscript <<'EOS' || return 1
set -euo pipefail
systemctl stop qa-server 2>/dev/null || true
systemctl disable qa-server >/dev/null 2>&1 || true
STATE=$(systemctl is-active qa-server 2>/dev/null || true)
echo "   systemctl is-active qa-server → ${STATE:-inactive}"
echo "   ℹ️ 数据文件 /opt/qa-server/data-qa.json 与 backups/ 均**未改动**（回滚不删数据）"
echo "   重启方式：systemctl enable --now qa-server"
EOS
}

# ------------------------------------------------------------
# ③ 静态目录移除（/var/www/html/quality 改名留档，不 rm -rf 掉证据）
# ------------------------------------------------------------
rollback_static() {
  step "③ 移除质量系统静态目录（改名留档，可随时改回）"
  rscript <<'EOS' || return 1
set -euo pipefail
TS=$(date +%Y%m%d%H%M%S)
if [ -d /var/www/html/quality ]; then
  mv /var/www/html/quality "/var/www/html/backups/quality.rolledback-$TS"
  echo "   /var/www/html/quality → /var/www/html/backups/quality.rolledback-$TS"
else
  echo "   /var/www/html/quality 不存在，跳过"
fi
echo "   ℹ️ 全程未触碰 /var/www/html/index.html"
EOS
}

# ------------------------------------------------------------
# 执行
# ------------------------------------------------------------
if [ "$MODE" = "all" ] || [ "$MODE" = "nginx" ]; then
  rollback_nginx || die "nginx 回滚失败 —— 生产可能受影响，请立刻人工介入！"
fi
if [ "$MODE" = "all" ] || [ "$MODE" = "server" ]; then
  rollback_server || die "qa-server 停止失败，请人工介入"
fi
if [ "$MODE" = "all" ] || [ "$MODE" = "static" ]; then
  rollback_static || die "静态目录移除失败，请人工介入"
fi

# ------------------------------------------------------------
# 回滚后自检：生产必须可用，质量系统必须已下线
# ------------------------------------------------------------
step "回滚后自检"
if [ "$MODE" = "all" ] || [ "$MODE" = "nginx" ] || [ "$MODE" = "server" ] || [ "$MODE" = "static" ]; then
  C_PROD_API="$(http_code "$SITE/api/revs" || echo 'ERR')"
  if [ "$C_PROD_API" = "401" ]; then
    ok "生产后端仍可用：$SITE/api/revs → 401（无 token 到达生产鉴权分支即正常）"
  else
    warn "生产后端 /api/revs 返回 $C_PROD_API（期望 401）—— 请立刻人工核查 nginx！"
  fi
  C_PROD_PAGE="$(http_code "$SITE/" || echo 'ERR')"
  if [ "$C_PROD_PAGE" = "200" ]; then
    ok "生产首页可用：$SITE/ → 200"
  else
    warn "生产首页 / 返回 $C_PROD_PAGE（期望 200）—— 请立刻人工核查！"
  fi
  C_QA="$(http_code "$SITE/quality/" || echo 'ERR')"
  case "$C_QA" in
    404) ok "质量系统已下线：$SITE/quality/ → 404" ;;
    200) warn "质量系统仍可访问（$SITE/quality/ → 200）；若本次只回滚了 server，属预期" ;;
    *)   warn "质量系统路由返回 $C_QA（404=已下线 / 200=仍在 / 其他=需核查）" ;;
  esac
fi

printf '\n============================================================\n'
printf '回滚完成（模式：%s）\n' "$MODE"
printf '   生产系统：%s/ （应始终可用；全程未触碰 index.html 与 /opt/prod-server）\n' "$SITE"
printf '   质量系统：已按模式下线；数据文件未被删除，重新部署即可恢复\n'
printf '============================================================\n'
