#!/bin/bash
# ============================================================
# ops/qa-backup.sh —— 质量系统数据文件每日备份（保留最近 30 份）
# ------------------------------------------------------------
# 由 qa-backup.timer 触发（每日 02:30，Persistent=true 支持开机补跑）。
#
# 为什么是「独立 timer + shell 脚本」而不是 qa-server 进程内 setInterval：
#   数据安全机制的存活不能依赖被保护的进程 —— qa-server 崩溃 / 被 stop / 正在部署重启时，
#   备份必须照常发生。systemd timer 独立于业务进程，且 systemctl list-timers 可见。
#
# 两个刻意的守卫：
#   ① 源文件不存在 ⇒ 直接失败退出，**不生成空备份**（空备份会挤掉好快照）
#   ② 源文件 JSON 非法 ⇒ 跳过本次备份并退出非 0，**绝不用坏快照挤掉好快照**
# 幂等：同日重复执行覆盖同名快照（data-qa.YYYYMMDD.json）
# ============================================================
set -euo pipefail

SRC=/opt/qa-server/data-qa.json
DIR=/opt/qa-server/backups
KEEP=30
NODE=/usr/bin/node

[ -f "$SRC" ] || { echo "❌ 源文件不存在: $SRC（拒绝生成空备份）"; exit 1; }

mkdir -p "$DIR"

# 先校验源文件是合法 JSON：坏文件不备份，避免用坏快照挤掉好快照
"$NODE" -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$SRC" \
  || { echo "❌ 源文件 JSON 非法，本次跳过备份（原文件未改动）"; exit 1; }

DST="$DIR/data-qa.$(date +%Y%m%d).json"
# 先写 .tmp 再 mv：同目录 rename 原子，避免留下半份快照
cp -p "$SRC" "$DST.tmp"
mv "$DST.tmp" "$DST"
echo "✅ 备份完成: $DST ($(stat -c%s "$DST") bytes)"

# 轮换：按 mtime 倒序，保留最新 $KEEP 份，其余删除
ls -1t "$DIR"/data-qa.*.json 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "   轮换删除: $old"
done
echo "当前保留: $(ls -1 "$DIR"/data-qa.*.json 2>/dev/null | wc -l) 份"
