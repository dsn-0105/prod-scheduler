#!/usr/bin/env bash
# ============================================================
# deploy-qa.sh —— 质量系统一键部署（7 步 · 四条独立线上断言）
# ------------------------------------------------------------
# 【部署形态铁律 · 改动前必读】
#   质量系统**必须与生产系统同域同端口**部署（nginx 同一个 server 块里加 location）。
#   原因：质量页与生产页共用 sessionStorage['wb_cb_prod_token'] 实现「只登录一次」，
#         而 sessionStorage 是**按源（协议+域+端口）隔离**的。改成独立子域或独立端口后
#         两边不再同源 ⇒ 免登录立即失效、质量页拿不到 token，直接破坏 PRD 的核心需求。
#   ⇒ 不要为「隔离更彻底」而把质量系统挪到子域；那不是加固，是功能失效。
#
# 【隔离保证】本脚本全程**不上传、不删除、不修改**
#     /var/www/html/index.html      （生产前端）
#     /opt/prod-server/*            （生产后端与数据）
#     并在第 ⑤ 条断言里用 md5 前后比对证明生产前端一字未动。
#
# 【HTTPS 说明】线上 80 端口全部 301 到 443（见 ops/nginx-current.conf），
#   因此所有验证用 curl 一律走 https://127.0.0.1 并用 -k 跳过自签证书校验。
#
# 用法：bash deploy-qa.sh            （在仓库根目录或任意目录执行均可）
#      QA_HOST=root@1.2.3.4 bash deploy-qa.sh   （换机器）
# 幂等：可重复执行。nginx 片段按 marker 更新而不重复插入；各备份带时间戳不覆盖。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

# ---------------- 配置 ----------------
HOST="${QA_HOST:-root@111.231.167.192}"
SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15)
SCP_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=10)
# 线上是 HTTPS，本地自测必须 -k（证书是自签/域名证书，用 127.0.0.1 访问必然不匹配）
SITE="https://127.0.0.1"
CURL=(curl -sk --max-time 15)
TS="$(date +%Y%m%d%H%M%S)"
PROD_INDEX="/var/www/html/index.html"
QA_DIR_REMOTE="/opt/qa-server"
WEB_DIR_REMOTE="/var/www/html/quality"
BACKUP_DIR_REMOTE="/var/www/html/backups"

# ---------------- 小工具 ----------------
step() { printf '\n========== [%s] %s ==========\n' "$1" "$2"; }
ok()   { printf '✅ %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\n❌ %s\n' "$*" >&2; exit 1; }

