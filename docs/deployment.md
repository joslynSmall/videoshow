# videoshow 生产部署（现状）

- 生产地址：https://video.jiongka.dpdns.org
- Vercel：https://videoshow-six.vercel.app（仅 HTTP 解析渠道；无 Chrome）

## 拓扑

```text
浏览器
  │  https://video.jiongka.dpdns.org
  ▼
hk (165.154.3.166) nginx：video.jiongka.dpdns.org
  │  443 SSL（Let's Encrypt，2027-02-10 到期，certbot webroot 自动续期）
  │  proxy_pass http://127.0.0.1:8611（/api/media 与 / 均 proxy_buffering off，超时 120s）
  ▼
jd → hk SSH 反向隧道：ssh-videoshow-tunnel.service
  │  jd 上以 root 运行：ssh -R 127.0.0.1:8611:127.0.0.1:3010 ubuntu@165.154.3.166
  │  密钥 /root/.ssh/id_ed25519_hk，断线自动重连、开机自启
  ▼
jd (36.150.237.90) videoshow.service
   WorkingDirectory /opt/videoshow，监听 127.0.0.1:3010
   node --experimental-websocket src/server.js，ENABLE_BROWSER_PROVIDER=true
```

## 关键说明

- 代码部署只动 jd：备份 `/opt/videoshow` → rsync 同步（保留服务器 `.env.local`）→ jd 上跑离线测试 → `systemctl restart videoshow`。hk 的 nginx 与隧道与代码版本无关，代码发布不用动它们。
- `/opt/videoshow` 不是 git 仓库（rsync 同步的），已部署版本以发布记录和备份目录名（`/opt/videoshow.backup-...`）为准，不要拿本地 git 提交号去对。
- 旧域名 https://videoshow.jiongka.online 已失效：`jiongka.online` 于 2026-11-12 前过期，DNSPod 清掉了全部记录（NXDOMAIN，主域名被停放）。jd 上 `/etc/nginx/sites-available/videoshow` 那个旧站点配置已失效，尚未删除，仅作遗留记录。
- 不要用 frp 接 jd：jd 的 frpc（0.39.1）登录成功，但每次请求都报 `work connection closed before response StartWorkConn message: EOF`，8611 时有时无；`frpc-videoshow.service` 已禁用。hk 的 frps 本身正常（本地 muse2api 的 8610 在用），问题只出在 jd 这条 frp 链路上。

## 发布 jd

1. 备份：jd 上 `cp -a /opt/videoshow /opt/videoshow.backup-<时间戳>`。
2. rsync 同步代码到 `/opt/videoshow`，保留服务器 `.env.local`。
3. jd 上跑离线测试（在 `/opt/videoshow` 下 `npm test`）。
4. `systemctl restart videoshow`；确认 `systemctl status videoshow.service` 为 active。
5. 按验证清单验证。

## 发布 Vercel

- `vercel --prod --yes`；项目未开启 Git 自动部署。
- 回滚：回退上一部署。

## 回滚 jd

- 恢复发布前备份目录到 `/opt/videoshow` 并 `systemctl restart videoshow`。
- 回滚后同样走验证清单；只回滚代码修不好隧道/证书问题。

## 验证清单（发布后必做）

- jd：`systemctl is-active videoshow.service ssh-videoshow-tunnel.service` 均为 active；`curl http://127.0.0.1:3010/api/health` 返回 `{"ok":true,...}`。
- hk：`curl http://127.0.0.1:8611/api/health` 返回 200；`ss` 能看到 `127.0.0.1:8611` 在监听。
- 公网：`curl https://video.jiongka.dpdns.org/api/health` 返回 200；打开首页能看到 videoshow 播放页。
- 失败定位：公网 502 且 hk 上 8611 不通 → 查隧道（jd 上 `systemctl status ssh-videoshow-tunnel`）；8611 通但 nginx 502 → 查 hk nginx 错误日志；证书问题 → hk 上 `certbot renew --dry-run`。

## 证书与 DNS

- hk 上 `/etc/letsencrypt/live/video.jiongka.dpdns.org/`，签发方式 webroot（`/var/www/certbot`），ECDSA，到期 2027-02-10，certbot 已设自动续期。
- 域名 DNS 在 Cloudflare：`video.jiongka.dpdns.org` A 记录 → `165.154.3.166`，仅 DNS（灰色云朵），不要切回橙色代理，SSE 长连接会被 Cloudflare 缓冲/截断。
