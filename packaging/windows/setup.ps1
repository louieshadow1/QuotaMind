param([string]$InstallRoot = '', [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'

# Match the release builder. An installer may only change files that it owns.
$appFiles = @(
  'server.mjs', 'start.ps1', 'package.json', 'LICENSE', 'SECURITY.md',
  'lib/adapters.mjs', 'lib/codex-device-login.mjs', 'lib/codex-oauth.mjs', 'lib/codex.mjs',
  'lib/config.mjs', 'lib/daily-history.mjs', 'lib/file-lock.mjs', 'lib/go-official-estimate.mjs',
  'lib/opencode-model-service.mjs', 'lib/opencode-model-usage.mjs', 'lib/plan.mjs', 'lib/theme.mjs', 'lib/usage.mjs',
  'public/app.js', 'public/go-model-limits.json', 'public/go-quota-estimate.js',
  'public/icon.ico', 'public/index.html', 'public/style.css', 'public/theme-boot.js',
  'public/widget.css', 'public/widget.html', 'public/widget.js',
  'public/vendor/echarts.min.js', 'public/vendor/lucide.min.js', 'public/vendor/README.md',
  'public/vendor/licenses/echarts-LICENSE.txt', 'public/vendor/licenses/echarts-NOTICE.txt',
  'public/vendor/licenses/lucide-LICENSE.txt',
  'launch.ps1', 'launch.vbs', 'THIRD_PARTY_LICENSES/node-LICENSE.txt', 'app.ico',
  'data/config.example.json'
)
$allFiles = @('node.exe') + $appFiles

function Assert-OrdinaryPath([string]$Path, [switch]$Directory) {
  $expectDirectory = $Directory.IsPresent
  while ($Path) {
    try {
      $attributes = [IO.File]::GetAttributes($Path)
      if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "安装路径不能经过重解析点：$Path"
      }
      if ([bool]($attributes -band [IO.FileAttributes]::Directory) -ne $expectDirectory) {
        throw "安装路径的文件类型不符：$Path"
      }
    } catch [IO.FileNotFoundException] {
      # Missing paths can be created later, but existing ancestors still need checking.
    } catch [IO.DirectoryNotFoundException] {
    }
    $expectDirectory = $true
    $Path = [IO.Path]::GetDirectoryName($Path)
  }
}

function Confirm-PayloadHashes {
  $manifest = Join-Path $PSScriptRoot 'payload.sha256'
  if (-not [IO.File]::Exists($manifest)) {
    throw '安装包缺少校验清单，请重新获取完整安装程序。'
  }
  $expected = @{}
  foreach ($line in [IO.File]::ReadAllLines($manifest)) {
    if ($line -notmatch '^([0-9a-fA-F]{64})  (app\.zip|runtime\.zip)$' -or $expected.ContainsKey($Matches[2])) {
      throw '安装包校验清单无效。'
    }
    $expected[$Matches[2]] = $Matches[1]
  }
  foreach ($name in @('app.zip', 'runtime.zip')) {
    if (-not $expected.ContainsKey($name)) { throw "安装包校验清单缺少 $name。" }
    $actual = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot $name)
    if ($actual.Hash -ne $expected[$name]) { throw "安装包校验未通过：$name。" }
  }
}

function Select-InstallRoot([string]$DefaultRoot) {
  Add-Type -AssemblyName System.Windows.Forms
  $message = @(
    '请选择额度一念的安装或更新位置。'
    '是：使用 Windows 默认目录。有旧版时原目录更新。'
    '否：选择其他已有的额度一念目录。'
    '更新会保留所选目录里的使用记录和设置。'
  ) -join [Environment]::NewLine
  $choice = [System.Windows.Forms.MessageBox]::Show($message, '额度一念 1.9.2 安装与更新', 'YesNoCancel', 'Question')
  if ($choice -eq 'Yes') { return $DefaultRoot }
  if ($choice -ne 'No') { return }
  $picker = [System.Windows.Forms.FolderBrowserDialog]::new()
  try {
    $picker.Description = '请选择包含额度一念 server.mjs 和 package.json 的原目录。'
    $picker.ShowNewFolderButton = $false
    if ($picker.ShowDialog() -eq 'OK') { return $picker.SelectedPath }
  } finally { $picker.Dispose() }
}

function Assert-ExistingQuotaMind([string]$Root) {
  $manifest = Join-Path $Root 'package.json'
  $server = Join-Path $Root 'server.mjs'
  Assert-OrdinaryPath $manifest
  Assert-OrdinaryPath $server
  if ([IO.File]::Exists($manifest) -and [IO.File]::Exists($server)) {
    try {
      $installed = [IO.File]::ReadAllText($manifest) | ConvertFrom-Json
      if ($installed.name -eq 'quota-board') { return }
    } catch {}
  }
  throw '所选文件夹里找不到可更新的额度一念。请选择包含 server.mjs 和 package.json 的原目录。'
}

