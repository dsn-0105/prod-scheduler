#!/bin/bash
# ============================================================
# release.sh —— 一条命令完成「上线前检查 → 部署 → 线上断言 → 指纹归档」
# ============================================================
# 设计原则：把靠人记得的动作变成一次命令。
#   preflight（默认）：语法 → 全量回归 → 版本一致性 → 清单完整性 → 水印可提取。**不碰线上**。
#   deploy           ：preflight 全过后再部署、再在**服务器本地**断言、最后登记发布指纹。
#
# 用法：
#   bash scripts/release.sh                 # 等价 preflight，安全，可随时跑
#   bash scripts/release.sh deploy          # 真正部署（要求工作区干净：先 commit）
#   PROD_HOST=root@1.2.3.4 bash scripts/release.sh deploy   # 换机器
#
# 为什么需要它（不是"又一个脚本"）：
#   此前「改代码后第一动作跑 check-syntax」「回归用显式文件列表」「发版前手工对齐全部版本落点」
#   「部署后必须在服务器本地 curl」这些全靠人记得。人一换、会话一换就归零。
#   （刻意不写"共多少处落点"——绝对数字会随新增测试腐化，.144/.148/.159 三次假失败都源于此；
#     真实数量请跑 `node scripts/version.js list`。）
#   本脚本把这条链固化成一次调用，漏做任何一步都会当场红。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${PROD_HOST:-root@111.231.167.192}"
SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=15 -o ServerAliveInterval=15)
PROD_INDEX="/var/www/html/index.html"
PROD_SERVER_JS="/opt/prod-server/server.js"
CURL_REMOTE="curl -sk --max-time 15"
FP_LOG="ops/releases.log"

MODE="${1:-preflight}"
case "$MODE" in
  preflight|deploy) ;;
  -h|--help|help) sed -n '2,20p' "$0"; exit 0 ;;
  *) echo "❌ 未知模式：$MODE（可用：preflight | deploy）" >&2; exit 2 ;;
esac

step() { printf '\n========== [%s] %s ==========\n' "$1" "$2"; }
ok()   { printf '✅ %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\n❌ %s\n' "$*" >&2; exit 1; }

rsh() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }
md5_of() { md5sum "$1" | awk '{print $1}'; }

printf '模式：%s\n目标：%s\n' "$MODE" "$HOST"

# ------------------------------------------------------------
step 1/5 "语法校验（js/*.js + index.html 内联块）"
node tests/check-syntax.js || die "语法校验失败 —— 修完再发版"
ok "语法通过"

# ------------------------------------------------------------
step 2/5 "全量回归（清单驱动；清单与磁盘不一致会直接红，一个测试都不跑）"
bash scripts/test.sh || die "回归失败 —— 禁止部署"
ok "回归通过"

# ------------------------------------------------------------
step 3/5 "版本一致性（单一真源 VERSION → 全部落点）"
node scripts/version.js check || die "版本号落点与 VERSION 不一致 —— 执行 node scripts/version.js sync 后重试"
BUILD="$(node -e "const fs=require('fs');const m=fs.readFileSync('VERSION','utf8').match(/^BUILD\s*=\s*(\S+)/m);process.stdout.write(m?m[1]:'')")"
PREV="$(node -e "const fs=require('fs');const m=fs.readFileSync('VERSION','utf8').match(/^PREV\s*=\s*(\S+)/m);process.stdout.write(m?m[1]:'')")"
[ -n "$BUILD" ] || die "无法从 VERSION 读取 BUILD"
ok "版本 $BUILD（上一版 $PREV）"

# ------------------------------------------------------------
step 4/5 "水印可提取性（deploy.sh 的匹配口径预演）"
VER_FROM_INDEX="$(grep -oE 'build [0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+<' index.html | head -1 | sed 's/<$//' || true)"
[ -n "$VER_FROM_INDEX" ] || die "index.html 里提取不到权威水印（右下角 build div 形态漂移？）"
info "index.html 水印：$VER_FROM_INDEX"
[ "$VER_FROM_INDEX" = "build $BUILD" ] || die "index.html 水印（$VER_FROM_INDEX）与 VERSION（build $BUILD）不一致"
ok "水印与真源一致"

if [ "$MODE" = "preflight" ]; then
  step 5/5 "工作区状态（提醒，不阻断）"
  # ⚠ `|| true` 不可省：脚本是 `set -euo pipefail`，而 `grep -v` 在无可匹配行时退出码为 1，
  #   经 pipefail 聚合后整条 pipeline 返回 1 ⇒ 工作区**完全干净**时反而会静默中止。
  DIRTY="$( { git status --porcelain | grep -vE '^\?\?' || true; } | wc -l | tr -d ' ')"
  if [ "$DIRTY" -gt 0 ]; then
    info "有 $DIRTY 个已跟踪文件存在未提交改动 —— 部署前请先 commit（代码与文档分开）"
    git status --short | grep -vE '^\?\?' | head -10
  else
    ok "工作区干净"
  fi
  printf '\n🎯 preflight 全部通过。真正上线请执行：bash scripts/release.sh deploy\n'
  exit 0
fi

