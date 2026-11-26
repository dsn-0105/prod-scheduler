#!/usr/bin/env bash
# ============================================================
# scripts/check-deploy-drift.sh —— 三套系统「线上 vs 本地」齐套性检查（只读）
# ------------------------------------------------------------
# 【为什么存在（2026-11-26 事故复盘）】
#   仓库里有 3 个前端系统、3 个**互不包含**的部署脚本：
#     deploy.sh        → 生产 index.html + js/*.js + 生产后端（server/server.js）
#     deploy-qa.sh     → 质量系统 /quality/（index.html + qa-core.js + qa-app.js + qa-server）
#     deploy-admin.sh  → 管理员后台 /admin/（index.html + admin-app.js）
#   build .164 把「管理员后台」加进三处 SYSTEMS 副本，那轮只跑了 deploy.sh + deploy-admin.sh，
#   漏跑 deploy-qa.sh ⇒ 线上 /quality/qa-app.js 停在 .163 旧字节 ⇒ 用户在质量系统左上角
#   下拉里看不到「管理员后台」，而生产系统里看得到。
#
#   源码级测试（tests/qa.systems-switch.test.js）只校验三处副本**彼此一致**，
#   它看不出「线上还是旧字节」，所以全绿也拦不住这次事故。
#   本脚本补的就是这个真空：**信线上字节，不信源码**。
#
# 【判定口径】逐字节 md5 比对：本地仓库文件 vs 线上 nginx 静态目录同名文件。
#   不做语义比较——前端是静态文件，字节不同即等价于「未部署」。
#   缺文件与内容不同都算漂移，并明确指出「该去跑哪个脚本」。
#
# 【行为边界】全程**只读**：只执行本地 md5sum 与远端 md5sum。
#   不上传、不删除、不重启服务、不碰任何数据文件。三套系统刻意隔离，
#   本脚本**绝不**代替你去部署。
#
# 【退出码】0 = 三套系统全部一致；1 = 存在漂移或缺文件。
#   调用方若只想告警不想阻塞，用 `|| true` 或 `|| echo ...`（deploy.sh 就是这么用的）。
#
# 用法：bash scripts/check-deploy-drift.sh
#      DRIFT_HOST=root@1.2.3.4 bash scripts/check-deploy-drift.sh
#      DRIFT_LOCAL_ROOT=/tmp/probe bash scripts/check-deploy-drift.sh   # 仅供自证验红，勿日常使用
# ============================================================
set -uo pipefail

# 本地根：默认是仓库根（本脚本在 scripts/ 下）。DRIFT_LOCAL_ROOT 只是为了让
# 「这个检查真的会在已知漂移输入上报红」可以自证一次，不是给你日常切目录用的。
ROOT="${DRIFT_LOCAL_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT" || { echo "❌ 无法进入本地根目录：$ROOT" >&2; exit 2; }

HOST="${DRIFT_HOST:-root@111.231.167.192}"
SSH="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 $HOST"

drift=0

# check <显示名> <本地相对路径> <线上绝对路径> <该跑哪个脚本>
check() {
  local label="$1" local_f="$2" remote_f="$3" deployer="$4"
  if [ ! -f "$local_f" ]; then
    printf '   ⚠️  %s：本地缺少 %s（跳过该项，无法判定）\n' "$label" "$local_f"
    return 0
  fi
  local l r
  l="$(md5sum "$local_f" | cut -d' ' -f1)"
  r="$($SSH "md5sum '$remote_f' 2>/dev/null | cut -d' ' -f1" 2>/dev/null | tr -d '\r' | head -1)"
  if [ -z "$r" ]; then
    printf '   ⚠️  %s：线上缺 %s\n        ⇒ 需执行 bash %s\n' "$label" "$remote_f" "$deployer"
    drift=1
  elif [ "$l" != "$r" ]; then
    printf '   ⚠️  %s：线上是旧版\n        本地 %s\n        线上 %s\n        ⇒ 需执行 bash %s\n' \
      "$label" "$l" "$r" "$deployer"
    drift=1
  else
    printf '   ✅ %s：一致（%s）\n' "$label" "$l"
  fi
}

echo "【跨系统齐套性检查】本地仓库 vs 线上静态目录（只读 · 不部署）"
check "生产系统 index.html"      "index.html"          "/var/www/html/index.html"         "deploy.sh"
check "质量系统 qa-app.js"       "quality/qa-app.js"   "/var/www/html/quality/qa-app.js"  "deploy-qa.sh"
check "质量系统 index.html"      "quality/index.html"  "/var/www/html/quality/index.html" "deploy-qa.sh"
check "管理员后台 admin-app.js"  "admin/admin-app.js"  "/var/www/html/admin/admin-app.js" "deploy-admin.sh"
check "管理员后台 index.html"    "admin/index.html"    "/var/www/html/admin/index.html"   "deploy-admin.sh"

if [ "$drift" = "1" ]; then
  echo ""
  echo "⚠️  存在未同步系统：上表标 ⚠️ 的正是「本地已改、线上仍旧」的那几套。"
  echo "   本检查**不会**自动部署（三套系统刻意隔离，误部署的代价高于漏部署）。"
  echo "   请按上表提示手工执行对应脚本；执行完再跑一次本检查归零。"
  exit 1
fi
echo "✅ 三套系统线上与本地全部一致"
exit 0
