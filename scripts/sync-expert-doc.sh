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
#   1) $CHENWEI_EXPERT_DIR/skills/chenwei-knowledge/references/   ← 始终同步
#   2) 插件安装快照 ~/.workbuddy/plugins/cache/my-experts/<pkg>/1.0.0/
#      含 references/ + SKILL.md + agents/<pkg>.md   ← 仅 --mirror-cache 时同步
#
# 用法：
#   bash scripts/sync-expert-doc.sh                       # dry-run：只比对，不写
#   bash scripts/sync-expert-doc.sh --apply               # 覆盖专家包 references/（自动备份）
#   bash scripts/sync-expert-doc.sh --apply --mirror-cache # 额外镜像 SKILL.md/agents/缓存
#
# 为什么需要 --mirror-cache：插件缓存里的 SKILL.md 与 agents 不受 references 同步影响，
# 改这两处或重装插件后缓存会静默漂移（2026-11-26 实测：缓存主文件曾停在 10-31 的旧版本）。
#
# 为什么要单向：此前仓库与专家包各维护一份 500KB 文件，两边会各自漂移，
# 「哪份是最新的」无人能答。定仓库为真源后，专家包只作分发副本。
# ============================================================
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
EP="${CHENWEI_EXPERT_DIR:-C:/Users/WINDOWS/.workbuddy/plugins/marketplaces/my-experts/plugins/chenwei-prod-scheduler}"
REF="$EP/skills/chenwei-knowledge/references"
# 插件安装快照：派生副本，可从 $EP 完整重建，故此处不留 .bak（避免与 references 的备份混淆）
CACHE="${CHENWEI_CACHE_DIR:-C:/Users/WINDOWS/.workbuddy/plugins/cache/my-experts}/$(basename "$EP")/1.0.0"

SRCS=(
  "docs/kb/00-铁律速查.md|00-铁律速查.md"
  "docs/系统知识.md|系统知识.md"
  "docs/kb/版本时间线.md|版本时间线.md"
)

# ---------- 参数解析（可组合，兼容旧的单一 --apply 用法） ----------
APPLY=0
MIRROR=0
for arg in "$@"; do
  case "$arg" in
    ""|dry-run)     : ;;
    --apply)        APPLY=1 ;;
    --mirror-cache) MIRROR=1 ;;
    -h|--help)
      echo "用法：bash scripts/sync-expert-doc.sh [--apply] [--mirror-cache]"
      echo "  （无参数）         dry-run：只比对，不写入"
      echo "  --apply           覆盖专家包 references/（自动备份 .bak-时间戳）"
      echo "  --mirror-cache    同时把 references/ + SKILL.md + agents 镜像到插件缓存"
      exit 0 ;;
    *) echo "❌ 未知参数：$arg（可用 --help 查看）"; exit 1 ;;
  esac
done
MODE=$([ "$APPLY" -eq 1 ] && echo "--apply" || echo "dry-run")

echo "仓库：$REPO"
echo "专家包：$REF"
echo "模式：$MODE$([ "$MIRROR" -eq 1 ] && echo " +mirror-cache" || echo "")"
if [ "$MIRROR" -eq 1 ]; then
  if [ -d "$CACHE" ]; then
    echo "缓存：$CACHE"
  else
    echo "缓存：$CACHE  ⚠ 目录不存在，镜像将跳过"
  fi
fi
echo ""

if [ ! -d "$REF" ]; then
  echo "❌ 专家包 references 目录不存在：$REF"
  echo "   可用环境变量 CHENWEI_EXPERT_DIR 指定专家包根目录。"
  exit 1
fi

# 注意：中文/特殊字符文件名下，md5sum 可能在行首加 '\' 转义标记 ⇒ 必须剥离，
# 否则同一文件会被判成「不一致」（2026-11-26 实测踩到）。
md5of() { md5sum -- "$1" 2>/dev/null | awk '{print $1}' | tr -d '\\'; }

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
if [ "$DIFF" -gt 0 ] && [ "$APPLY" -eq 0 ]; then
  echo "⚠ 有 $DIFF 个文件需要同步。当前为 dry-run，未做任何写入。"
  echo "  确认后执行：bash scripts/sync-expert-doc.sh --apply [--mirror-cache]"
  exit 0
fi
if [ "$DIFF" -eq 0 ]; then
  echo "✅ references/ 全部一致，无需覆盖。"
  if [ "$MIRROR" -eq 0 ]; then
    exit 0
  fi
fi

if [ "$DIFF" -gt 0 ]; then
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
bash scripts/sync-expert-doc.sh                        # 先 dry-run 看差异
bash scripts/sync-expert-doc.sh --apply                # 覆盖本目录（自动备份）
bash scripts/sync-expert-doc.sh --apply --mirror-cache # 同时镜像 SKILL.md/agents 到插件缓存
```

**手改本目录任何文件都会在下次同步时被覆盖。** 要改内容请改仓库源文件。
EOF

echo "✅ 同步完成，并已重建 references/README.md"
fi

# ---------- 镜像到插件安装快照（仅 --mirror-cache） ----------
# 背景：cache 里的 SKILL.md 与 agents/ 不被 references 同步覆盖，会静默漂移。
if [ "$MIRROR" -eq 1 ]; then
  echo ""
  if [ ! -d "$CACHE" ]; then
    echo "⚠ 缓存目录不存在，跳过镜像：$CACHE"
    echo "  首次安装专家包后会生成；或用 CHENWEI_CACHE_DIR 指定插件缓存根目录。"
  else
    echo "镜像到缓存：$CACHE"
    CREF="$CACHE/skills/chenwei-knowledge/references"
    mkdir -p "$CREF"
    FAIL=0
    mirror_one() {
      src="$1"; dst="$2"; label="$3"
      if [ ! -f "$src" ]; then
        echo "  ⚠ 源缺失，跳过：$label"
        return 0
      fi
      cp "$src" "$dst"
      if [ "$(md5of "$src")" = "$(md5of "$dst")" ]; then
        echo "  ✅ $label"
      else
        echo "  ❌ $label（覆盖后 md5 不一致）"
        FAIL=1
      fi
    }
    for f in "00-铁律速查.md" "系统知识.md" "版本时间线.md" "README.md"; do
      mirror_one "$REF/$f" "$CREF/$f" "references/$f"
    done
    mirror_one "$EP/skills/chenwei-knowledge/SKILL.md" \
               "$CACHE/skills/chenwei-knowledge/SKILL.md" "SKILL.md"
    mirror_one "$EP/agents/$(basename "$EP").md" \
               "$CACHE/agents/$(basename "$EP").md" "agents/$(basename "$EP").md"
    if [ "$FAIL" -eq 0 ]; then
      echo "✅ 缓存镜像完成，md5 全部一致"
    else
      echo "❌ 缓存镜像存在不一致，请检查"
      exit 1
    fi
  fi
fi
