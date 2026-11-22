param(
  [Parameter(Mandatory=$true)][string]$PackageDirectory,
  [Parameter(Mandatory=$true)][string]$FixtureRoot
)
$ErrorActionPreference = 'Stop'
$package = (Resolve-Path -LiteralPath $PackageDirectory).Path
$work = Join-Path (Resolve-Path -LiteralPath $FixtureRoot).Path ('installer-check-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
$staging = Join-Path $work 'package'
$target = Join-Path $work 'installed'
$null = New-Item -ItemType Directory -Path $staging
Write-Output "验收目录：$work"
Copy-Item -LiteralPath (Join-Path $package 'app.zip'), (Join-Path $package 'runtime.zip') -Destination $staging
$setup = Join-Path $staging 'setup.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'setup.ps1') -Destination $setup
$manifest = Join-Path $staging 'payload.sha256'

function Write-TestManifest {
  $fileHashes = foreach ($name in @('app.zip', 'runtime.zip')) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $staging $name)).Hash.ToLowerInvariant() + "  $name"
  }
  [IO.File]::WriteAllLines($manifest, [string[]]$fileHashes, [Text.Encoding]::ASCII)
}

function Invoke-Setup([string]$ExpectedMessage, [switch]$FailureExpected) {
  $ErrorActionPreference = 'Continue'
  $lines = @(& powershell.exe -NoLogo -NonInteractive -NoProfile -ExecutionPolicy Bypass -File $setup -InstallRoot $target -NoLaunch 2>&1 | ForEach-Object { "$_" })
  $code = $LASTEXITCODE
  if (($FailureExpected -and $code -eq 0) -or (-not $FailureExpected -and $code -ne 0)) {
    throw "安装器返回非预期状态 $code。$($lines -join [Environment]::NewLine)"
  }
  # Windows PowerShell can wrap Chinese error messages at the host width.
  $normalized = ($lines -join '') -replace '\s+', ''
  if (-not $normalized.Contains(($ExpectedMessage -replace '\s+', ''))) {
    throw "安装器没有返回预期提示：$ExpectedMessage。$($lines -join [Environment]::NewLine)"
  }
  if (Get-ChildItem -LiteralPath $work -Directory -Force -Filter '.quotamind-setup-*') {
    throw '验收发现未清理的安装暂存目录。'
  }
}

function Read-TestHashes([string[]]$Paths) {
  $hashes = @{}
  foreach ($file in $Paths) {
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      $hashes[$file] = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash
    } else {
      $hashes[$file] = $null
    }
  }
  return $hashes
}

function Assert-TestHashes($Expected, [string[]]$Paths) {
  $actual = Read-TestHashes $Paths
  foreach ($file in $Paths) {
    if ($Expected[$file] -ne $actual[$file]) { throw "文件校验值发生非预期变化：$file" }
  }
}

Invoke-Setup '安装包缺少校验清单' -FailureExpected
if (Test-Path -LiteralPath $target) { throw '缺少校验清单时不应创建安装目录。' }
Write-Output 'PASS 安装包必须包含校验清单'

Write-TestManifest
Invoke-Setup 'Installation complete.'
$server = Join-Path $target 'server.mjs'
$launch = Join-Path $target 'launch.vbs'
$adapter = Join-Path $target 'lib/adapters.mjs'
$sample = Join-Path $target 'data/config.example.json'
$privateConfig = Join-Path $target 'data/config.json'
$unknown = Join-Path $target 'public/custom-preview.txt'
$watched = @(Get-ChildItem -LiteralPath $target -File -Recurse | ForEach-Object FullName)
$expectedClean = Read-TestHashes $watched
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead((Join-Path $staging 'app.zip'))
try { $expectedCount = $archive.Entries.Count + 1 } finally { $archive.Dispose() }
if ($watched.Count -ne $expectedCount -or -not (Test-Path -LiteralPath $sample -PathType Leaf)) {
  throw '新装文件数或示例配置不符。'
}
Write-Output 'PASS 新装，文件清单完整'

Set-Content -LiteralPath $server -Value '// synthetic older server'
Set-Content -LiteralPath $sample -Value '{"value":"synthetic existing example"}'
Set-Content -LiteralPath $privateConfig -Value '{"value":"synthetic user data"}'
Set-Content -LiteralPath $unknown -Value 'synthetic custom file'
Remove-Item -LiteralPath $adapter
$watched += @($privateConfig, $unknown)
$beforeUpgrade = Read-TestHashes $watched
$held = [IO.File]::Open($launch, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try { Invoke-Setup '已恢复先前的程序文件' -FailureExpected } finally { $held.Dispose() }
Assert-TestHashes $beforeUpgrade $watched
Write-Output 'PASS 文件锁导致升级失败，原文件哈希及缺失文件状态均已恢复'

Invoke-Setup 'Installation complete.'
$personal = @($sample, $privateConfig, $unknown)
Assert-TestHashes $beforeUpgrade $personal
Assert-TestHashes $expectedClean @($watched | Where-Object { $_ -notin $personal })
Write-Output 'PASS 成功升级，保留已有 data 和附加文件'

$beforeRejection = Read-TestHashes $watched
$appArchive = Join-Path $staging 'app.zip'
[IO.File]::AppendAllText($appArchive, 'synthetic checksum mismatch')
Invoke-Setup '安装包校验未通过' -FailureExpected
Assert-TestHashes $beforeRejection $watched
Write-Output 'PASS 校验值不符时，尚未修改已安装文件'

[IO.File]::WriteAllText($appArchive, 'not a zip')
Write-TestManifest
Invoke-Setup '无法读取安装压缩包' -FailureExpected
Assert-TestHashes $beforeRejection $watched
Write-Output 'PASS ZIP 结构损坏时，尚未修改已安装文件'