function Expand-VerifiedArchive([string]$ArchiveName, [string[]]$Required, [string]$Payload) {
  try {
    $archive = [IO.Compression.ZipFile]::OpenRead((Join-Path $PSScriptRoot $ArchiveName))
  } catch {
    throw "无法读取安装压缩包 $ArchiveName。$($_.Exception.Message)"
  }
  try {
    $seen = @{}
    foreach ($entry in $archive.Entries) {
      $relative = $entry.FullName.Replace('\', '/')
      if ($Required -cnotcontains $relative -or $seen.ContainsKey($relative)) {
        throw "$ArchiveName 包含未许可或重复的文件。"
      }
      if ($entry.Length -le 0) { throw "$ArchiveName 包含空文件：$relative。" }
      $seen[$relative] = $true
      $target = Join-Path $Payload $relative
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target)
      if ((Get-Item -LiteralPath $target).Length -ne $entry.Length) {
        throw "$ArchiveName 解包长度不符：$relative。"
      }
    }
    if ($seen.Count -ne $Required.Count) { throw "$ArchiveName 缺少安装文件。" }
  } finally {
    $archive.Dispose()
  }
}

function Restore-InstalledFiles($Entries) {
  for ($i = $Entries.Count - 1; $i -ge 0; $i--) {
    $item = $Entries[$i]
    try {
      Assert-OrdinaryPath $item.Target
      if ($item.HadOriginal) {
        if ([IO.File]::Exists($item.Backup)) {
          if ([IO.File]::Exists($item.Target)) {
            # On some failed replacements Windows may keep identical copies at both paths.
            $targetHash = (Get-FileHash -LiteralPath $item.Target -Algorithm SHA256).Hash
            $backupHash = (Get-FileHash -LiteralPath $item.Backup -Algorithm SHA256).Hash
            if ($targetHash -ne $backupHash) {
              [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Failed))
              [IO.File]::Replace($item.Backup, $item.Target, $item.Failed)
            }
          } else {
            [IO.File]::Move($item.Backup, $item.Target)
          }
        } elseif (-not [IO.File]::Exists($item.Source) -or -not [IO.File]::Exists($item.Target)) {
          throw '未找到原文件备份。'
        }
      } elseif (-not [IO.File]::Exists($item.Source)) {
        [IO.File]::Delete($item.Target)
      }
    } catch {
      "$($item.Relative): $($_.Exception.Message)"
    }
  }
}

function Remove-SetupStage([string]$Stage, [string]$ExpectedParent, [string]$Prefix) {
  $resolved = [IO.Path]::GetFullPath($Stage)
  if ([IO.Path]::GetDirectoryName($resolved) -ne $ExpectedParent -or
      -not [IO.Path]::GetFileName($resolved).StartsWith($Prefix, [StringComparison]::Ordinal)) {
    throw '暂存目录与安装事务不符。'
  }
  Assert-OrdinaryPath $resolved -Directory
  foreach ($folder in @('payload', 'previous', 'failed')) {
    $base = Join-Path $resolved $folder
    $directories = @{}
    foreach ($relative in $allFiles) {
      $file = Join-Path $base $relative
      Assert-OrdinaryPath $file
      if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }
      $parentDirectory = [IO.Path]::GetDirectoryName($file)
      while ($parentDirectory -ne $base) {
        $directories[$parentDirectory] = $true
        $parentDirectory = [IO.Path]::GetDirectoryName($parentDirectory)
      }
    }
    foreach ($directory in ($directories.Keys | Sort-Object Length -Descending)) {
      if ([IO.Directory]::Exists($directory)) { [IO.Directory]::Delete($directory) }
    }
    if ([IO.Directory]::Exists($base)) { [IO.Directory]::Delete($base) }
  }
  [IO.File]::Delete((Join-Path $resolved 'pending.json'))
  [IO.Directory]::Delete($resolved)
}

