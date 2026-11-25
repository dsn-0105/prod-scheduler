#!/usr/bin/env bash
# ============================================================
# deploy-admin.sh —— 管理员后台（/admin/）一键部署（5 步 · 五条独立线上断言）
# ------------------------------------------------------------
# 【部署顺序（正确 = 先生产后端，后本后台）】
#   1) `bash deploy.sh`        —— 先发生产后端（新增 /api/perm-meta）+ 新 index.html + prod-server 重启
#   2) `bash deploy-admin.sh`  —— 再发本后台（静态页 + nginx 301）
#   反序（先跑本脚本）**不致命**：后台 `GET /api/perm-meta` 拿 404 ⇒ 自动走**降级态**
#   （员工列表照常显示、「表单写权限」列显示「权限清单未就绪」、新增/编辑禁用、工具栏有「重试」），
#   等生产后端上线后刷新页面或点「重试」即可恢复，不需要重发静态页。
#   本脚本第 ⑤ 步会探测 /api/perm-meta 的返回码（401=已就绪 / 404=尚未部署）并当场提示。
# ------------------------------------------------------------
# 【本脚本部署的是什么】
#   `/admin/` 是一个**纯静态页**（admin/index.html + admin/admin-app.js）：
#     · 数据面直接复用生产现成接口 /api/me（判角色）、/api/users（员工增删改查）、
#       /api/perm-meta（权限元数据）—— 生产后端早就有 `if (user.role !== 'admin') return 403` 硬闸；
#     · **不新建后端进程、不新建数据文件、不新增 /api/admin/ 代理**（用户已拍板「方案 A」）。
#   因此本脚本**只做两件事**：把 2 个静态文件放到 /var/www/html/admin/，再插一条 301 规则。
#
# 【部署形态铁律 · 改动前必读】
#   `/admin/` 必须与生产系统**同域同端口**（nginx 同一个 server 块里加 location）。
#   原因：后台与生产页共用 sessionStorage['wb_cb_prod_token'] 实现「只登录一次」，
#         sessionStorage 是**按源（协议+域+端口）隔离**的。改成独立子域或独立端口后两边
#         不再同源 ⇒ 免登录立即失效、后台拿不到 token，直接破坏「只登录一次」这条硬需求。
#   ⇒ 不要为「隔离更彻底」把管理员后台挪到子域；那不是加固，是功能失效。
#
# 【隔离保证】本脚本全程**不上传、不删除、不修改**
#     /var/www/html/index.html      （生产前端）
#     /opt/prod-server/*            （生产后端与数据，含 users.json —— 员工数据一个字都不碰）
#   并在第 ⑤ 条断言里用 md5 前后比对证明生产前端一字未动。
#
# 【HTTPS 说明】线上 80 端口全部 301 到 443（见 ops/nginx-current.conf），
#   因此所有验证用 curl 一律走 https://127.0.0.1 并用 -k 跳过自签证书校验。
#
# 用法：bash deploy-admin.sh                                    （在仓库根目录或任意目录执行均可）
#      ADMIN_HOST=root@1.2.3.4 bash deploy-admin.sh            （换机器）
# 幂等：可重复执行。nginx 片段按 marker 更新而不重复插入；静态目录备份带时间戳不覆盖。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

# ---------------- 配置 ----------------
HOST="${ADMIN_HOST:-root@111.231.167.192}"
SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15)
SCP_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=10)
# 线上是 HTTPS，本地自测必须 -k（证书是自签/域名证书，用 127.0.0.1 访问必然不匹配）
SITE="https://127.0.0.1"
CURL=(curl -sk --max-time 15)
TS="$(date +%Y%m%d%H%M%S)"
PROD_INDEX="/var/www/html/index.html"
WEB_DIR_REMOTE="/var/www/html/admin"
BACKUP_DIR_REMOTE="/var/www/html/backups"
FILES=(index.html admin-app.js)

# ---------------- 小工具 ----------------
step() { printf '\n========== [%s] %s ==========\n' "$1" "$2"; }
ok()   { printf '✅ %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\n❌ %s\n' "$*" >&2; exit 1; }

