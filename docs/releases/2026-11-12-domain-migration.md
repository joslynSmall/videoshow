# 域名迁移记录：videoshow.jiongka.online → video.jiongka.dpdns.org

**日期：** 2026-11-12

## 背景

- https://videoshow.jiongka.online 无法访问。查证：jd 上的 `videoshow.service` 与 nginx 配置本身正常，证书（2026-10-18 至 2027-01-16）也有效；真正原因是 `jiongka.online` 域名过期，DNSPod 清掉了全部记录，子域名 NXDOMAIN，主域名被解析到域名停放页。
- 服务本身没动，仍在 jd 上跑（`127.0.0.1:3010`）。

## 变更

- 新生产地址：https://video.jiongka.dpdns.org（Cloudflare 仅 DNS，A 记录 → hk `165.154.3.166`）。
- 入口链路改为 jd → hk SSH 反向隧道 + hk nginx（见 `docs/deployment.md`）。jd 服务本身未动。
- hk 上新建 nginx 站点 `video.jiongka.dpdns.org`（80 跳 https，443 反代 `127.0.0.1:8611`，`/api/media` 与 `/` 均不缓冲），用 certbot webroot 签发证书，到期 2027-02-10。
- frp 方案已验证不可行并废弃：jd 的 frpc（0.39.1）登录成功，但每次请求都报 `work connection closed before response StartWorkConn message: EOF`，8611 时有时无；`frpc-videoshow.service` 已禁用。
- jd 上 `/etc/nginx/sites-available/videoshow` 旧站点配置已失效，未删除。
- 代码发布流程本身没变：仍是备份 `/opt/videoshow` → rsync（保留服务器 `.env.local`）→ 离线测试 → `systemctl restart videoshow`；Vercel 仍是 `vercel --prod --yes`。

## 验证结果（2026-11-12）

- hk 上 `127.0.0.1:8611/api/health` 三次均为 200；经 nginx 的 HTTPS 本地测试 200。
- 公网 `https://video.jiongka.dpdns.org/api/health` 返回 200 `{"ok":true,"service":"videoshow"}`；首页 200，标题 videoshow · 视频解析。
- 备注：从本机经 Mihomo Fake-IP 首次打开约 3–5 秒，hk 本地秒回；属本机代理建连慢，不是服务端问题。
