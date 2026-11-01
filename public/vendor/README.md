# vendor（第三方前端库，本地化，不走 CDN）

| 文件 | 项目 | 版本 | 许可 | 用途 |
|---|---|---|---|---|
| `echarts.min.js` | [apache/echarts](https://github.com/apache/echarts) | 5.5.1 | Apache-2.0 | 「每日用量」日历热力图（calendar heatmap + tooltip + visualMap） |
| `lucide.min.js` | [lucide-icons/lucide](https://github.com/lucide-icons/lucide) | 0.460.0 | ISC | 标题/按钮/面板图标（`<i data-lucide="…">`） |

两个文件都是从 npm 包 dist 直接下载后放进仓库的 UMD 构建，**页面运行时不请求任何外网 CDN**；
升级时替换同名文件即可（ECharts 升级后注意 calendar/visualMap 选项兼容）。

许可全文见各自项目仓库：Apache-2.0 <https://www.apache.org/licenses/LICENSE-2.0>，ISC <https://opensource.org/licenses/ISC>。

已随包提供对应版本的许可文件：`licenses/echarts-LICENSE.txt`、`licenses/echarts-NOTICE.txt` 和 `licenses/lucide-LICENSE.txt`。
