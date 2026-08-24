# 财务趣味竞赛在线系统

本仓库同时包含两个互相同步的 Node.js 网站：

- 在线计分系统：A/B 路线计分台、计分口令、完赛加分和成绩大屏。
- 在线题库：队伍注册、A/B 路线题库权限、独立答题记录、Excel 题库导入和管理台。

题库中的队伍会自动同步到计分系统；运行数据保存在本地 JSON 文件中，不提交到 Git。

## 三分钟本地启动

需要 Node.js 18 或更高版本。

```bash
npm install
npm start
```

默认地址：

| 系统 | 地址 | 开发默认口令 |
| --- | --- | --- |
| 成绩大屏 | `http://localhost:3000/rank.html` | 无 |
| A 路线计分台 | `http://localhost:3000/score-a.html` | `score-a-local` |
| B 路线计分台 | `http://localhost:3000/score-b.html` | `score-b-local` |
| 选手题库 | `http://localhost:3001/` | 队伍自行注册 |
| 题库管理 | `http://localhost:3001/admin.html` | `admin123` |

默认值只允许从本机访问。正式比赛或局域网共享前，复制 `.env.example` 为 `.env`，修改全部口令，并按需把 `HOST` 改为 `0.0.0.0`。

## 常用命令

```bash
npm start                 # 同时启动题库与计分系统
npm run start:quiz        # 只启动题库，使用 PORT 等通用环境变量
npm run start:scoreboard  # 只启动计分系统
npm test                  # 语法检查与全部集成测试
```

## 数据与备份

使用 `npm start` 时，数据默认分别保存在：

- `data/quiz/quiz-state.json`
- `data/scoreboard/state.json`

迁移正式比赛数据时，先停止服务，再复制整个 `data` 目录。代码迁移包默认不含运行数据、密码、日志、`node_modules` 或 `.git` 历史。

## 部署

仓库根目录的 `render.yaml` 可一次创建两个 Render Web Service。Render Blueprint 同步时需要填写：

- `ADMIN_PASSWORD`
- `SCORE_A_PASSWORD`
- `SCORE_B_PASSWORD`

计分系统会通过 Render 私有网络自动连接题库。免费实例的文件系统不保证持久化，正式比赛必须使用持久化磁盘、云数据库，或自有服务器并定期备份。

自有 Linux 服务器配置示例位于 `deploy/`。完整的跨电脑开发、运行、部署和数据迁移步骤见 [PORTABLE_SETUP.md](PORTABLE_SETUP.md)。

## 功能说明

- A 路线可使用 1、2 分题；B 路线可使用 2、3 分题。
- 支持单选、多选、判断和带图片的看图纠错。
- 同一题每队只能作答一次，各队进度与得分隔离。
- 管理员可下载 `.xlsx` 模板，以替换或追加方式导入题库。
- 题库队伍名称与路线自动同步到计分台，计分台只维护现场计分、序号和完赛信息。
- 成绩大屏无需登录；A/B 计分台分别使用独立口令。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `HOST` | 监听地址；本机开发建议 `127.0.0.1` |
| `PORT` | 单独启动一个服务时使用的端口 |
| `SCOREBOARD_PORT` / `QUIZ_PORT` | 一键启动时两个服务的端口 |
| `SCOREBOARD_DATA_DIR` / `QUIZ_DATA_DIR` | 一键启动时两个数据目录 |
| `SCORE_A_PASSWORD` / `SCORE_B_PASSWORD` | 两个计分台口令 |
| `SCORE_AUTH_SECRET` | 计分会话签名密钥 |
| `ADMIN_PASSWORD` | 题库管理密码 |
| `QUIZ_TEAMS_URL` | 计分系统读取题库队伍的完整接口地址 |
| `QUIZ_SERVICE_HOSTPORT` | Render 等私有网络中的题库 `host:port`；未设置完整 URL 时使用 |
| `QUIZ_SYNC_INTERVAL_MS` | 队伍同步间隔，默认 15000 毫秒 |
| `DATA_DIR` | 单独启动一个服务时使用的数据目录 |
