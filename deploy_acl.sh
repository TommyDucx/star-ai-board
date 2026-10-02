#!/usr/bin/env bash
# 一键部署「文学作品权限 + 通知栏 + 按钮圆角」相关文件到树莓派。
# 只推代码与内容文件，绝不覆盖 Pi 上的 admin 数据（accounts/literature/sessions 等）。
set -euo pipefail
cd "$(dirname "$0")"
PI=pi@192.168.0.107
FILES=(
  "admin.js"
  "admin/literature_content.json"
  "public/index.html"
  "public/account.html" "public/assessment.html" "public/chess.html" "public/go.html"
  "public/main.html" "public/review.html" "public/tactics.html"
  "public/me/index.html"
  "public/css/site.css"
)
echo "== 打包 =="
rm -rf /tmp/deploy_acl && mkdir -p /tmp/deploy_acl/star-ai-board
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "  ✗ 缺文件 $f"; exit 1; }
  mkdir -p "/tmp/deploy_acl/star-ai-board/$(dirname "$f")"
  cp "$f" "/tmp/deploy_acl/star-ai-board/$f"
  echo "  + $f"
done
tar czf /tmp/deploy_acl.tar.gz -C /tmp/deploy_acl star-ai-board
echo "== 上传 =="
PI_PASS="${PI_PASS:?请设置 PI_PASS 环境变量}" expect /tmp/scp.exp /tmp/deploy_acl.tar.gz /home/pi/deploy_acl.tar.gz
echo "== 解包 + 重启 =="
PI_PASS="$PI_PASS" expect /tmp/rc.exp "cd /home/pi && tar -xzf deploy_acl.tar.gz && rm -f deploy_acl.tar.gz && sudo systemctl restart star-ai-board && sleep 3 && systemctl is-active star-ai-board cloudflared && curl -s -o /dev/null -w 'literature:%{http_code}\n' http://localhost:8765/api/literature && grep -c 'notif-btn' star-ai-board/public/index.html && grep -c 'btn-radius' star-ai-board/public/css/site.css && ls -l star-ai-board/admin/literature_content.json | awk '{print \$5, \$9}'"
echo "== 完成：本地 md5 对照 =="
md5 -q admin.js public/index.html public/me/index.html public/css/site.css
