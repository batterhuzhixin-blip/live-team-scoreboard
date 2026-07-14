# 无信用卡部署方案

Render 要求添加信用卡时，可以改用下面这些方案。

## 方案一：Cloudflare Quick Tunnel，最快可用

适合现场比赛当天临时公开访问，不需要信用卡，不需要域名。

优点：

- 不需要信用卡
- 不需要开放路由器端口
- 可以得到一个 HTTPS 公网地址
- 不需要改后端部署结构

限制：

- 运行网站的电脑必须一直开机
- 地址是随机的 `trycloudflare.com` 子域名，每次重启 tunnel 可能变化
- Quick Tunnel 官方定位是测试用途
- Quick Tunnel 不支持 SSE，本项目已加轮询兜底，大屏仍可自动刷新

使用方式：

```bash
npm start
cloudflared tunnel --url http://localhost:3000
```

终端会输出一个公网地址，例如：

```text
https://example-random.trycloudflare.com
```

访问路径：

```text
https://example-random.trycloudflare.com/rank.html
https://example-random.trycloudflare.com/score-a.html
https://example-random.trycloudflare.com/score-b.html
```

## 方案二：Cloudflare Named Tunnel，稳定域名

适合想要稳定网址的现场使用。通常不需要信用卡，但需要一个域名，并把域名接入 Cloudflare。

优点：

- 可以使用固定域名，例如 `score.example.com`
- 不需要开放本机端口
- 本机数据文件继续保留在当前电脑

限制：

- 需要域名
- 运行网站的电脑仍然必须开机

## 方案三：Vercel + 数据库，真正云端化

适合长期正式网站。Vercel Hobby 是免费计划，但本项目需要改造成 Serverless 架构，并把数据从本地 JSON 文件迁移到云数据库，例如 Supabase。

优点：

- 真正云端访问
- 不依赖你的电脑开机
- 可以绑定正式域名

限制：

- 需要改造代码
- 需要配置云数据库
- 不适合立刻当天上线

## 不推荐

- GitHub Pages：只能托管静态页面，不能运行当前 Node 后端，也不能多人实时共享分数。
- Render 免费部署：当前账号流程要求信用卡验证。
- Koyeb：官方 FAQ 说明需要信用卡验证。
