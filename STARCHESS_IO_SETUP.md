# starchess.io 域名获取 + 接入指南

> 状态：✅ WHOIS 确认可注册（2026-08-21 查询）
> 已确认被占用的：starchess.com / .cn / .net / .org / .ai

## 第一步：购买（需要你操作，约 5 分钟）

**推荐渠道：Cloudflare Registrar（成本价、无加价，且和后续接入最顺）**

1. 打开 https://dash.cloudflare.com ，注册/登录 Cloudflare 账号
2. 左侧菜单 → **Domain Registration**（域名注册）
3. 搜索框输入 `starchess.io` → 确认可选
4. 结算：约 **$37-40 / 年**，支持 Visa / Mastercard 信用卡（或部分借记卡）
5. 购买完成后，域名会自动出现在你账号的 DNS 管理里（不用额外配置 NS）

**备选渠道**：Namecheap / GoDaddy（支持 PayPal/支付宝），价格约 $40-60/年；买完域名后需要把 NS 指向 Cloudflare。

## 第二步：买完后回来告诉我（我来接入，约 10 分钟）

拿到域名后，把下面任意一样给我：

- **Cloudflare 账号邮箱**（推荐，我用 Quick Tunnel 升级为 Named Tunnel 需要创建 tunnel 并给你 token）
- 或 **Zone API Token**（Cloudflare dashboard → My Profile → API Tokens → Create Token，权限选 Zone:DNS:Edit）

我会做：
1. 在树莓派把 cloudflared 从临时 quick tunnel 升级为 **Named Tunnel**（固定域名，重启不失效）
2. 绑定 DNS 记录：`starchess.io` → tunnel → `http://localhost:8765`
3. 验证公网访问 `https://starchess.io` 全部功能（12 引擎 + WebSocket 对战 + 胜率图）
4. 顺手把 www.starchess.io 也指过去（可选）

## 完成后效果

| 项 | 之前（临时） | 之后（正式） |
|---|---|---|
| 地址 | admission-decided-penny-warranty.trycloudflare.com | **https://starchess.io** |
| 稳定性 | 进程/重启后失效 | 固定，长期有效 |
| 分享 | 临时链接 | 正式域名 |

## 常见问题

- **能用支付宝吗**：Cloudflare Registrar 目前主要收信用卡；想用支付宝就选 Namecheap（.io 约 $44/年），买完把 NS 改到 Cloudflare。
- **.io 可以续费吗**：可以，Cloudflare 会在到期前邮件提醒，自动续费。
- **要不要买 .cn**：starchess.cn 已被"刘震"于 2026-05-14 抢注，且 .cn 需实名认证，不建议追。
