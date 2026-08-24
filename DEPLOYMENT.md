# 部署说明

详细部署与迁移流程统一维护在 [PORTABLE_SETUP.md](PORTABLE_SETUP.md)。本文件保留为旧链接的入口。

快速选择：

- Render：使用仓库根目录 `render.yaml`，一次创建题库和计分系统两个服务。
- 自有 Linux 服务器：参考 `deploy/` 下的 systemd 与 Nginx 示例。
- 临时公网演示：本机 `npm start` 后使用 Cloudflare Quick Tunnel；正式比赛不建议依赖临时隧道。

无论采用哪种方式，正式上线前都必须设置题库管理密码、A/B 计分台口令和计分会话密钥，并确保 `data` 目录具备持久化和备份能力。
