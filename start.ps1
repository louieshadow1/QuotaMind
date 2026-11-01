#!/usr/bin/env pwsh
# quota-board 启动器：自动带上系统代理 + --use-env-proxy
# 原因：Node 的 fetch 只有启动时读 HTTP(S)_PROXY，而 chatgpt.com 在某些网络环境下需要代理，
# 否则 Codex 额度会一直失败、只能显示历史快照。
param([int]$Port = 8799)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

$proxy = $env:HTTPS_PROXY
if (-not $proxy) {
  try {
    $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    if ($ie.ProxyEnable -eq 1 -and $ie.ProxyServer) {
      $raw = [string]$ie.ProxyServer
      $httpsPart = ($raw -split ';' | Where-Object { $_ -like 'https=*' } | Select-Object -First 1)
      if ($httpsPart) { $proxy = $httpsPart -replace '^https=', '' } else { $proxy = ($raw -split ';')[0] }
      if ($proxy -and $proxy -notmatch '^https?://') { $proxy = "http://$proxy" }
    }
  } catch {
    $proxy = $null
  }
}

if ($proxy) {
  $env:HTTP_PROXY = $proxy
  $env:HTTPS_PROXY = $proxy
  $env:ALL_PROXY = $proxy
  if (-not $env:NO_PROXY) { $env:NO_PROXY = '127.0.0.1,localhost,::1' }
  Write-Host "[quota-board] 代理：$proxy"
} else {
  Write-Host '[quota-board] 未检测到系统代理，按直连启动'
}

$node = (Get-Command node -ErrorAction Stop).Source
$nodeHelp = (& $node --help | Out-String)
if ($nodeHelp -match '--use-env-proxy') {
  & $node --use-env-proxy server.mjs --port $Port 1>> server.log 2>> server.err.log
} else {
  Write-Warning '当前 Node 不支持自动读取代理的选项，将尝试直连。'
  & $node server.mjs --port $Port 1>> server.log 2>> server.err.log
}
