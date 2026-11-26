#!/bin/bash
# ============================================================
# sync-expert-doc.sh —— 把仓库知识【单向】同步到专家包
# ============================================================
# 真源（唯一可手改）：仓库内 docs/
#   · docs/kb/00-铁律速查.md   （L0，冷启动必读）
#   · docs/系统知识.md          （L1，业务知识主体）
#   · docs/kb/版本时间线.md      （L2，历史归档）
#
# 副本（只读，禁止手改，会被本脚本覆盖）：
#   $CHENWEI_EXPERT_DIR/skills/chenwei-knowledge/references/
#
# 用法：
#   bash scripts/sync-expert-doc.sh            # dry-run：只比对，不写
#   bash scripts/sync-expert-doc.sh --apply    # 真正覆盖副本（先自动备份被覆盖文件）
#
# 为什么要单向：此前仓库与专家包各维护一份 500KB 文件，两边会各自漂移，
# 「哪份是最新的」无人能答。定仓库为真源后，专家包只作分发副本。
# ============================================================
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
EP="${CHENWEI_EXPERT_DIR:-C:/Users/WINDOWS/.workbuddy/plugins/marketplaces/my-experts/plugins/chenwei-prod-scheduler}"
REF="$EP/skills/chenwei-knowledge/references"
MODE="${1:-dry-run}"

SRCS=(
  "docs/kb/00-铁律速查.md|00-铁律速查.md"
  "docs/系统知识.md|系统知识.md"
  "docs/kb/版本时间线.md|版本时间线.md"
)

echo "仓库：$REPO"
echo "专家包：$REF"
echo "模式：$MODE"
echo ""

if [ ! -d "$REF" ]; then
  echo "❌ 专家包 references 目录不存在：$REF"
  echo "   可用环境变量 CHENWEI_EXPERT_DIR 指定专家包根目录。"
  exit 1
fi

md5of() { md5sum "$1" 2>/dev/null | cut -d' ' -f1; }

DIFF=0
printf "%-24s %-10s %-10s %s\n" "文件" "仓库md5" "副本md5" "状态"
printf "%-24s %-10s %-10s %s\n" "------------------------" "----------" "----------" "----"

for pair in "${SRCS[@]}"; do
  SRC="$REPO/${pair%%|*}"
  DST="$REF/${pair##*|}"
  if [ ! -f "$SRC" ]; then
    echo "❌ 缺少源文件：$SRC"
    exit 1
  fi
  S=$(md5of "$SRC")
  D=$(md5of "$DST")
  if [ -z "$D" ]; then
    STATE="副本缺失 → 需要生成"
    DIFF=$((DIFF + 1))
  elif [ "$S" = "$D" ]; then
    STATE="已一致"
  else
    STATE="有差异 → 需要覆盖"
    DIFF=$((DIFF + 1))
  fi
  printf "%-24s %-10s %-10s %s\n" "${pair##*|}" "${S:0:8}" "${D:0:8}" "$STATE"
done

echo ""
if [ "$DIFF" -eq 0 ]; then
  echo "✅ 全部一致，无需同步。"
  exit 0
fi

if [ "$MODE" != "--apply" ]; then
  echo "⚠ 有 $DIFF 个文件需要同步。当前为 dry-run，未做任何写入。"
  echo "  确认后执行：bash scripts/sync-expert-doc.sh --apply"
  exit 0
fi

STAMP=$(date +%Y%m%d_%H%M%S)
echo "开始同步（备份后缀 .bak-$STAMP）..."
for pair in "${SRCS[@]}"; do
  SRC="$REPO/${pair%%|*}"
  DST="$REF/${pair##*|}"
  if [ -f "$DST" ]; then
    cp "$DST" "$DST.bak-$STAMP"
  fi
  cp "$SRC" "$DST"
  if [ "$(md5of "$SRC")" != "$(md5of "$DST")" ]; then
    echo "❌ 覆盖后 md5 不一致：${pair##*|}"
    exit 1
  fi
  echo "✅ ${pair##*|}"
done

cat > "$REF/README.md" <<'EOF'
# references/ —— 专家包知识副本（只读，禁止手改）

本目录文件**由仓库单向生成**，真源在：

```
D:/WorkBuddy Data/2026-08-23-16-46-08/prod-scheduler/docs/
```

| 文件 | 层 | 来源 | 说明 |
|---|---|---|---|
| `00-铁律速查.md` | L0 | `docs/kb/00-铁律速查.md` | **冷启动先读这一份**（~8KB） |
| `系统知识.md` | L1 | `docs/系统知识.md` | 业务知识主体，按章节读，勿整读 |
| `版本时间线.md` | L2 | `docs/kb/版本时间线.md` | 历史归档，只 grep 不整读 |

同步命令（在仓库目录下执行）：

```bash
bash scripts/sync-expert-doc.sh            # 先 dry-run 看差异
bash scripts/sync-expert-doc.sh --apply    # 确认后覆盖（自动备份）
```

**手改本目录任何文件都会在下次同步时被覆盖。** 要改内容请改仓库源文件。
EOF

echo "✅ 同步完成，并已重建 references/README.md"
