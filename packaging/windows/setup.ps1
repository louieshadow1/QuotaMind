param([string]$InstallRoot = '', [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
try {
  if (-not $InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'quota-board' }
  if (-not $NoLaunch) {
    $socket = New-Object System.Net.Sockets.TcpClient
    try { $socket.Connect('127.0.0.1', 8799); $inUse = $true } catch { $inUse = $false } finally { $socket.Dispose() }
    if ($inUse) { throw '本机 8799 端口正在使用。请先退出旧版额度一念或其他占用该端口的程序，然后重新运行安装包。' }
  }
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  Expand-Archive -LiteralPath (Join-Path $PSScriptRoot 'runtime.zip') -DestinationPath $InstallRoot -Force
  Expand-Archive -LiteralPath (Join-Path $PSScriptRoot 'app.zip') -DestinationPath $InstallRoot -Force
  if (-not (Test-Path (Join-Path $InstallRoot 'node.exe')) -or -not (Test-Path (Join-Path $InstallRoot 'server.mjs'))) { throw '安装文件不完整。' }
  if (-not $NoLaunch) {
    $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    New-Item -ItemType Directory -Force -Path $programs | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $programs '额度一念.lnk'))
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $shortcut.Arguments = '"' + (Join-Path $InstallRoot 'launch.vbs') + '"'
    $shortcut.WorkingDirectory = $InstallRoot
    $shortcut.IconLocation = (Join-Path $InstallRoot 'app.ico')
    $shortcut.Save()
    Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments
  }
  Write-Output 'Installation complete.'
} catch {
  if (-not $NoLaunch) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '额度一念安装失败') | Out-Null }
  Write-Error $_
  exit 1
}