# ------------------------------------------------------------
step 5/5 "部署前闸门：工作区必须干净（含未跟踪的部署文件）"
# ① 已跟踪文件不得有未提交改动
DIRTY_TRACKED="$( { git status --porcelain | grep -vE '^\?\?' || true; } | wc -l | tr -d ' ')"
if [ "$DIRTY_TRACKED" -gt 0 ]; then
  { git status --short | grep -vE '^\?\?' || true; } | head -15
  die "工作区有未提交改动（$DIRTY_TRACKED 个已跟踪文件）—— 线上跑的必须能对上某个 commit，请先 commit"
fi
# ② 未跟踪的「会被部署的文件」同样危险：deploy.sh 把 index.html + js/*.js + server/server.js
#    全量 scp 上线，若某个 js 还没 git add，线上就会跑一份 git 历史里查不到的代码。
UNTRACKED_DEPLOY="$( { git status --porcelain --untracked-files=all -- index.html js server/server.js | grep '^??' || true; } | wc -l | tr -d ' ')"
if [ "$UNTRACKED_DEPLOY" -gt 0 ]; then
  { git status --porcelain --untracked-files=all -- index.html js server/server.js | grep '^??' || true; } | head -10
  die "有 $UNTRACKED_DEPLOY 个部署文件未纳入 git（deploy.sh 仍会把它们传上线）—— 先 git add 并 commit"
fi
GIT_REV="$(git rev-parse --short HEAD)"
ok "工作区干净，基于 $GIT_REV"

# ------------------------------------------------------------
printf '\n========== [deploy] 调用 deploy.sh（后端→重启→前端→nginx）==========\n'
bash deploy.sh

# ------------------------------------------------------------
printf '\n========== [verify] 线上断言（全部在服务器本地执行）==========\n'
# ⚠ 必须在服务器本地 curl：SITE 指的是服务器的回环地址，在开发机上 curl 会静默失败。
REMOTE_INDEX_MD5="$(rsh "md5sum $PROD_INDEX" | awk '{print $1}')"
LOCAL_INDEX_MD5="$(md5_of index.html)"
if [ "$REMOTE_INDEX_MD5" = "$LOCAL_INDEX_MD5" ]; then
  ok "index.html md5 一致（$LOCAL_INDEX_MD5）"
else
  die "index.html md5 不一致：本地 $LOCAL_INDEX_MD5 ≠ 线上 $REMOTE_INDEX_MD5"
fi

REMOTE_SV_MD5="$(rsh "md5sum $PROD_SERVER_JS" | awk '{print $1}')"
LOCAL_SV_MD5="$(md5_of server/server.js)"
if [ "$REMOTE_SV_MD5" = "$LOCAL_SV_MD5" ]; then
  ok "server.js md5 一致（$LOCAL_SV_MD5）"
else
  die "server.js md5 不一致：本地 $LOCAL_SV_MD5 ≠ 线上 $REMOTE_SV_MD5"
fi

SVC_STATE="$(rsh "systemctl is-active prod-server" || true)"
[ "$SVC_STATE" = "active" ] || die "prod-server 未处于 active（实际：$SVC_STATE）—— 查 journalctl -u prod-server -n 50"
ok "prod-server active"

HTTP_CODE="$(rsh "$CURL_REMOTE -o /dev/null -w '%{http_code}' https://127.0.0.1/index.html || echo 000" | tr -d '[:space:]')"
[ "$HTTP_CODE" = "200" ] || die "线上首页 HTTP 状态异常：$HTTP_CODE"
ok "线上首页 HTTP 200"

# 权威水印在线上必须**恰好 1 处**（含两侧尖括号，防注释里同名文本误计）
MARK_CNT="$(rsh "grep -cF '>build $BUILD<' $PROD_INDEX 2>/dev/null || echo 0" | tr -d '[:space:]')"
case "$MARK_CNT" in
  1) ok "线上权威水印恰好 1 处：>build $BUILD<" ;;
  0) die "线上找不到权威水印 >build $BUILD< —— 前端未生效或被回滚" ;;
  *) die "线上权威水印出现 $MARK_CNT 处（期望 1）—— 检查是否有多份水印/注释误写完整版本号" ;;
esac

JS_LIST="$(rsh "ls /var/www/html/js/ 2>/dev/null | tr '\n' ' '")"
info "线上 js：$JS_LIST"

# ------------------------------------------------------------
printf '\n========== [fingerprint] 登记发布指纹 ==========\n'
mkdir -p ops
FINGERPRINT="$(md5_of index.html)"
TS="$(date '+%Y-%m-%d %H:%M:%S')"
{
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$TS" "$BUILD" "$PREV" "$GIT_REV" "$LOCAL_INDEX_MD5" "$LOCAL_SV_MD5" "$HOST"
} >> "$FP_LOG"
ok "已登记到 $FP_LOG：$TS  $BUILD  rev=$GIT_REV  index=$LOCAL_INDEX_MD5"

printf '\n🎉 发布完成：%s（rev %s）\n' "$BUILD" "$GIT_REV"
printf '   浏览器请强刷（Ctrl+F5）后再验收。\n'
printf '   如需回滚：bash rollback.sh（前端）/ 服务器 /opt/prod-server 下 server.js.bak-* （后端）\n'
