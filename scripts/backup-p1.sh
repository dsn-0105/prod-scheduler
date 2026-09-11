#!/bin/bash
# ============================================================
# P1 地基轮 · 改动前备份脚本（零依赖 / 不联网 / 只读源文件）
#
# 用法：  bash scripts/backup-p1.sh
#
# 产物（沿用仓库既有约定 backups/<文件名>.bak-YYYYMMDD_HHMM-<用途>）：
#   backups/index.html.bak-<TS>-pre-p1tx        # 单文件 SPA（含 3 块内联 script）
#   backups/server.js.bak-<TS>-pre-p1tx         # 零依赖 Node 后端
#   backups/deploy.yml.bak-<TS>-pre-p1tx        # GitHub Pages 部署流程
#   backups/js/<文件名>.bak-<TS>-pre-p1tx       # js/*.js 逐个备份
#   backups/p1-backup-<TS>.manifest.txt         # 备份清单 + sha256（可核对完整性）
#
# 设计依据：docs/P1地基轮设计-2026-09-11.md §10.1
#
# 安全约束：
#   - 只读源文件、只写 backups/（.gitignore 已覆盖 backups/ 与 *.bak，绝不入库）
#   - 不执行任何 git 操作（不 add / 不 commit / 不 push）
#   - 不修改任何源文件；重复执行安全（按时间戳追加，不覆盖历史备份）
# ============================================================
set -euo pipefail

# 仓库根 = 本脚本所在目录的上一级
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS="$(date +%Y%m%d_%H%M)"
SUFFIX="pre-p1tx"
DEST="$ROOT/backups"
MANIFEST="$DEST/p1-backup-${TS}.manifest.txt"

# 待备份文件（相对仓库根）
FILES=(
  "index.html"
  "server/server.js"
  ".github/workflows/deploy.yml"
)

mkdir -p "$DEST"
mkdir -p "$DEST/js"

printf '%s\n' "P1 地基轮 · 改动前备份" "时间戳: $TS" "用途后缀: $SUFFIX" "仓库根: $ROOT" "" > "$MANIFEST"

backup_one() {
  # $1 = 相对路径  $2 = 备份目录
  local rel="$1" dir="$2"
  local src="$ROOT/$rel"
  if [ ! -f "$src" ]; then
    echo "  [跳过] 源文件不存在: $rel" | tee -a "$MANIFEST"
    return 0
  fi
  local base out
  base="$(basename "$rel")"
  out="$dir/${base}.bak-${TS}-${SUFFIX}"
  cp -p "$src" "$out"
  local size hash
  size="$(wc -c < "$src" | tr -d ' ')"
  hash="$(sha256sum "$src" | awk '{print $1}')"
  echo "  [备份] $rel -> ${out#$ROOT/}  (${size} bytes, sha256 ${hash:0:12}…)"
  printf '%s\t%s\t%s\t%s\n' "$rel" "${out#$ROOT/}" "$size" "$hash" >> "$MANIFEST"
}

echo "[1/2] 备份核心文件…"
for f in "${FILES[@]}"; do
  backup_one "$f" "$DEST"
done

echo "[2/2] 备份 js/*.js…"
shopt -s nullglob
JS_FILES=("$ROOT"/js/*.js)
if [ ${#JS_FILES[@]} -eq 0 ]; then
  echo "  [警告] 未找到 js/*.js" | tee -a "$MANIFEST"
else
  for abs in "${JS_FILES[@]}"; do
    backup_one "js/$(basename "$abs")" "$DEST/js"
  done
fi
shopt -u nullglob

echo ""
echo "✅ 备份完成。清单：${MANIFEST#$ROOT/}"
echo "   恢复示例： cp \"backups/index.html.bak-${TS}-${SUFFIX}\" index.html"
