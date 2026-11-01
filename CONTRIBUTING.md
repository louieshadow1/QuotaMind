# 参与开发

感谢帮忙！后端使用 Node 内置模块，前端所需的第三方库随项目提供。贡献前请先阅读项目的 [MIT 许可证](LICENSE)，并确认你有权按该许可提交修改。提交前请注意：

1. 不要新增 `dependencies` / `devDependencies`；需要能力时优先用 `node:` 内置模块。
2. 不要引入前端 CDN；需要库就放进 `public/vendor/` 并在 `public/vendor/README.md` 注明版本与许可证。
3. 改完先跑测试：

```bash
node --test
```

4. 涉及安全的改动（监听地址、请求处理、静态文件服务）请一并补充测试。
5. **不要提交** `data/config.json`、`data/secrets.json`、`data/codex-accounts/`、任何日志或截图里的真实账号信息。

## 提交信息

用 [Conventional Commits](https://www.conventionalcommits.org/) 风格，例如：

```text
feat: 支持多个 OpenCode Go 订阅
fix: 坏配置时不再启动失败
docs: 补充隐私说明
```

## 参考文档

- [docs/principles.md](docs/principles.md)：理念与需求
- [docs/architecture.md](docs/architecture.md)：架构与实现
- [docs/development.md](docs/development.md)：开发与发布

## 目录约定

```text
server.mjs        HTTP 服务与 API 路由
lib/              数据读取、适配器、统计口径（纯逻辑，可单测）
public/           前端（零构建，原生 ES Module）
test/             node:test 测试（无第三方测试框架）
docs/             设计说明
.github/          CI 与 issue/PR 模板
```