rsh()  { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }
md5_local()  { md5sum "$1" | awk '{print $1}'; }
md5_remote() { rsh "md5sum $(printf '%q' "$1")" | awk '{print $1}'; }
http_code()  { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$1"; }

# ============================================================
# [1/5] 前置检查
# ============================================================
step "1/5" "前置检查（本地文件 / 语法 / 后台水印提取 / 生产前端 md5 基线）"

REQUIRED=(
  admin/index.html admin/admin-app.js
  ops/nginx-admin.conf
)
for f in "${REQUIRED[@]}"; do
  [ -f "$f" ] || die "缺少必需文件：$f"
done
ok "3 个必需文件齐全"

node --check admin/admin-app.js || die "admin/admin-app.js 语法检查未通过"
ok "node --check admin/admin-app.js 通过"

# 管理员后台水印：**只从 admin/index.html 提取**（与生产/质量系统各自独立的水印号无关）
AVER="$(grep -oE 'build [0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+<' admin/index.html | head -1 | sed 's/<$//' || true)"
[ -n "$AVER" ] || die "无法从 admin/index.html 提取版本水印（grep 'build YYYY-MM-DD.NNN<' 无结果）"
printf '%s' "$AVER" | grep -qE '^build [0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{3}$' \
  || die "后台水印形态非法：'$AVER'（期望 build YYYY-MM-DD.NNN，序号三位补零；注意别把生产版本号抄进来）"
ok "后台水印（来自 admin/index.html）：$AVER"

# 记录生产前端 md5（部署前后必须相同 —— 这是"没碰生产"的唯一硬证据）
PROD_MD5_BEFORE="$(md5_remote "$PROD_INDEX" || true)"
[ -n "$PROD_MD5_BEFORE" ] || die "无法读取生产前端 $PROD_INDEX 的 md5（远端不可达或文件缺失）"
info "生产前端 md5（部署前）：$PROD_MD5_BEFORE"

# ============================================================
# [2/5] 上传静态目录（带时间戳备份）+ md5 断言
# ============================================================
step "2/5" "上传 admin/ → $WEB_DIR_REMOTE（带时间戳备份）+ md5 断言"

rsh "TS='$TS' bash -s" <<'EOS' || die "远端目录准备 / 备份失败"
set -euo pipefail
mkdir -p /var/www/html/admin /var/www/html/backups
if [ -d /var/www/html/admin ] && [ -n "$(ls -A /var/www/html/admin 2>/dev/null || true)" ]; then
  cp -a /var/www/html/admin "/var/www/html/backups/admin.pre-$TS"
  echo "   备份 /var/www/html/admin → /var/www/html/backups/admin.pre-$TS"
else
  echo "   /var/www/html/admin 为空或不存在，无需备份"
fi
mkdir -p /var/www/html/admin/.incoming
EOS

for f in "${FILES[@]}"; do
  scp -q "${SCP_OPTS[@]}" "admin/$f" "$HOST:$WEB_DIR_REMOTE/.incoming/$f"
done
rsh 'bash -s' <<'EOS' || die "前端文件就位失败"
set -euo pipefail
cd /var/www/html/admin/.incoming
for f in index.html admin-app.js; do
  mv -f "$f" "/var/www/html/admin/$f"
done
rmdir /var/www/html/admin/.incoming 2>/dev/null || true
chmod 0644 /var/www/html/admin/index.html /var/www/html/admin/admin-app.js
EOS

for f in "${FILES[@]}"; do
  L="$(md5_local "admin/$f")"
  R="$(md5_remote "$WEB_DIR_REMOTE/$f")"
  [ "$L" = "$R" ] || die "md5 不一致：/admin/$f（本地 $L / 远端 $R）"
  info "/admin/$f md5=$L ✔"
done
ok "admin/ 2 个文件 md5 全部一致"

# ============================================================
# [3/5] nginx：幂等插入 marker 块 → nginx -t（失败即还原）→ reload
# ============================================================
step "3/5" "nginx 幂等插入 + nginx -t 安全闸门 + reload"

# 定位"承载 location /api 的配置文件"：用 nginx -T 反查，避免踩到 sites-enabled 的软链
CONF_INCLUDED="$(rsh 'bash -s' <<'EOS'
set -euo pipefail
nginx -T 2>/dev/null | awk '
  /^# configuration file / { f=$4; sub(/:$/, "", f); next }
  /^[[:space:]]*location[[:space:]]+\/api([[:space:]{]|$)/ { print f; exit }
'
EOS
)"
CONF_INCLUDED="$(printf '%s' "$CONF_INCLUDED" | tr -d '\r' | head -1 | sed 's/:$//')"
[ -n "$CONF_INCLUDED" ] || die "未能定位承载 location /api 的 nginx 配置文件（nginx -T 反查失败）"
# 必须 resolve 成真实文件：sites-enabled/default 是软链，若对软链做 mv 会把软链替换成普通文件
CONF="$(rsh "readlink -f '$CONF_INCLUDED'" | tr -d '\r' | head -1)"
[ -n "$CONF" ] || die "readlink -f 失败：$CONF_INCLUDED"
info "nginx -T 报告路径：$CONF_INCLUDED"
info "真实文件路径　　：$CONF"

scp -q "${SCP_OPTS[@]}" ops/nginx-admin.conf "$HOST:/tmp/admin-nginx-snippet.conf"
rsh "CONF='$CONF' SNIPPET='/tmp/admin-nginx-snippet.conf' TS='$TS' bash -s" <<'EOS' || die "nginx 配置变更失败（原文件已回滚，未 reload）"
set -euo pipefail
BKDIR=/etc/nginx/admin-conf-backups
mkdir -p "$BKDIR"
BAK="$BKDIR/$(basename "$CONF").bak-$TS"
cp -p "$CONF" "$BAK"
printf '%s\n' "$CONF" > "$BAK.origin"
echo "   已备份 $CONF → $BAK"

BEGIN='# >>> admin-system BEGIN'
ENDM='# <<< admin-system END <<<'

if grep -qF "$BEGIN" "$CONF"; then
  echo "   检测到已有 admin-system marker ⇒ 走「更新」路径（awk 替换 marker 区间）"
  awk -v b="$BEGIN" -v e="$ENDM" '
    NR==FNR       { snip[++n]=$0; next }
    index($0,b)==1 { for(i=1;i<=n;i++) print snip[i]; skip=1; next }
    skip==1 && index($0,e)==1 { skip=0; next }
    skip==1       { next }
    { print }
  ' "$SNIPPET" "$CONF" > "$CONF.new"
else
  L=$(grep -nE '^[[:space:]]*location[[:space:]]+/api([[:space:]{]|$)' "$CONF" | head -1 | cut -d: -f1 || true)
  if [ -z "${L:-}" ]; then
    echo "❌ 未找到 location /api 行，请人工确认 nginx 结构（绝不追加到文件末尾）"
    rm -f "$CONF.new"
    exit 20
  fi
  echo "   location /api 位于第 $L 行 ⇒ 在其前插入 admin-system 块"
  awk -v L="$L" '
    NR==FNR { snip[++n]=$0; next }
    FNR==L  { for(i=1;i<=n;i++) print snip[i] }
    { print }
  ' "$SNIPPET" "$CONF" > "$CONF.new"
fi

if cmp -s "$CONF" "$CONF.new"; then
  echo "   ℹ️ 配置无变化（幂等），跳过 replace 与 reload"
  rm -f "$CONF.new" /tmp/admin-nginx-snippet.conf
  exit 0
fi

mv "$CONF.new" "$CONF"

# ★ nginx -t 是唯一安全闸门：不通过就立刻用备份覆盖回去，且**绝不 reload**
if nginx -t > /tmp/admin-nginx-t.log 2>&1; then
  echo "   ✅ nginx -t 通过"
  systemctl reload nginx
  echo "   ✅ nginx 已 reload"
else
  echo "   ❌ nginx -t 失败，立刻回滚（未 reload，线上仍跑旧配置）"
  sed -n '1,40p' /tmp/admin-nginx-t.log
  cp -p "$BAK" "$CONF"
  if nginx -t > /dev/null 2>&1; then
    echo "   ✅ 已回滚到备份，配置恢复合法"
  else
    echo "   ❌ 回滚后仍不合法，请人工介入！"
  fi
  exit 21
fi
rm -f /tmp/admin-nginx-snippet.conf
EOS
ok "nginx 配置就位（marker 幂等），nginx -t 通过并已 reload"

# ============================================================
# [4/5] 线上断言：路由 / 静态资源 / 后台接口门禁
# ============================================================
step "4/5" "线上断言：/admin/ 200 + 水印 · /admin 301 · admin-app.js 200 · /api/users 401"

# ① 后台页面 200 且水印恰 1 处
A_PAGE="$("${CURL[@]}" "$SITE/admin/")"
[ -n "$A_PAGE" ] || die "① /admin/ 返回空（页面未就位）"
A_HITS="$(printf '%s' "$A_PAGE" | grep -cF ">$AVER<" || true)"
[ "$A_HITS" = "1" ] || die "① 后台水印断言失败：期望 1 处「>$AVER<」，实际 $A_HITS 处"
ok "① $SITE/admin/ 中「>$AVER<」恰 1 处"

# ② /admin 无尾斜杠 ⇒ 301 到 /admin/
C="$(http_code "$SITE/admin")"
[ "$C" = "301" ] || die "② 路由断言失败：$SITE/admin 期望 301，实际 $C（相对资源会解析错误 ⇒ 白屏）"
ok "② $SITE/admin → 301"

# ③ 同目录 JS 可直接取到（相对路径能解析）
C="$(http_code "$SITE/admin/admin-app.js")"
[ "$C" = "200" ] || die "③ 静态资源断言失败：$SITE/admin/admin-app.js 期望 200，实际 $C"
ok "③ $SITE/admin/admin-app.js → 200"

# ④ 生产接口未被改动：无 token 的 /api/users 必须恰 401（先鉴权、后 admin 闸门）
C="$(http_code "$SITE/api/users")"
[ "$C" = "401" ] || die "④ 接口断言失败：$SITE/api/users 期望 401，实际 $C（生产后端可能异常）"
ok "④ $SITE/api/users（无 token）→ 401"

# ⑤ 生产前端在本脚本全程未被触碰（md5 前后一致）
PROD_MD5_AFTER="$(md5_remote "$PROD_INDEX")"
[ "$PROD_MD5_BEFORE" = "$PROD_MD5_AFTER" ] \
  || die "⑤ 生产前端 md5 变了（$PROD_MD5_BEFORE → $PROD_MD5_AFTER）——严重违规"
ok "⑤ 生产前端 $PROD_INDEX md5 未变（$PROD_MD5_AFTER）"

# ============================================================
# [5/5] 收尾提示
# ============================================================
step "5/5" "收尾"

# 生产后端是否已提供 /api/perm-meta（决定后台「表单写权限」列可用 / 走降级）
C="$(http_code "$SITE/api/perm-meta")"
case "$C" in
  401) ok "生产后端已就绪：$SITE/api/perm-meta（无 token）→ 401（后台权限清单可用）" ;;
  404) info "⚠️ 生产后端尚未部署 /api/perm-meta（404）⇒ 后台会走**降级态**：员工列表可见、"
       info "   「表单写权限」列显示「权限清单未就绪」、新增/编辑禁用，点「重试」可重拉。"
       info "   请另行部署生产后端（server/server.js）后刷新；本脚本**不**动 /opt/prod-server/*。" ;;
  *)   info "⚠️ $SITE/api/perm-meta 返回 $C（预期 401 或 404），请人工确认生产后端状态。" ;;
esac

printf '\n============================================================\n'
printf '✅ 管理员后台部署完成\n'
printf '   后台水印：%s\n' "$AVER"
printf '   入口　　：%s/admin/  （生产：%s/ ，质量：%s/quality/）\n' "$SITE" "$SITE" "$SITE"
printf '   回滚　　：把 /var/www/html/backups/admin.pre-%s 覆盖回 /var/www/html/admin/\n' "$TS"
printf '             并删掉 nginx 配置里的 admin-system marker 块后 nginx -t && systemctl reload nginx\n'
printf '============================================================\n'
