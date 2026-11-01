# Windows 安装包中的启动与安装脚本

此目录保存 Windows 安装包使用的脚本：`setup.cmd` 和 `setup.ps1` 负责安装，`launch.vbs` 和 `launch.ps1` 负责启动、浏览器窗口和托盘菜单。应用本体位于仓库根目录的 `server.mjs`、`lib/`、`public/` 和 `package.json`。

安装包使用 Windows IExpress 打包 `setup.cmd`、`setup.ps1`、`app.zip` 和 `runtime.zip`。`app.zip` 包含应用本体、这两个启动脚本、图标、示例配置及第三方许可；`runtime.zip` 包含适用于 Windows x64 的 Node.js 可执行文件。构建时须保留 Node.js 及前端第三方组件的许可文件。

构建发布包时，只应加入 `data/config.example.json`，不要打包 `data/config.json`、历史记录、账号凭据或其他使用数据。安装脚本默认安装到当前用户的 `%LOCALAPPDATA%\quota-board`，会保留已存在的数据目录。发布前请在隔离目录中检查压缩包、测试安装并计算 SHA-256。

本目录不包含自动生成完整安装包的构建脚本；IExpress 配置和运行时需由打包者准备。
