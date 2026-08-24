# 跨电脑开发、运行与部署指南

这份指南覆盖 GitHub 克隆、单文件迁移包、本地运行、局域网使用、Render 部署、自有 Linux 服务器部署和比赛数据迁移。

## 1. 迁移包里有什么

单文件 ZIP 包包含可直接开发的完整源码、锁定依赖版本的 `package-lock.json`、环境变量模板、测试、Render 配置和 Linux 部署示例。

出于安全和体积考虑，不包含：

- `.git` 提交历史（可从 GitHub 重新克隆）
- `node_modules`（在新电脑执行 `npm ci` 重新安装）
- `.env` 和任何真实密码
- 本地日志
- `data` 中的账号、题库、答题与计分数据

如需迁移正式比赛数据，请参照第 6 节单独备份。

## 2. 新电脑准备

安装：

- Git
- Node.js 18 或更高版本（建议使用当前 LTS）
- VS Code、Cursor 或其他代码编辑器（可选）

任选一种取得代码的方式。

### 从 GitHub 克隆（推荐）

```bash
git clone https://github.com/batterhuzhixin-blip/live-team-scoreboard.git
cd live-team-scoreboard
npm ci
```

### 从 ZIP 包解压

将 ZIP 解压到不需要管理员权限的目录，在该目录打开终端后执行：

```bash
npm ci
```

`npm ci` 会严格按照 `package-lock.json` 安装依赖，适合在另一台电脑复现当前版本。

## 3. 本地一键运行

Windows PowerShell：

```powershell
Copy-Item .env.example .env
notepad .env
npm start
```

macOS / Linux：

```bash
cp .env.example .env
npm start
```

修改 `.env` 中全部“请修改”值后访问：

- 成绩大屏：`http://localhost:3000/rank.html`
- A 路线计分台：`http://localhost:3000/score-a.html`
- B 路线计分台：`http://localhost:3000/score-b.html`
- 在线题库：`http://localhost:3001/`
- 题库管理：`http://localhost:3001/admin.html`

开发完成后运行：

```bash
npm test
```

## 4. 局域网比赛

1. 在 `.env` 中设置 `HOST=0.0.0.0` 并使用强口令。
2. 在 Windows 防火墙中仅对可信的“专用网络”放行 TCP 3000 和 3001 端口。
3. 用 `ipconfig` 查询服务器电脑的 IPv4 地址，例如 `192.168.1.11`。
4. 其他设备访问 `http://192.168.1.11:3000/rank.html` 和 `http://192.168.1.11:3001/`。

不要在不可信公共 Wi-Fi 上直接开放端口。比赛前应使用真实手机和计分设备完成一次全流程演练。

## 5. 部署

### Render Blueprint

1. 将仓库推送到 GitHub。
2. 在 Render 创建 Blueprint，选择本仓库；平台会读取根目录 `render.yaml`。
3. 同步时填写 `ADMIN_PASSWORD`、`SCORE_A_PASSWORD`、`SCORE_B_PASSWORD`。
4. 等待 `finance-quiz-library` 与 `live-team-scoreboard` 两个 Web Service 健康检查通过。
5. 在题库管理端导入队伍和题库，再验证计分系统健康接口中的同步状态。

计分系统通过 `QUIZ_SERVICE_HOSTPORT` 使用 Render 私有网络访问题库，不需要手工拼接公网地址。

重要：当前 Blueprint 使用免费实例，文件系统可能在重启或重新部署后丢失。正式比赛应配置 Persistent Disk 或改用数据库；免费部署只适合演示和无重要数据的测试。

### 自有 Linux 服务器

`deploy/` 提供两套 systemd 服务和 Nginx 示例。建议目录：

- 代码：`/opt/live-team-scoreboard`
- 题库数据：`/var/lib/finance-quiz-test`
- 计分数据：`/var/lib/live-team-scoreboard`
- 题库密钥：`/etc/finance-quiz-test.env`
- 计分密钥：`/etc/live-team-scoreboard.env`

题库环境文件示例：

```text
ADMIN_PASSWORD=替换为强密码
```

计分环境文件示例：

```text
SCORE_A_PASSWORD=替换为A路线强口令
SCORE_B_PASSWORD=替换为B路线强口令
SCORE_AUTH_SECRET=替换为至少32位随机字符串
```

部署前检查 systemd 文件中的用户、目录、域名和端口是否符合目标服务器。首次安装后执行 `npm ci --omit=dev`，再启用并重启两个服务。Nginx/HTTPS 配置应由服务器管理员结合真实域名完成。

## 6. 正式数据迁移与恢复

迁移前先停止两个服务，避免复制过程中 JSON 正在写入。

一键启动默认数据位置：

- `data/quiz/quiz-state.json`：题库、队伍、用户、答题记录
- `data/scoreboard/state.json`：现场计分、序号和完赛信息

将整个 `data` 目录单独加密备份。新电脑解压源码、安装依赖后，把备份恢复到相同位置再启动。不要把正式数据或 `.env` 提交到公开 GitHub 仓库。

恢复后逐项检查：

1. 题库管理页能看到正确的队伍、题目和用户数量。
2. 计分系统 `/api/health` 显示题库同步成功。
3. A/B 计分台口令可登录，且各自只能操作对应路线。
4. 大屏排名、完赛顺序和累计得分正确。

## 7. 发布前检查清单

- [ ] `.env` 中四个口令/密钥均已替换，且 `.env` 未进入 Git。
- [ ] `npm ci` 和 `npm test` 均通过。
- [ ] 已导入正确队伍与题库，并用测试队伍走完答题流程。
- [ ] A/B 路线计分权限和可用分值正确。
- [ ] 大屏刷新和题库队伍同步正常。
- [ ] 正式数据目录有持久化和可恢复备份。
- [ ] 已用现场网络、浏览器和手机完成演练。
