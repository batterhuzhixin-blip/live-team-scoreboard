# 部署到 Render

仓库地址：

```text
https://github.com/batterhuzhixin-blip/live-team-scoreboard
```

一键部署：

```text
https://render.com/deploy?repo=https://github.com/batterhuzhixin-blip/live-team-scoreboard
```

## 当前免费配置

项目内的 `render.yaml` 使用免费 Web Service：

- Runtime：Node
- Plan：Free
- Build Command：`npm install`
- Start Command：`npm start`
- Health Check Path：`/api/health`
- Region：Singapore

部署完成后，Render 会生成类似下面的公开网址：

```text
https://live-team-scoreboard.onrender.com
```

## 数据持久化

当前免费配置不挂载持久化磁盘。分数数据写入服务端本地文件：

```text
DATA_DIR/state.json
```

Render 免费服务的文件系统不是持久化存储，服务重启、休眠恢复或重新部署后，线上分数可能丢失。

正式比赛建议升级为：

```yaml
plan: starter
envVars:
  - key: DATA_DIR
    value: /var/data
disk:
  name: scoreboard-data
  mountPath: /var/data
  sizeGB: 1
```

注意：`starter` 和 Persistent Disk 可能产生费用，升级前请确认 Render 账单设置。

## 自定义正式域名

如果你有自己的域名，例如：

```text
score.example.com
```

需要在 Render 添加 Custom Domain，然后到域名服务商处按 Render 提示配置 DNS 记录。配置完成后，Render 会自动签发 HTTPS 证书。

## 开放访问提醒

当前版本不设置登录密码。任何拿到网址的人都能进入 A/B 计分台修改分数。正式公开前，请确认这个开放范围符合现场管理需要。
