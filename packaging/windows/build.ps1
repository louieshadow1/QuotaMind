[CmdletBinding(DefaultParameterSetName = 'OfficialZip')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'OfficialZip')]
  [string]$NodeZip,
  [Parameter(Mandatory = $true, ParameterSetName = 'OfflineFiles')]
  [string]$NodeExe,
  [Parameter(Mandatory = $true, ParameterSetName = 'OfflineFiles')]
  [string]$NodeLicense,
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,
  [string]$StageParent = [IO.Path]::GetTempPath()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Official release hashes: https://nodejs.org/en/blog/release/v24.21.0
# Offline LICENSE bytes: https://github.com/nodejs/node/blob/v24.21.0/LICENSE
$nodeVersion = '24.21.0'
$nodeZipSha = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$nodeExeSha = 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32'
$nodeLicenseSha = '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace'

$repoRoot = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '../..')).FullName
$installerBuilder = Join-Path $env:SystemRoot 'System32/iexpress.exe'
if (-not (Test-Path -LiteralPath $installerBuilder -PathType Leaf)) {
  throw 'Windows IExpress is required to build QuotaMind-Setup.exe.'
}

function Get-Sha256([string]$FilePath) {
  return (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-InstallInput([string]$RelativePath) {
  $item = Get-Item -LiteralPath (Join-Path $repoRoot $RelativePath) -Force
  if ($item.PSIsContainer) { throw "Expected a file: $RelativePath" }
  # Prevent a whitelisted path from following a link into installed data.
  $part = $item
  while ($part.FullName -ne $repoRoot) {
    if ($part.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Build input traverses a reparse point: $RelativePath"
    }
    $part = Get-Item -LiteralPath (Split-Path -Parent $part.FullName) -Force
  }
  return $item.FullName
}

function New-PayloadZip([string]$ZipPath, [System.Collections.IDictionary]$Files) {
  $archive = [IO.Compression.ZipFile]::Open($ZipPath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($entry in $Files.GetEnumerator()) {
      $created = $archive.CreateEntry($entry.Key, [IO.Compression.CompressionLevel]::Optimal)
      $created.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
      $sourceStream = [IO.File]::OpenRead($entry.Value)
      try {
        $zipStream = $created.Open()
        try { $sourceStream.CopyTo($zipStream) } finally { $zipStream.Dispose() }
      } finally {
        $sourceStream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
}

# Explicit allowlist. The source tree may also contain installed data,
# screenshots, old packaging output and other files that must not ship.
$appFiles = [ordered]@{}
foreach ($relativePath in @(
  'server.mjs',
  'start.ps1',
  'package.json',
  'LICENSE',
  'SECURITY.md',
  'lib/adapters.mjs',
  'lib/codex-device-login.mjs',
  'lib/codex-oauth.mjs',
  'lib/codex.mjs',
  'lib/config.mjs',
  'lib/daily-history.mjs',
  'lib/file-lock.mjs',
  'lib/go-official-estimate.mjs',
  'lib/opencode-model-service.mjs',
  'lib/opencode-model-usage.mjs',
  'lib/plan.mjs',
  'lib/theme.mjs',
  'lib/usage.mjs',
  'public/app.js',
  'public/go-model-limits.json',
  'public/go-quota-estimate.js',
  'public/icon.ico',
  'public/index.html',
  'public/style.css',
  'public/theme-boot.js',
  'public/widget.css',
  'public/widget.html',
  'public/widget.js',
  'public/vendor/echarts.min.js',
  'public/vendor/lucide.min.js',
  'public/vendor/README.md',
  'public/vendor/licenses/echarts-LICENSE.txt',
  'public/vendor/licenses/echarts-NOTICE.txt',
  'public/vendor/licenses/lucide-LICENSE.txt',
  'data/config.example.json'
)) {
  $appFiles[$relativePath] = Get-InstallInput $relativePath
}
$appFiles['launch.ps1'] = Get-InstallInput 'packaging/windows/launch.ps1'
$appFiles['launch.vbs'] = Get-InstallInput 'packaging/windows/launch.vbs'
$appFiles['app.ico'] = Get-InstallInput 'icon.ico'
$setupCmd = Get-InstallInput 'packaging/windows/setup.cmd'
$setupPs = Get-InstallInput 'packaging/windows/setup.ps1'
$appVersion = (Get-Content -LiteralPath $appFiles['package.json'] -Raw | ConvertFrom-Json).version
if ($appVersion -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') {
  throw 'Set a valid build version in package.json.'
}

$outputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
if (Test-Path -LiteralPath $outputPath) { throw 'Choose a new output directory.' }
$stageParentItem = Get-Item -LiteralPath $StageParent
if (-not $stageParentItem.PSIsContainer -or $stageParentItem.FullName -match '[^\x20-\x7E]') {
  throw 'Choose an existing ASCII staging parent with -StageParent for IExpress.'
}
$stageName = 'QuotaMind-build-' + [guid]::NewGuid().ToString('N')
$stage = Join-Path $stageParentItem.FullName $stageName
New-Item -Path $stage -ItemType Directory | Out-Null
try {
  $nodeInput = Join-Path $stage 'node.exe'
  $licenseInput = Join-Path $stage 'node-LICENSE.txt'
  $sourceArchiveHash = $null
  if ($PSCmdlet.ParameterSetName -eq 'OfficialZip') {
    $zipInput = (Get-Item -LiteralPath $NodeZip).FullName
    $sourceArchiveHash = Get-Sha256 $zipInput
    if ($sourceArchiveHash -ne $nodeZipSha) {
      throw "Expected the official Node.js $nodeVersion win-x64 ZIP (SHA-256 $nodeZipSha)."
    }
    $archive = [IO.Compression.ZipFile]::OpenRead($zipInput)
    try {
      $nodeEntry = $archive.GetEntry("node-v$nodeVersion-win-x64/node.exe")
      $licenseEntry = $archive.GetEntry("node-v$nodeVersion-win-x64/LICENSE")
      if ($null -eq $nodeEntry -or $null -eq $licenseEntry) {
        throw 'The Node.js distribution is missing node.exe or LICENSE.'
      }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($nodeEntry, $nodeInput)
      [IO.Compression.ZipFileExtensions]::ExtractToFile($licenseEntry, $licenseInput)
    } finally {
      $archive.Dispose()
    }
  } else {
    Copy-Item -LiteralPath $NodeExe -Destination $nodeInput
    Copy-Item -LiteralPath $NodeLicense -Destination $licenseInput
    if ((Get-Sha256 $licenseInput) -ne $nodeLicenseSha) {
      throw "Expected the official tagged Node.js $nodeVersion LICENSE (SHA-256 $nodeLicenseSha)."
    }
  }
  $resolvedNodeHash = Get-Sha256 $nodeInput
  if ($resolvedNodeHash -ne $nodeExeSha) {
    throw "Unexpected Node.js binary. Expected $nodeVersion win-x64, SHA-256 $nodeExeSha."
  }

  $appFiles['THIRD_PARTY_LICENSES/node-LICENSE.txt'] = $licenseInput
  $appZip = Join-Path $stage 'app.zip'
  $runtimeZip = Join-Path $stage 'runtime.zip'
  New-PayloadZip $appZip $appFiles
  New-PayloadZip $runtimeZip ([ordered]@{ 'node.exe' = $nodeInput })
  $appHash = Get-Sha256 $appZip
  $runtimeHash = Get-Sha256 $runtimeZip
  @("$appHash  app.zip", "$runtimeHash  runtime.zip") |
    Set-Content -LiteralPath (Join-Path $stage 'payload.sha256') -Encoding ASCII
  Copy-Item -LiteralPath $setupCmd -Destination (Join-Path $stage 'setup.cmd')
  Copy-Item -LiteralPath $setupPs -Destination (Join-Path $stage 'setup.ps1')

  $installerPath = Join-Path $stage 'QuotaMind-Setup.exe'
  $sedPath = Join-Path $stage 'build.sed'
  $sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$installerPath
FriendlyName=QuotaMind Setup $appVersion
AppLaunched=setup.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0="setup.cmd"
FILE1="setup.ps1"
FILE2="app.zip"
FILE3="runtime.zip"
FILE4="payload.sha256"
[SourceFiles]
SourceFiles0=$stage\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
%FILE3%=
%FILE4%=
"@
  # IExpress consumes this as a Windows INI file even when Git checks out LF.
  $sed = $sed -replace '\r?\n', "`r`n"
  Set-Content -LiteralPath $sedPath -Value $sed -Encoding ASCII
  $sedArgument = if ($sedPath.Contains(' ')) { '"' + $sedPath + '"' } else { $sedPath }
  $buildArgs = @{
    FilePath = $installerBuilder
    ArgumentList = @('/N', $sedArgument)
    WorkingDirectory = $stage
    WindowStyle = 'Hidden'
    PassThru = $true
    Wait = $true
  }
  $build = Start-Process @buildArgs
  if ($build.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    Write-Verbose $sed
    Get-ChildItem -LiteralPath $stage | ForEach-Object { Write-Verbose $_.Name }
    Get-ChildItem -LiteralPath $stage -Filter '*.rpt' | ForEach-Object {
      Write-Verbose (Get-Content -LiteralPath $_.FullName -Raw)
    }
    throw "IExpress did not produce QuotaMind-Setup.exe (exit $($build.ExitCode))."
  }
  $installerHash = Get-Sha256 $installerPath

  New-Item -Path $outputPath -ItemType Directory | Out-Null
  Copy-Item -LiteralPath $installerPath -Destination (Join-Path $outputPath 'QuotaMind-Setup.exe')
  "$installerHash  QuotaMind-Setup.exe" |
    Set-Content -LiteralPath (Join-Path $outputPath 'SHA256SUMS.txt') -Encoding ASCII
  [ordered]@{
    version = $appVersion
    platform = 'windows-x64'
    nodeVersion = "v$nodeVersion"
    nodeArchiveSha256 = $sourceArchiveHash
    nodeExeSha256 = $resolvedNodeHash
    nodeLicenseSha256 = Get-Sha256 $licenseInput
    setupCmdSha256 = Get-Sha256 (Join-Path $stage 'setup.cmd')
    setupPs1Sha256 = Get-Sha256 (Join-Path $stage 'setup.ps1')
    appSha256 = $appHash
    runtimeSha256 = $runtimeHash
    installerSha256 = $installerHash
    appFiles = @($appFiles.Keys)
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputPath 'build-receipt.json') -Encoding ASCII
  Write-Output "Built QuotaMind $appVersion at $outputPath"
} finally {
  $stageItem = Get-Item -LiteralPath $stage -ErrorAction SilentlyContinue
  if ($null -ne $stageItem -and $stageItem.PSIsContainer -and $stageItem.Name -eq $stageName -and
      $stageItem.Parent.FullName -eq $stageParentItem.FullName -and
      -not ($stageItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Remove-Item -LiteralPath $stageItem.FullName -Recurse -Force -ErrorAction Continue
  }
}
