#!/usr/bin/env bash
# 一键部署到树莓派：全量同步 public/（排除引擎大文件）+ admin.js + 文学正文文件。
# 绝不覆盖 Pi 上的 admin 用户数据（accounts/literature/sessions/trainer 等）。
set -euo pipefail
cd "$(dirname "$0")"
[ -n "${PI_PASS:-}" ] || { echo "请先设置 PI_PASS 环境变量"; exit 1; }
echo "== 打包 =="
rm -rf /tmp/deploy_acl && mkdir -p /tmp/deploy_acl/star-ai-board
# public/ 全量（排除引擎二进制与棋子缓存等大文件）
rsync -a --exclude 'uploads' --exclude 'stockfish' --exclude 'reckless' --exclude 'katago' --exclude 'engines' --exclude '*.nnue' \
  public/ /tmp/deploy_acl/star-ai-board/public/
cp admin.js /tmp/deploy_acl/star-ai-board/
cp uploads.js /tmp/deploy_acl/star-ai-board/        # 附件上传模块（文学/对局评论区共用）
cp rooms.js /tmp/deploy_acl/star-ai-board/          # 对局房间模块（server.js / routes/rooms.js 都 require 它）
cp server.js /tmp/deploy_acl/star-ai-board/         # WS 房间广播与残局 AI 接口都在 server.js
mkdir -p /tmp/deploy_acl/star-ai-board/admin
cp admin/literature_content.json /tmp/deploy_acl/star-ai-board/admin/
rsync -a routes/ /tmp/deploy_acl/star-ai-board/routes/
tar czf /tmp/deploy_acl.tar.gz -C /tmp/deploy_acl star-ai-board
echo "  包内文件数: $(tar tzf /tmp/deploy_acl.tar.gz | wc -l | tr -d ' ')"
echo "== 上传 =="
expect /tmp/scp.exp /tmp/deploy_acl.tar.gz /home/pi/deploy_acl.tar.gz
echo "== 解包 + 重启 + 自检 =="
expect /tmp/rc.exp "cd /home/pi && tar -xzf deploy_acl.tar.gz && rm -f deploy_acl.tar.gz && sudo systemctl restart star-ai-board && sleep 3 && systemctl is-active star-ai-board cloudflared && curl -s -o /dev/null -w 'literature:%{http_code}\n' http://localhost:8765/api/literature && grep -c 'isDragSettling' star-ai-board/public/js/chess-motion.js && ls -l star-ai-board/admin/literature_content.json | awk '{print \$5, \$9}'"
