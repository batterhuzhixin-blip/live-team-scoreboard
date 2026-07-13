# 部署到 Render

本项目可以部署为 Render Web Service。部署后会得到一个公开 HTTPS 地址，通常类似：

```text
https://live-team-scoreboard.onrender.com
```

## 推荐配置

- Runtime：Node
- Build Command：`npm install`
- Start Command：`npm start`
- Health Check Path：`/api/health`
- Region：Singapore
- Persistent Disk：挂载到 `/var/data`

项目内已经提供 `render.yaml`，可作为 Render Blueprint 使用。

## 为什么需要持久化磁盘

网站分数数据会写入 `DATA_DIR/state.json`。生产环境应把 `DATA_DIR` 指向持久化磁盘，例如：

```text
DATA_DIR=/var/data
```

否则服务重启、重新部署后，分数数据可能丢失。

## 自定义正式域名

如果你有自己的域名，例如：

```text
score.example.com
```

需要在 Render 添加 Custom Domain，然后到域名服务商处按 Render 提示配置 DNS 记录。配置完成后，Render 会自动签发 HTTPS 证书。

## 开放访问提醒

当前版本不设置登录密码。任何拿到网址的人都能进入 A/B 计分台修改分数。正式公开前，请确认这个开放范围符合现场管理需要。
