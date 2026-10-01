#!/usr/bin/env bash
# 个人主页双份同步：源文件（你平时编辑的那份）↔ 站点副本（线上生效的那份）
#
#   ./sync_me_home.sh            默认：按修改时间，新的覆盖旧的（逐文件判断）
#   ./sync_me_home.sh to-site    源文件 → 站点副本（强制）
#   ./sync_me_home.sh to-source  站点副本 → 源文件（强制）
#   ./sync_me_home.sh status     只对比，不写入
#
# 说明：源文件在 ~/Documents/Default Project/（仓库外，不会被 git 跟踪）；
#       站点副本在 public/me/（会被 git 跟踪并部署到树莓派）。
set -euo pipefail

SRC_DIR="$HOME/Documents/Default Project"
DST_DIR="$(cd "$(dirname "$0")" && pwd)/public/me"
FILES=("index.html" "assets/avatar.png" "assets/favicon.png" "audio/rainy_night_fm.m4a")

mode="${1:-auto}"
[ -d "$SRC_DIR" ] || { echo "✗ 找不到源目录：$SRC_DIR"; exit 1; }
[ -d "$DST_DIR" ] || { echo "✗ 找不到站点目录：$DST_DIR"; exit 1; }

mtime() { # macOS: stat -f %m ；GNU: stat -c %m
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}
same() { [ -f "$1" ] && [ -f "$2" ] && cmp -s "$1" "$2"; }

changed=0
printf "%-28s %-12s %-12s %s\n" "文件" "源文件" "站点副本" "动作"
for rel in "${FILES[@]}"; do
  s="$SRC_DIR/$rel"; d="$DST_DIR/$rel"
  if [ ! -f "$s" ] && [ ! -f "$d" ]; then printf "%-28s %-12s %-12s %s\n" "$rel" "缺失" "缺失" "跳过"; continue; fi
  if same "$s" "$d"; then printf "%-28s %-12s %-12s %s\n" "$rel" "—" "—" "一致"; continue; fi
  act="跳过"
  case "$mode" in
    to-site)   cp "$s" "$d"; act="源 → 站点"
               [ "$rel" = "index.html" ] && act="源 → 站点（★需重新部署）" ;;
    to-source) cp "$d" "$s"; act="站点 → 源" ;;
    status)    act="不一致" ;;
    *) # auto：新的覆盖旧的
       if [ ! -f "$s" ] || { [ -f "$d" ] && [ "$(mtime "$d")" -gt "$(mtime "$s")" ]; }; then
         cp "$d" "$s"; act="站点 → 源（站点较新）"
       else
         cp "$s" "$d"; act="源 → 站点（源较新）"
         [ "$rel" = "index.html" ] && act="源 → 站点（★需重新部署）"
       fi ;;
  esac
  printf "%-28s %-12s %-12s %s\n" "$rel" "$(date -r "$s" '+%m-%d %H:%M' 2>/dev/null || echo '?')" "$(date -r "$d" '+%m-%d %H:%M' 2>/dev/null || echo '?')" "$act"
  changed=1
done

echo
if [ "$mode" != "status" ] && [ "$changed" = "1" ]; then
  echo "✓ 同步完成。若 index.html 有变更，记得部署："
  echo "    cd \"$(cd "$(dirname "$0")" && pwd)\" && bash sync_to_pi.sh   # 或手动 scp public/me/ 到树莓派"
else
  echo "✓ 两份已一致，无需同步。"
fi
