# Windows x64 安装包

从仓库根目录运行 `packaging/windows/build.ps1`。构建脚本读取 `package.json` 的版本，固定使用 Node.js v24.21.0 Windows x64，校验运行时和官方分发包的 SHA-256。[Node.js 官方分发文件](https://nodejs.org/dist/v24.21.0/)

```powershell
powershell.exe -NoProfile -File .\packaging\windows\build.ps1 -NodeZip 'C:\Downloads\node-v24.21.0-win-x64.zip' -OutputDirectory '..\artifacts\quotamind-windows-x64'
```

已有官方 `node.exe` 与官方 `LICENSE` 时，可用 `-NodeExe` 和 `-NodeLicense` 离线构建。脚本会校验两者的固定 SHA-256。IExpress 的暂存父目录需要使用 ASCII 路径。默认使用当前 Windows 的临时目录，也可通过 `-StageParent` 指定一个已存在的目录。构建结果包括 `QuotaMind-Setup.exe`、`SHA256SUMS.txt` 和记录文件清单及输入哈希的 `build-receipt.json`。IExpress 输出的文件哈希可能随构建环境和封装元数据而变化。

程序 ZIP 使用明确文件清单，仅包含应用、启动脚本、第三方许可和 `data/config.example.json`。运行时 ZIP 仅含 `node.exe`。安装前，安装脚本在同卷暂存目录校验归档哈希与内容，之后逐个替换已有程序文件并保留恢复副本。

双击安装包后，可以选 Windows 默认目录 `%LOCALAPPDATA%\quota-board`，也可以选择包含 `server.mjs` 和 `package.json` 的旧额度一念目录。升级前从托盘退出旧版，或停止启动源码版的窗口。升级脚本会保留整个既有 `data/`，并沿用 `QUOTA_BOARD_DATA` 指定的数据路径。失败时尝试恢复已替换的程序文件。若系统中断或自动恢复失败，保留安装目录旁的 `.quotamind-setup-*` 及 `pending.json`，核对恢复记录和原件后再启动应用。

发布前，用候选安装包解包后的 `setup.ps1 -InstallRoot <隔离目录> -NoLaunch` 检查干净安装和升级。合成测试应核对程序版本、原数据、程序文件和恢复结果，并使用故意占用的文件验证中途出错时旧版可恢复。随后在干净的 Windows 用户账户验收开始菜单、服务启动和托盘，核对最终上传的 EXE 哈希。
