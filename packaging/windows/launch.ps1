# quota-board 便携版启动器：启动服务 + 托盘图标 + 关闭提示
param([int]$Port = 8799)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$script:serverProc = $null

function Test-Up {
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    return ($health.ok -eq $true -and $health.service -eq 'quota-board')
  } catch { return $false }
}

if (Test-Up) {
  # 已经在运行：只打开面板，不再创建托盘，避免重复图标
  Start-Process "http://127.0.0.1:$Port/"
  exit 0
}

if (-not (Test-Up)) {
  $proxy = $env:HTTPS_PROXY
  if (-not $proxy) {
    try {
      $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
      if ($ie.ProxyEnable -eq 1 -and $ie.ProxyServer) {
        $raw = [string]$ie.ProxyServer
        $httpsPart = ($raw -split ';' | Where-Object { $_ -like 'https=*' } | Select-Object -First 1)
        if ($httpsPart) { $proxy = $httpsPart -replace '^https=', '' } else { $proxy = ($raw -split ';')[0] }
        if ($proxy -and $proxy -notmatch '^https?://') { $proxy = "http://$proxy" }
      }
    } catch { $proxy = $null }
  }
  if ($proxy) {
    $env:HTTP_PROXY = $proxy
    $env:HTTPS_PROXY = $proxy
    $env:ALL_PROXY = $proxy
    if (-not $env:NO_PROXY) { $env:NO_PROXY = '127.0.0.1,localhost,::1' }
  }
  $node = Join-Path $root 'node.exe'
  if (-not (Test-Path $node)) { $node = 'node' }
  $argsList = @('--use-env-proxy', 'server.mjs', '--port', "$Port")
  $script:serverProc = Start-Process -FilePath $node -ArgumentList $argsList -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'server.log') -RedirectStandardError (Join-Path $root 'server.err.log')
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Up) { break }
  }
}

if (-not (Test-Up)) {
  if ($script:serverProc) { Stop-Process -Id $script:serverProc.Id -Force -ErrorAction SilentlyContinue }
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show('无法启动额度一念。请关闭正在使用 8799 端口的程序后重试。', '额度一念') | Out-Null
  exit 1
}
Start-Process "http://127.0.0.1:$Port/"

# ── 托盘图标 ─────────────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$iconPath = Join-Path $root 'app.ico'
$notify = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $iconPath) { $notify.Icon = New-Object System.Drawing.Icon($iconPath) }
else { $notify.Icon = [System.Drawing.SystemIcons]::Application }
$notify.Text = '额度一念'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = $menu.Items.Add('打开面板')
$itemDir = $menu.Items.Add('打开数据目录')
$null = $menu.Items.Add('-');
$itemExit = $menu.Items.Add('关闭 / 退出…')

$itemOpen.add_Click({ Start-Process "http://127.0.0.1:$Port/" })
$itemDir.add_Click({ Start-Process explorer.exe $root })
$itemExit.add_Click({
  $msg = "要最小化到托盘继续运行，还是退出并停止服务？"
  $msg += [Environment]::NewLine + [Environment]::NewLine
  $msg += "最小化：面板继续在后台运行，双击托盘图标可再次打开。"
  $msg += [Environment]::NewLine + "退出：立即停止服务。"
  $choice = [System.Windows.Forms.MessageBox]::Show($msg, '额度一念', 'YesNoCancel', 'Question')
  if ($choice -eq 'Yes') {
    $notify.ShowBalloonTip(1500, '已最小化到托盘', '双击托盘图标可再次打开面板。', 'Info')
  } elseif ($choice -eq 'No') {
    $notify.Visible = $false
    if ($script:serverProc) { Stop-Process -Id $script:serverProc.Id -Force -ErrorAction SilentlyContinue }
    [System.Windows.Forms.Application]::Exit()
  }
})

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Start-Process "http://127.0.0.1:$Port/" })
$notify.ShowBalloonTip(3000, '额度一念已启动', '面板已在托盘运行：双击图标打开，右键可退出。', 'Info')

$context = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($context)

# 退出：停掉自己拉起的服务进程
$notify.Visible = $false
$notify.Dispose()
if ($script:serverProc) { Stop-Process -Id $script:serverProc.Id -Force -ErrorAction SilentlyContinue }
