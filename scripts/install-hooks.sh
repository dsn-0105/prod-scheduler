#!/usr/bin/env bash
# ================================================================
# scripts/install-hooks.sh —— 安装 git 提交钩子（幂等，可反复执行）
# ================================================================
# 为什么钩子要入库 + 用脚本安装：
#   .git/hooks/ 不进版本库，每个新 clone / 新机器都要重装一次；若只靠口头叮嘱，
#   一定会有人漏装 → 版本锚点漂移再次发生（.144/.148/.159 就是这么伤的）。
#   故把钩子源码放 scripts/hooks/ 入库，用本脚本一键装进 .git/hooks/。
#
# 用法：
#   bash scripts/install-hooks.sh            安装/更新 pre-commit（幂等）
#   bash scripts/install-hooks.sh --status   体检（只读：不安装、不修复）
#   bash scripts/install-hooks.sh --uninstall 卸载（删 .git/hooks/pre-commit）
#
# --status 的退出码（可用于 CI / 收尾脚本）：
#   0 = 健康：存在 且 内容与 scripts/hooks/pre-commit 一致 且 sh -n 可解析 且 执行位已置位
#   1 = 不健康：缺失 / 内容不一致 / 语法不可解析 / 不可执行（任一命中即 1，并把差异打到 stderr）
#   ⚠ Windows 的 core.fileMode=false 使 `test -x` 恒为真、chmod 不落地 ⇒ 执行位一项在本机
#     **没有判别力**，故它不作为唯一依据；①②③ 三项在本机都有判别力。执行位请在 Linux/macOS/CI 复核一次。
#
# 实现方式：**复制**而非软链。
#   理由：Windows + Git Bash 下创建符号链接常因权限/开发者模式缺失而失败，
#   复制在两端行为一致（代价是改钩子源码后需重跑本脚本，故脚本会比对内容并提示）。
# ================================================================
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "[x] 无法进入仓库根目录" >&2; exit 1; }

SRC_REL="scripts/hooks/pre-commit"
SRC="$ROOT/$SRC_REL"
MODE="${1:-install}"

if [ ! -f "$SRC" ]; then
  echo "[x] 钩子源码不存在：$SRC_REL" >&2
  exit 1
fi

# git rev-parse --git-path hooks 会正确处理 .git 为目录（普通仓库）与
# .git 为文件（worktree / submodule）两种情形；返回值通常是相对仓库根的路径
HOOKS_DIR="$(git rev-parse --git-path hooks 2>/dev/null)"
if [ -z "$HOOKS_DIR" ]; then
  echo "[x] 无法定位 git hooks 目录（git rev-parse --git-path hooks 失败）" >&2
  echo "    请确认当前目录是 git 仓库：$ROOT" >&2
  exit 1
fi
DEST="$HOOKS_DIR/pre-commit"

