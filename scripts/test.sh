#!/usr/bin/env bash
# ================================================================
# scripts/test.sh —— 回归测试统一入口（清单驱动，不做通配符隐式发现）
# ================================================================
# 为什么不用 `node --test tests/*.test.js`：
#   通配符是 shell 展开 + node 自动发现，两种「静默」都会咬人：
#     ① tests/ 下多出无关文件（临时探针、诊断副本）→ 被一并扫入，报假失败（.138 教训）；
#     ② 写了新的 *.test.js 却没人跑 → 永远不会红，也永远不会绿（无人知晓）。
#   本脚本以 tests/manifest.txt 为唯一输入，**缺清单或清单为空一律报错退出**，
#   绝不退化成"找不到就自动发现"的宽松行为。
#
# 用法：
#   bash scripts/test.sh                     跑清单内全部测试
#   bash scripts/test.sh --check-manifest    只校验清单与磁盘是否一致（新增/删除未登记 → 退出码 1）
#   bash scripts/test.sh --list              打印将要执行的测试文件清单
#   bash scripts/test.sh --help              帮助
#
# 兼容性：**不改** 原有 `node --test tests/*.test.js` 的可用性，两者并存。
# 退出码：0=全绿；1=有测试失败 / 清单不一致 / 清单缺失或为空
# ================================================================
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "[x] 无法进入仓库根目录" >&2; exit 1; }

MANIFEST="tests/manifest.txt"

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------
# 读取清单到全局数组 ENTRIES（自动跳过注释行 / 空行 / 行尾 CR）
# 清单缺失或读不出任何一条 → 报错退出（刻意不静默退化）
# ---------------------------------------------------------------
ENTRIES=()
load_manifest() {
  if [ ! -f "$MANIFEST" ]; then
    echo "[x] 清单缺失：$MANIFEST" >&2
    echo "    本脚本刻意不做通配符自动发现（那会把临时探针也扫进来，或让没人跑的测试静默存在）。" >&2
    echo "    请先生成清单：ls tests/*.test.js | sed 's|tests/||' | sort > $MANIFEST" >&2
    exit 1
  fi
  ENTRIES=()
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"                                    # 容忍 CRLF 清单
    line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    ENTRIES+=("$line")
  done < "$MANIFEST"

  if [ "${#ENTRIES[@]}" -eq 0 ]; then
    echo "[x] 清单为空（$MANIFEST 里没有任何有效条目）" >&2
    echo "    拒绝退化为通配符自动发现 —— 请补齐清单后重试。" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------
# 清单 ⇄ 磁盘 一致性校验
# ---------------------------------------------------------------
check_manifest() {
  local actual expected
  # 直接从磁盘取「实际清单」与实际登记的「期望清单」，各自排序后比对。
  # 刻意不用临时文件：Git Bash 下 mktemp 返回带盘符的 Windows 路径，
  # 会被本机 safe-delete 包装拦截并在 stderr 打无害噪音，进程替换更干净也更短。
  actual="$(ls tests/*.test.js 2>/dev/null | sed 's|^tests/||' | sort)"
  expected="$(printf '%s\n' "${ENTRIES[@]}" | sort)"

  if [ "$actual" = "$expected" ]; then
    echo "[ok] 清单与磁盘一致：${#ENTRIES[@]} 个测试文件"
    return 0
  fi

  echo "[x] 清单与磁盘不一致（$MANIFEST ⇄ tests/*.test.js）" >&2
  echo "" >&2
  echo "    差异如下（- 只存在于清单 / + 只存在于磁盘）：" >&2
  diff -u --label "$MANIFEST（清单）" --label "ls tests/*.test.js（磁盘）" \
    <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") | sed 's/^/    /' >&2
  echo "" >&2
  echo "    修复方式：" >&2
  echo "      · 新增了测试 → 把文件名补进 $MANIFEST 的对应升序位置" >&2
  echo "      · 删/改了测试 → 从 $MANIFEST 里同步删除/改名" >&2
  echo "      · 只是临时探针 → 不要放进 tests/（放 _diag/ 并在那里手动跑）" >&2
  echo "    一键重生成（确认磁盘上的清单才是权威时）：" >&2
  echo "      ls tests/*.test.js | sed 's|tests/||' | sort > $MANIFEST" >&2
  return 1
}

# ---------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------
MODE="${1:-run}"

case "$MODE" in
  --help|-h|help)
    usage
    exit 0
    ;;
  --check-manifest)
    load_manifest
    if check_manifest; then exit 0; else exit 1; fi
    ;;
  --list|--list-only)
    load_manifest
    echo "清单内 ${#ENTRIES[@]} 个测试文件（$MANIFEST）："
    printf '    tests/%s\n' "${ENTRIES[@]}"
    exit 0
    ;;
  run)
    ;;
  *)
    echo "[x] 未知参数：$MODE" >&2
    echo "    可用：--check-manifest | --list | --help（不带参数即执行测试）" >&2
    exit 1
    ;;
esac

load_manifest

# 先做一致性校验：登记了不存在的文件时，宁可立刻失败也不要"少跑几个还报绿"
if ! check_manifest; then
  echo "" >&2
  echo "[x] 因清单与磁盘不一致，本次**未执行**任何测试（防止漏跑/错跑后误报绿）" >&2
  exit 1
fi

# 逐个存在性兜底（check_manifest 已覆盖，这里再钉一次，防 ls 通配失败时的边界）
FILES=()
missing=0
for f in "${ENTRIES[@]}"; do
  if [ ! -f "tests/$f" ]; then
    echo "[x] 清单登记的文件不存在：tests/$f" >&2
    missing=1
  fi
  FILES+=("tests/$f")
done
if [ "$missing" -ne 0 ]; then
  exit 1
fi

echo "=== 运行 ${#FILES[@]} 个测试文件（清单驱动） ==="
node --test "${FILES[@]}"
rc=$?
echo "=== 完成，退出码 $rc ==="
exit $rc