rsh()  { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }
rscript() { ssh "${SSH_OPTS[@]}" "$HOST" 'bash -s'; }
md5_local()  { md5sum "$1" | awk '{print $1}'; }
md5_remote() { rsh "md5sum $(printf '%q' "$1")" | awk '{print $1}'; }
http_code()  { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$1"; }

# ============================================================
# [1/7] 前置检查
# ============================================================
step "1/7" "前置检查（本地文件 / 语法 / 质量水印提取）"

REQUIRED=(
  quality/index.html quality/qa-core.js quality/qa-app.js
  server/qa-server.js server/qa-auth.js server/qa-store.js
  ops/nginx-qa.conf ops/qa-server.service
  ops/qa-backup.sh ops/qa-backup.service ops/qa-backup.timer
)
for f in "${REQUIRED[@]}"; do
  [ -f "$f" ] || die "缺少必需文件：$f"
done
ok "11 个必需文件齐全"

node tests/check-syntax.js > /dev/null || die "语法自检未通过：node tests/check-syntax.js"
ok "node tests/check-syntax.js 通过"

# 质量系统水印：**只从 quality/index.html 提取**。
# 绝不能用 /api/qa/health 的 version 字段 —— 那是「数据格式版本」（qa-YYYY-MM-DD.N），
# 与 UI 水印（build YYYY-MM-DD.NNN）是两套东西（T01 的实现发现第 5 条）。
QVER="$(grep -oE 'build [0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+<' quality/index.html | head -1 | sed 's/<$//' || true)"
[ -n "$QVER" ] || die "无法从 quality/index.html 提取版本水印（grep 'build YYYY-MM-DD.NNN<' 无结果）"
printf '%s' "$QVER" | grep -qE '^build [0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{3}$' \
  || die "质量水印形态非法：'$QVER'（期望 build YYYY-MM-DD.NNN，序号三位补零；注意别把生产版本号抄进来）"
ok "质量水印（来自 quality/index.html）：$QVER"

# 记录生产前端 md5（部署前后必须相同 —— 这是"没碰生产"的唯一硬证据）
PROD_MD5_BEFORE="$(md5_remote "$PROD_INDEX" || true)"
[ -n "$PROD_MD5_BEFORE" ] || die "无法读取生产前端 $PROD_INDEX 的 md5（远端不可达或文件缺失）"
info "生产前端 md5（部署前）：$PROD_MD5_BEFORE"

rsh "mkdir -p $QA_DIR_REMOTE/backups $QA_DIR_REMOTE/.incoming" || die "无法在远端创建 $QA_DIR_REMOTE 目录"
ok "远端目录就绪"

# ============================================================
# [2/7] 后端：备份 + 上传 + md5 断言（并安装备份定时器）
# ============================================================
step "2/7" "后端 qa-server 上传 + md5 断言"

rsh "TS='$TS' bash -s" <<'EOS' || die "后端备份失败"
set -euo pipefail
for f in qa-server.js qa-auth.js qa-store.js qa-core.js data-qa.json; do
  if [ -f "/opt/qa-server/$f" ]; then
    cp -p "/opt/qa-server/$f" "/opt/qa-server/backups/$f.bak-$TS"
    echo "   备份 /opt/qa-server/$f → backups/$f.bak-$TS"
  fi
done
EOS
ok "既存后端文件已按时间戳备份（不覆盖）"

scp -q "${SCP_OPTS[@]}" server/qa-server.js "$HOST:$QA_DIR_REMOTE/.incoming/qa-server.js"
scp -q "${SCP_OPTS[@]}" server/qa-auth.js   "$HOST:$QA_DIR_REMOTE/.incoming/qa-auth.js"
scp -q "${SCP_OPTS[@]}" server/qa-store.js  "$HOST:$QA_DIR_REMOTE/.incoming/qa-store.js"
# ★ qa-core.js 的第二落点：与前端同一份字节（"编号只有一份实现"）
scp -q "${SCP_OPTS[@]}" quality/qa-core.js  "$HOST:$QA_DIR_REMOTE/.incoming/qa-core.js"

rsh 'bash -s' <<'EOS' || die "后端文件就位失败"
set -euo pipefail
cd /opt/qa-server/.incoming
for f in qa-server.js qa-auth.js qa-store.js qa-core.js; do
  mv -f "$f" "/opt/qa-server/$f"
done
EOS

for f in qa-server.js qa-auth.js qa-store.js; do
  L="$(md5_local "server/$f")"
  R="$(md5_remote "$QA_DIR_REMOTE/$f")"
  [ "$L" = "$R" ] || die "md5 不一致：$f（本地 $L / 远端 $R）——已中止，未重启服务"
  info "$f md5=$L ✔"
done
L="$(md5_local quality/qa-core.js)"
R="$(md5_remote "$QA_DIR_REMOTE/qa-core.js")"
[ "$L" = "$R" ] || die "md5 不一致：qa-core.js（后端落点）"
info "qa-core.js(后端落点) md5=$L ✔"
ok "后端 4 个文件 md5 全部一致"

# 备份定时器（设计 §1.2.5e）：脚本 + service + timer，装了才会真的备份
scp -q "${SCP_OPTS[@]}" ops/qa-backup.sh "$HOST:$QA_DIR_REMOTE/.incoming/qa-backup.sh"
scp -q "${SCP_OPTS[@]}" ops/qa-backup.service "$HOST:/tmp/qa-backup.service"
scp -q "${SCP_OPTS[@]}" ops/qa-backup.timer   "$HOST:/tmp/qa-backup.timer"
rsh 'bash -s' <<'EOS' || die "备份定时器安装失败"
set -euo pipefail
install -m 0755 /opt/qa-server/.incoming/qa-backup.sh /opt/qa-server/qa-backup.sh
rm -f /opt/qa-server/.incoming/qa-backup.sh
install -m 0644 /tmp/qa-backup.service /etc/systemd/system/qa-backup.service
install -m 0644 /tmp/qa-backup.timer   /etc/systemd/system/qa-backup.timer
rm -f /tmp/qa-backup.service /tmp/qa-backup.timer
rmdir /opt/qa-server/.incoming 2>/dev/null || true
systemctl daemon-reload
systemctl enable qa-backup.timer >/dev/null 2>&1 || true
systemctl start  qa-backup.timer
echo "   qa-backup.timer: $(systemctl is-active qa-backup.timer || true)"
EOS
ok "备份脚本 + service + timer 已安装并启用（每日 02:30，保留 30 份）"

# ============================================================
# [3/7] 数据文件守卫 + 显式初始化
# ============================================================
step "3/7" "数据文件守卫 + 显式 --init"

rsh 'bash -s' <<'EOS' || die "数据文件守卫失败"
set -euo pipefail
DATA=/opt/qa-server/data-qa.json
if [ ! -f "$DATA" ]; then
  echo "   数据文件不存在 ⇒ 显式初始化（绝不静默创建）"
  QA_DATA_FILE="$DATA" node /opt/qa-server/qa-server.js --init
fi
[ -f "$DATA" ] || { echo "❌ --init 后文件仍不存在"; exit 1; }
node -e '
  const fs=require("fs");
  const p="/opt/qa-server/data-qa.json";
  const d=JSON.parse(fs.readFileSync(p,"utf8"));
  if(!d || typeof d!=="object" || Array.isArray(d)) { console.error("❌ 顶层不是对象"); process.exit(1); }
  if(!Array.isArray(d.qaLogs)) { console.error("❌ qaLogs 不是数组"); process.exit(1); }
  console.log("   数据文件合法：version="+d.version+" records="+d.qaLogs.length+" rev="+(d.revs&&d.revs.qaLogs));
'
mkdir -p /opt/qa-server/backups
cp -p "$DATA" "/opt/qa-server/backups/data-qa.pre-deploy-$(date +%Y%m%d%H%M%S).json"
echo "   已留部署前数据快照（内容未改动）"
EOS
ok "数据文件存在、JSON 合法、qaLogs 为数组"

# ============================================================
# [4/7] 重启 qa-server + 断言 active + 断言健康
# ============================================================
step "4/7" "安装 unit + 重启 qa-server + 健康断言"

scp -q "${SCP_OPTS[@]}" ops/qa-server.service "$HOST:/tmp/qa-server.service"
rsh 'bash -s' <<'EOS' || die "qa-server 启动失败（日志见上方 journalctl 输出）"
set -euo pipefail
install -m 0644 /tmp/qa-server.service /etc/systemd/system/qa-server.service
rm -f /tmp/qa-server.service
systemctl daemon-reload
systemctl enable qa-server >/dev/null 2>&1 || true
systemctl restart qa-server
sleep 2
STATE=$(systemctl is-active qa-server || true)
echo "   systemctl is-active qa-server → $STATE"
if [ "$STATE" != "active" ]; then
  echo "❌ qa-server 未进入 active"
  journalctl -u qa-server -n 40 --no-pager || true
  exit 1
fi
if ! curl -sf --max-time 5 http://127.0.0.1:3001/api/qa/health | grep -q '"ok":true'; then
  echo "❌ qa-server 自身 health 未返回 ok:true"
  journalctl -u qa-server -n 40 --no-pager || true
  exit 1
fi
echo "   health(直连 3001): $(curl -s --max-time 5 http://127.0.0.1:3001/api/qa/health)"
journalctl -u qa-server -n 15 --no-pager || true
EOS
ok "qa-server active，直连 3001 的 /api/qa/health 返回 ok:true"

# ============================================================
# [5/7] 前端：备份 + 上传静态目录 + md5 断言
# ============================================================
step "5/7" "前端静态目录上传 + md5 断言（含生产前端未变证明）"

rsh "TS='$TS' bash -s" <<'EOS' || die "前端备份失败"
set -euo pipefail
mkdir -p /var/www/html/quality /var/www/html/backups
if [ -d /var/www/html/quality ] && [ -n "$(ls -A /var/www/html/quality 2>/dev/null || true)" ]; then
  cp -a /var/www/html/quality "/var/www/html/backups/quality.pre-$TS"
  echo "   备份 /var/www/html/quality → /var/www/html/backups/quality.pre-$TS"
else
  echo "   /var/www/html/quality 为空或不存在，无需备份"
fi
mkdir -p /var/www/html/quality/.incoming
EOS

for f in index.html qa-core.js qa-app.js; do
  scp -q "${SCP_OPTS[@]}" "quality/$f" "$HOST:$WEB_DIR_REMOTE/.incoming/$f"
done
rsh 'bash -s' <<'EOS' || die "前端文件就位失败"
set -euo pipefail
cd /var/www/html/quality/.incoming
for f in index.html qa-core.js qa-app.js; do
  mv -f "$f" "/var/www/html/quality/$f"
done
rmdir /var/www/html/quality/.incoming 2>/dev/null || true
chmod 0644 /var/www/html/quality/index.html /var/www/html/quality/qa-core.js /var/www/html/quality/qa-app.js
EOS

for f in index.html qa-core.js qa-app.js; do
  L="$(md5_local "quality/$f")"
  R="$(md5_remote "$WEB_DIR_REMOTE/$f")"
  [ "$L" = "$R" ] || die "md5 不一致：/quality/$f（本地 $L / 远端 $R）"
  info "/quality/$f md5=$L ✔"
done

# ★ 「编号只有一份实现」在线上的证明：两处 qa-core.js 必须**字节相同**
CORE_BE="$(md5_remote "$QA_DIR_REMOTE/qa-core.js")"
CORE_FE="$(md5_remote "$WEB_DIR_REMOTE/qa-core.js")"
[ "$CORE_BE" = "$CORE_FE" ] || die "qa-core.js 两处落点 md5 不同（后端 $CORE_BE / 前端 $CORE_FE）——编号将出现两份实现"
ok "qa-core.js 两处落点 md5 相同（$CORE_FE）——编号实现全工程唯一"

# ★ 生产前端一字未动
PROD_MD5_AFTER="$(md5_remote "$PROD_INDEX")"
[ "$PROD_MD5_BEFORE" = "$PROD_MD5_AFTER" ] || die "生产前端 $PROD_INDEX 的 md5 变了（$PROD_MD5_BEFORE → $PROD_MD5_AFTER）——严重违规"
ok "生产前端 md5 未变（$PROD_MD5_AFTER）"

# ============================================================
# [6/7] nginx：备份 → 幂等插入（marker 守卫）→ nginx -t → reload
# ============================================================
step "6/7" "nginx 幂等插入 + nginx -t 安全闸门 + reload"

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

scp -q "${SCP_OPTS[@]}" ops/nginx-qa.conf "$HOST:/tmp/qa-nginx-snippet.conf"
rsh "CONF='$CONF' SNIPPET='/tmp/qa-nginx-snippet.conf' TS='$TS' bash -s" <<'EOS' || die "nginx 配置变更失败（原文件已回滚，未 reload）"
set -euo pipefail
BKDIR=/etc/nginx/qa-conf-backups
mkdir -p "$BKDIR"
BAK="$BKDIR/$(basename "$CONF").bak-$TS"
cp -p "$CONF" "$BAK"
# 记录原文件绝对路径：回滚时不必猜目录（线上实际是 sites-available/default，不是 conf.d/*）
printf '%s\n' "$CONF" > "$BAK.origin"
echo "   已备份 $CONF → $BAK"

BEGIN='# >>> qa-system BEGIN'
ENDM='# <<< qa-system END <<<'

if grep -qF "$BEGIN" "$CONF"; then
  echo "   检测到已有 qa-system marker ⇒ 走「更新」路径（awk 替换 marker 区间）"
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
  echo "   location /api 位于第 $L 行 ⇒ 在其前插入 qa-system 块"
  awk -v L="$L" '
    NR==FNR { snip[++n]=$0; next }
    FNR==L  { for(i=1;i<=n;i++) print snip[i] }
    { print }
  ' "$SNIPPET" "$CONF" > "$CONF.new"
fi

if cmp -s "$CONF" "$CONF.new"; then
  echo "   ℹ️ 配置无变化（幂等），跳过 replace 与 reload"
  rm -f "$CONF.new" /tmp/qa-nginx-snippet.conf
  exit 0
fi

mv "$CONF.new" "$CONF"

# ★ nginx -t 是唯一安全闸门：不通过就立刻用备份覆盖回去，且**绝不 reload**
if nginx -t > /tmp/qa-nginx-t.log 2>&1; then
  echo "   ✅ nginx -t 通过"
  systemctl reload nginx
  echo "   ✅ nginx 已 reload"
else
  echo "   ❌ nginx -t 失败，立刻回滚（未 reload，线上仍跑旧配置）"
  sed -n '1,40p' /tmp/qa-nginx-t.log
  cp -p "$BAK" "$CONF"
  if nginx -t > /dev/null 2>&1; then
    echo "   ✅ 已回滚到备份，配置恢复合法"
  else
    echo "   ❌ 回滚后仍不合法，请人工介入！"
  fi
  exit 21
fi
rm -f /tmp/qa-nginx-snippet.conf
EOS
ok "nginx 配置就位（marker 幂等），nginx -t 通过并已 reload"

# ============================================================
# [7/7] 五条互相独立的线上断言
# ============================================================
step "7/7" "五条互相独立的线上断言"

# ① 质量水印（grep served page，**不是** health 的 version 字段）
Q_PAGE="$("${CURL[@]}" "$SITE/quality/")"
Q_HITS="$(printf '%s' "$Q_PAGE" | grep -cF ">$QVER<" || true)"
[ "$Q_HITS" = "1" ] || die "① 质量水印断言失败：期望 1 处「>$QVER<」，实际 $Q_HITS 处"
ok "① 质量水印：$SITE/quality/ 中「>$QVER<」恰 1 处"

# ② /quality 无尾斜杠 ⇒ 301 到 /quality/
C="$("http_code" "$SITE/quality")"
[ "$C" = "301" ] || die "② 路由断言失败：$SITE/quality 期望 301，实际 $C（相对资源会解析错误 ⇒ 白屏）"
ok "② $SITE/quality → 301"

# ③ 质量 API 确实走到 3001（同时证明 /api/qa/ 没被 /api 劫持）
H="$("${CURL[@]}" "$SITE/api/qa/health")"
printf '%s' "$H" | grep -q '"ok":true' || die "③ 质量 API 断言失败：$SITE/api/qa/health 未返回 ok:true（实际：$H）"
ok "③ $SITE/api/qa/health → ok:true（走 3001）"

# ④ 生产 API 仍走 3000 且未被劫持（401 = 无 token 到达了生产鉴权分支）
C="$(http_code "$SITE/api/revs")"
[ "$C" = "401" ] || die "④ 生产 API 断言失败：$SITE/api/revs 期望 401，实际 $C（可能被 /api/qa/ 规则误伤）"
ok "④ $SITE/api/revs → 401（生产后端未被劫持）"

# ⑤ 生产前端在本脚本全程未被触碰（md5 前后一致）
PROD_MD5_FINAL="$(md5_remote "$PROD_INDEX")"
[ "$PROD_MD5_BEFORE" = "$PROD_MD5_FINAL" ] \
  || die "⑤ 生产前端 md5 变了（$PROD_MD5_BEFORE → $PROD_MD5_FINAL）"
ok "⑤ 生产前端 $PROD_INDEX md5 未变（$PROD_MD5_FINAL）"

# ---------------- 收尾 ----------------
printf '\n============================================================\n'
printf '✅ 质量系统部署完成\n'
printf '   质量水印：%s\n' "$QVER"
printf '   入口　　：%s/quality/  （生产系统：%s/）\n' "$SITE" "$SITE"
printf '   后端日志：journalctl -u qa-server -f\n'
printf '   备份日志：journalctl -u qa-backup -n 50 --no-pager\n'
printf '   回滚　　：bash rollback-qa.sh\n'
printf '============================================================\n'
