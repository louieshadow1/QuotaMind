# 使用手册

> 从下载到日常使用。架构见 [architecture.md](architecture.md)，理念见 [principles.md](principles.md)。

---

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20（不需要 `npm install`，零依赖） |
| 网络 | 访问 ChatGPT/Codex 需要能连 `chatgpt.com`（国内通常要走代理） |
| 磁盘 | 只有 `data/` 下几个 JSON 文件，几十 KB 起 |

## 2. 首次运行

### 2.1 从源码运行

在项目目录中执行 `node server.mjs`，然后访问 `http://127.0.0.1:8799`。Windows 也可双击 `start.cmd`；macOS / Linux 可执行 `bash start.sh`。端口可通过 `node server.mjs --port 其他端口` 指定。

需要通过系统代理访问服务时，使用支持 `--use-env-proxy` 的 Node 版本和适当的代理环境变量；不同 Node 版本的代理能力不同。如查询失败，请检查网络和代理设置。启动器在支持该选项时会启用它，不支持时会提示并直接启动。

首次启动会按程序内置默认值创建本地配置；`data/config.example.json` 是供参考的示例，可手动复制并编辑。完成引导后可在页面底部的各设置区添加来源。

## 3. 配置每个来源

### 3.1 中转站（New API / Sub2API / 自定义 HTTP）

展开「＋ 添加中转站」：

| 字段 | 说明 |
|---|---|
| 名称 | 卡片标题 |
| 类型 | `newapi-account`（账户余额）/ `newapi-token`（令牌额度）/ `sub2api` / `generic` |
| 站点地址 | 如 `https://relay.example.com` |
| 用户 ID | New API 账户类型需要（`New-Api-User`） |
| 令牌 | 存到 `data/secrets.json`，用引用名关联 |

New API 默认 `1 USD = 500000 quota`，不同站点可在 `quotaPerUsd` 改。

### 3.2 Codex / ChatGPT

本机有 `~/.codex/auth.json`（登录过 Codex）就会自动出现一张卡。

- 多个账号：展开「Codex 账户」→「扫描本机」或填 `auth.json` 路径，也可以直接粘贴内容；
- 服务会自动把登录态复制到 `data/codex-accounts/`（`autoArchive` 可关）；
- 切换当前登录：用官方客户端登录后点刷新即可，服务按 `account_id` 自动去重。

### 3.3 OpenCode Go

展开「OpenCode Go 订阅」，每个订阅一行：

| 字段 | 说明 |
|---|---|
| 订阅名称 | 卡片标题，随便起 |
| DSH 路由 ID | 与 DSH 里配置一致（如 `opencode-go` / `opencode-go2`），Token 才能按订阅归集 |
| Go Key | `oc_sk_…`，只在本地保存 |

没有任何订阅配置时，会回落到环境变量 `OPENCODE_GO_API_KEY`。

### 3.4 DeepSeek 平台

展开「DeepSeek 平台登录态」，粘贴 `userToken`：

1. 登录 `platform.deepseek.com`；
2. F12 → Application → Local Storage → 找到 `userToken`；
3. 复制值粘进面板保存。

显示余额、累计消费，以及按累计消费折算的 token 估算（标「≈」）。

## 4. 页面导览

| 区块 | 内容 |
|---|---|
| Token 消耗总览 | 合计大数字 + 三个渠道分项；悬停看精确 token 数 |
| 每日总用量 | 所有来源合并的堆叠柱状；30/90/全部；每天/累计；悬停看拆分 |
| 每日用量 | 「所有来源合计」热力图 + 分渠道/分订阅热力图；「筛选」只显示勾选的几张；「分渠道」与「按订阅/账号」可分别折叠 |
| 额度卡片 | 状态、窗口进度、余额、重置时间 |
| 折叠面板 | 中转站 / Codex 账户 / OpenCode Go 订阅 / DeepSeek 登录态 / 导入历史 / 说明 |

## 5. 查看历史与导入

- 每次刷新、以及后台每 30 分钟，都会把当天数据并入 `data/daily-history.json`；
- 热力图范围切到「全部」即可看所有已存档天数；
- 数据源已不提供、但你有账单的旧日子，用「导入历史用量」补：

```csv
date,tokens,cost
2026-08-01,1200000,0.31
2026-08-02,800000,0.2
```

选择渠道 → 粘贴或选文件 → 导入。导入按「取较大值」合并、先备份 `.bak`、重复导入幂等。

## 6. 桌面小窗

打开 `http://127.0.0.1:8799/widget.html`，可缩成一个小窗口常驻，显示关键额度。

## 7. 常用参数

| 名称 | 作用 | 默认 |
|---|---|---|
| `--port <n>` | 端口 | 8799 |
| `QUOTA_BOARD_DATA` | 数据目录 | 项目下 `data/` |
| `HTTPS_PROXY / HTTP_PROXY` | 代理（需配合 --use-env-proxy） | 系统代理 |
| `--use-env-proxy` | 让 fetch 读代理变量 | 关 |
| `dailyArchiveMinutes`（配置项） | 后台存档间隔 | 30 |
| `QUOTA_BOARD_DISABLE_ARCHIVER=1` | 关闭后台存档 | 不关 |

## 8. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 卡片显示「历史数据」 | 实时查询失败（网络/登录态） | 看卡片错误文案；Codex 需带代理启动 |
| `fetch failed` | 网络或代理不可用 | 检查服务可达性及 Node 对代理的支持 |
| 401 / invalid token | Key 失效或写错 | 重新填 Key |
| 页面打不开 | 端口占用 / 进程没起 | 查 8799 端口；看 `server.err.log` |
| 数字是 0 | 该来源没配或没数据 | 看卡片状态是否 `unconfigured` |
| 热力图缺某账号 | 该账号登录态失效、无按天数据 | 重新登录后自动补；历史可导入 |
| config.json 写坏 | 手改 JSON 出错 | 服务自动备份为 `.broken-<时间戳>` 并回落默认值 |

## 9. FAQ

**Q：合计和我逐项加的不一样？**
A：按「亿」显示是四舍五入，可能差 0.01；悬停看精确 token 数。

**Q：Codex 为什么只有一个总数、两个账号？**
A：顶部按渠道聚合（和 DeepSeek / OpenCode Go 一致），小字与热力图 tooltip 里有账号明细。

**Q：快照算进合计吗？**
A：算，但标「历史快照 · 日期」，保证分项之和 = 合计。

**Q：能远程访问吗？**
A：不能也不打算支持。需要远程请自己 `ssh -L 8799:127.0.0.1:8799 …`。

**Q：数据会被上传吗？**
A：配置和历史保存在本机；查询时会向所配置的服务商发送请求及所需凭据。页面资源不使用外部 CDN。

**Q：删掉 data/ 会怎样？**
A：恢复出厂：配置、令牌、快照、历史全清空（历史删了就没了，谨慎）。

**Q：能同时跑多份吗？**
A：可以，用不同 `--port` 和 `QUOTA_BOARD_DATA` 即可，互不影响。

---

*以当前版本代码为准*
## 10. 视觉与主题

- 默认暖纸白 + 赤陶强调色（Claude 风格）；图表用暖土色系（赤陶 / 暖褐 / 鼠尾草 / 沙色）；跟随系统深色模式；
- 顶栏、区块标题、卡片、折叠面板、表单控件统一了间距与焦点态；
- 尊重系统「减少动态效果」设置；所有数字使用等宽数字（tabular-nums），纵向对齐不跳动。
