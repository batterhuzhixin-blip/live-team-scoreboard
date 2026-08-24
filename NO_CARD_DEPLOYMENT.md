# 无信用卡临时访问方案

Cloudflare Quick Tunnel 适合测试或比赛当天临时访问，不要求开放路由器端口，但运行网站的电脑必须保持开机，随机公网地址在重启后可能变化。

1. 安装 Node.js 18+ 与 `cloudflared`。
2. 复制 `.env.example` 为 `.env`，设置全部口令；需要局域网访问时将 `HOST` 设置为 `0.0.0.0`。
3. 在项目目录运行 `npm install` 和 `npm start`。
4. 分别启动两个隧道：

```bash
cloudflared tunnel --url http://localhost:3000
cloudflared tunnel --url http://localhost:3001
```

第一个地址用于计分系统，第二个地址用于题库。由于计分服务在本机直接读取本机题库接口，两个隧道无需互相配置。

限制：Quick Tunnel 面向临时测试，不承诺固定域名或正式生产可用性。完整部署建议见 [PORTABLE_SETUP.md](PORTABLE_SETUP.md)。