case "$MODE" in
  --status|status)
    # ★ 只读语义：不安装、不修复、不改任何字节。
    # ★ 退出码语义（P2·D1 修复）：只要有一项不健康就 exit 1。
    #   以前这个分支无论发现什么问题都 exit 0，等于「报告当装饰」—— 在 CI/收尾脚本里
    #   完全拦不住「钩子没装/装旧了/不可执行」，属「守卫看似在守、实际不守」的同型缺陷。
    status_fail=0

    # ---------- ① 文件存在 ----------
    if [ ! -f "$DEST" ]; then
      echo "[x] 未安装：$DEST 不存在（git commit 不会做任何校验）" >&2
      echo "    安装：bash scripts/install-hooks.sh" >&2
      exit 1
    fi

    # ---------- ② 内容与源码一致（md5 比对；cmp 作为无依赖的兜底判据） ----------
    if command -v md5sum >/dev/null 2>&1; then
      src_md5="$(md5sum < "$SRC" | cut -d' ' -f1)"
      dst_md5="$(md5sum < "$DEST" | cut -d' ' -f1)"
      content_ok=1
      [ "$src_md5" = "$dst_md5" ] || content_ok=0
      hash_note="源码 md5 = $src_md5 / 钩子 md5 = $dst_md5"
    else
      content_ok=0
      cmp -s "$SRC" "$DEST" && content_ok=1
      src_md5="(md5sum 不可用)"; dst_md5="$src_md5"
      hash_note="md5sum 不可用，已退回 cmp 逐字节比对"
    fi

    if [ "$content_ok" -eq 0 ]; then
      echo "[x] 已安装但与源码**不一致**：$DEST" >&2
      echo "    $hash_note" >&2
      echo "    前者为 scripts/hooks/pre-commit（权威源码），后者为实际生效的钩子。" >&2
      echo "    差异（- 钩子现状 / + 源码，最多 40 行）：" >&2
      if command -v diff >/dev/null 2>&1; then
        diff -u --label "实际钩子 $DEST" --label "权威源码 $SRC_REL" "$DEST" "$SRC" 2>&1 \
          | sed -n '1,40p' | sed 's/^/      /' >&2
      else
        echo "      (diff 不可用，请手工比对)" >&2
      fi
      echo "    更新：bash scripts/install-hooks.sh" >&2
      status_fail=1
    fi

    # ---------- ③ 语法可解析（钩子跑不起来时 git 会直接拒绝提交，比静默跳过好，但仍应提前发现） ----------
    if ! sh -n "$DEST"; then
      echo "[x] 钩子语法不可解析：sh -n $DEST 失败（每次 commit 都会报错）" >&2
      echo "    修复：bash scripts/install-hooks.sh（用源码覆盖）" >&2
      status_fail=1
    fi

    # ---------- ④ POSIX 执行位 ----------
    # git 会**静默跳过**不可执行的钩子，所以这一项必须判红。但本机（Windows）core.fileMode=false，
    # `test -x` 恒为真、chmod 也改不动它 → 此判据在 Windows 上**没有判别力**，故不能当唯一依据
    # （上面 ①②③ 在 Windows 上都有判别力）。这里照实说明，避免「看起来守了」的错觉。
    if [ -x "$DEST" ]; then
      exec_note="已置位"
    else
      echo "[x] 钩子不可执行（git 会静默跳过它，等于没有钩子）" >&2
      echo "    修复：chmod +x $DEST" >&2
      status_fail=1
      exec_note="未置位"
    fi

    if [ "$status_fail" -eq 0 ]; then
      echo "[ok] 钩子健康：存在、内容与源码一致、sh -n 可解析、执行位=$exec_note"
      echo "     路径：$DEST"
    fi
    echo "[i] 注意：Windows（core.fileMode=false）下无法验证 POSIX 执行位 —— 本机 test -x 恒为真、" >&2
    echo "    chmod 也不落地，请在 Linux/macOS 或 CI 上再复核一次 .git/hooks/pre-commit 是否可执行。" >&2
    exit "$status_fail"
    ;;
  --uninstall|uninstall)
    if [ -f "$DEST" ]; then
      rm -f "$DEST"
      echo "[ok] 已卸载：$DEST"
    else
      echo "[..] 本就没有安装：$DEST"
    fi
    exit 0
    ;;
  install)
    ;;
  *)
    echo "[x] 未知参数：$MODE" >&2
    echo "    可用：--status | --uninstall（不带参数即安装）" >&2
    exit 1
    ;;
esac

# ---------- 安装 ----------
mkdir -p "$HOOKS_DIR" || {
  echo "[x] 无法创建 hooks 目录：$HOOKS_DIR" >&2
  exit 1
}

if [ -f "$DEST" ] && cmp -s "$SRC" "$DEST"; then
  echo "[ok] 幂等：$DEST 已是最新内容，无需重写"
else
  cp "$SRC" "$DEST" || {
    echo "[x] 复制失败：$SRC_REL -> $DEST" >&2
    exit 1
  }
  echo "[ok] 已写入：$DEST"
fi

# 复写后立即逐字节自证：防止「cp 报成功但内容不对」（历史上出现过 Edit 成功、磁盘未生效的事故）
if ! cmp -s "$SRC" "$DEST"; then
  echo "[x] 写入后自证失败：$DEST 与 $SRC_REL 内容不一致" >&2
  exit 1
fi
echo "[ok] 内容自证：与 $SRC_REL 逐字节一致"

# 可执行位：git 会**静默跳过**不可执行的钩子，必须显式设置并复核
chmod +x "$DEST" || {
  echo "[x] chmod +x 失败：$DEST" >&2
  exit 1
}
if [ ! -x "$DEST" ]; then
  echo "[x] 设置后仍不可执行：$DEST（钩子会被 git 静默跳过，请手工处理）" >&2
  exit 1
fi
echo "[ok] 已设置可执行位：$DEST"
echo "[i] 注意：Windows（core.fileMode=false）下无法验证 POSIX 执行位，请在 Linux/macOS 或 CI 上复核一次。" >&2

echo ""
echo "安装完成。钩子在每次 git commit 时运行两道闸："
echo "  ① node tests/check-syntax.js"
echo "  ② node scripts/version.js check --staged   （校验**暂存区**= 即将提交的内容）"
echo "手动试跑（不提交）：sh $SRC_REL"
echo "查看状态（不健康时退出码 1，可用于 CI）：bash scripts/install-hooks.sh --status"
echo "卸载：            bash scripts/install-hooks.sh --uninstall"
exit 0