$stage = $null
$mutex = $null
$ownsMutex = $false
$keepStage = $false
$exitCode = 1
try {
  $defaultRoot = Join-Path $env:LOCALAPPDATA 'quota-board'
  $selectedInteractively = -not $InstallRoot -and -not $NoLaunch
  if ($selectedInteractively) {
    $InstallRoot = Select-InstallRoot $defaultRoot
    if (-not $InstallRoot) { exit 0 }
  } elseif (-not $InstallRoot) {
    $InstallRoot = $defaultRoot
  }
  $InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
  if ($InstallRoot -notmatch '^[A-Za-z]:\\.+') { throw '请选择本机磁盘上的一个安装文件夹。' }
  Assert-OrdinaryPath $InstallRoot -Directory
  if ($selectedInteractively -and $InstallRoot -ne $defaultRoot) { Assert-ExistingQuotaMind $InstallRoot }

  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $pathHash = [BitConverter]::ToString($hash.ComputeHash(
      [Text.Encoding]::UTF8.GetBytes($InstallRoot.ToUpperInvariant())
    )).Replace('-', '')
  } finally { $hash.Dispose() }
  $mutex = [Threading.Mutex]::new($false, "Local\QuotaMind-Setup-$pathHash")
  try {
    $ownsMutex = $mutex.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $ownsMutex = $true
  }
  if (-not $ownsMutex) { throw '额度一念正在安装，请等待当前安装完成。' }

  if (-not $NoLaunch -or $InstallRoot -eq $defaultRoot) {
    $socket = New-Object System.Net.Sockets.TcpClient
    try { $socket.Connect('127.0.0.1', 8799); $inUse = $true } catch { $inUse = $false } finally { $socket.Dispose() }
    if ($inUse) { throw '本机 8799 端口正在使用。请先退出旧版额度一念或其他占用该端口的程序，然后重新运行安装包。' }
  }

  $parent = [IO.Path]::GetDirectoryName($InstallRoot)
  [void][IO.Directory]::CreateDirectory($parent)
  $prefix = ".quotamind-setup-$($pathHash.Substring(0,16))-"
  $pending = Get-ChildItem -LiteralPath $parent -Directory -Filter "$prefix*" -Force |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'pending.json') } |
    Select-Object -First 1
  if ($pending) { throw "上一次安装未确认完成。请先核对恢复记录：$($pending.FullName)\pending.json" }

  $stage = Join-Path $parent ($prefix + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($stage)
  $payload = Join-Path $stage 'payload'
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  Confirm-PayloadHashes
  Expand-VerifiedArchive 'runtime.zip' @('node.exe') $payload
  Expand-VerifiedArchive 'app.zip' $appFiles $payload
  $appMetadata = [IO.File]::ReadAllText((Join-Path $payload 'package.json')) | ConvertFrom-Json
  if ($appMetadata.name -ne 'quota-board' -or -not $appMetadata.version) { throw '应用包元信息有误。' }

  $existingData = Test-Path -LiteralPath (Join-Path $InstallRoot 'data')
  $entries = foreach ($relative in $allFiles) {
    if ($existingData -and $relative -eq 'data/config.example.json') { continue }
    $target = Join-Path $InstallRoot $relative
    Assert-OrdinaryPath $target
    [PSCustomObject]@{
      Relative = $relative
      Source = Join-Path $payload $relative
      Target = $target
      HadOriginal = [IO.File]::Exists($target)
      Backup = Join-Path (Join-Path $stage 'previous') $relative
      Failed = Join-Path (Join-Path $stage 'failed') $relative
    }
  }

  $journal = Join-Path $stage 'pending.json'
  $record = @{ installRoot = $InstallRoot; files = @($entries | Select-Object Relative, HadOriginal) }
  [IO.File]::WriteAllText($journal, ($record | ConvertTo-Json -Depth 4))
  $keepStage = $true
  $attempted = [Collections.Generic.List[object]]::new()
  try {
    foreach ($item in $entries) {
      Assert-OrdinaryPath $item.Target
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Target))
      $attempted.Add($item)
      if ($item.HadOriginal) {
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Backup))
        [IO.File]::Replace($item.Source, $item.Target, $item.Backup)
      } else {
        [IO.File]::Move($item.Source, $item.Target)
      }
    }
  } catch {
    $failure = $_.Exception.Message
    $restoreErrors = @(Restore-InstalledFiles $attempted)
    if ($restoreErrors.Count -gt 0) {
      throw "安装失败，并有文件未能自动恢复。备份及恢复记录位于 $stage。$failure $($restoreErrors -join ' ')"
    }
    [IO.File]::Delete($journal)
    $keepStage = $false
    throw "安装失败，已恢复先前的程序文件。$failure"
  }
  [IO.File]::Delete($journal)
  $keepStage = $false
  $exitCode = 0

  if (-not $NoLaunch) {
    try {
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
    } catch {
      Write-Warning "程序安装完成。未能创建快捷方式或启动，请在安装目录打开 launch.vbs。$($_.Exception.Message)"
    }
  }
  Write-Output 'Installation complete.'
} catch {
  if (-not $NoLaunch) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '额度一念安装失败') | Out-Null
  }
  Write-Error $_ -ErrorAction Continue
} finally {
  if ($stage -and -not $keepStage) {
    try { Remove-SetupStage $stage $parent $prefix } catch { Write-Warning "安装暂存目录未能清理：$stage" }
  }
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  if ($mutex) { $mutex.Dispose() }
}
exit $exitCode
