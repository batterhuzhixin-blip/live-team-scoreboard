# 现场统分网站

开放访问的比赛统分网站，包含 A 路线计分台、B 路线计分台和成绩大屏。

## 一键部署

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/batterhuzhixin-blip/live-team-scoreboard)

点击上面的按钮后，Render 会读取仓库里的 `render.yaml` 创建 Web Service。部署完成后会生成一个公开 HTTPS 地址。

## 页面地址

- 大屏：`/rank.html`
- A 路线计分台：`/score-a.html`
- B 路线计分台：`/score-b.html`
- 健康检查：`/api/health`

## 本地运行

```bash
npm start
```

默认访问：

```text
http://localhost:3000/rank.html
```

同一局域网的新设备访问时，不能使用 `localhost`，需要使用运行服务那台电脑的 IP，例如：

```text
http://192.168.1.11:3000/rank.html
```

## 部署环境变量

- `PORT`：服务端口，默认 `3000`
- `HOST`：监听地址，默认 `0.0.0.0`
- `DATA_DIR`：数据目录，默认项目内的 `data`

## 免费部署提醒

当前 `render.yaml` 使用 Render 免费 Web Service，方便快速获得公网网址。

免费服务的本地文件系统不是持久化存储。分数数据写入 `DATA_DIR/state.json`，如果服务重启、休眠恢复或重新部署，线上分数可能丢失。

正式比赛建议升级为以下方案之一：

- Render 付费 Web Service + Persistent Disk，并设置 `DATA_DIR=/var/data`
- 云数据库存储分数
- 自己的云服务器，并定期备份 `data/state.json`

## 开放访问说明

当前版本不设置登录和密码。任何拿到网址的人都可以进入计分台录入或修改分数。适合现场内控使用；如果要公开发到更大范围，建议后续增加计分台密码，只让大屏公开。
