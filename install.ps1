# Install dsh-agent-browser into the DSH desktop profile.
# One-click: double-click "install.cmd" in this folder.
# Manual:    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#
# NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 reads a
#       BOM-less UTF-8 .ps1 file as ANSI and would corrupt non-ASCII text.
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$profileDir = $ProfileDir
$pkgName = '@local/dsh-agent-browser'
$target = Join-Path $profileDir 'node_modules\@local\dsh-agent-browser'

Write-Host "source      : $source"
Write-Host "profile dir : $profileDir"

if (-not (Test-Path $profileDir)) {
  throw "Profile directory not found: $profileDir (start the DSH desktop app at least once first)"
}
if (-not (Test-Path (Join-Path $source 'index.js'))) {
  throw "Run this script from the repository root (index.js not found next to install.ps1)"
}

function Write-Utf8NoBom([string]$path, [string]$text) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $utf8)
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# 1) back up an existing installation (if any)
if (Test-Path $target) {
  $backup = Join-Path $profileDir ('agent-browser-backups\install-' + $stamp)
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  Copy-Item -Path (Join-Path $target '*') -Destination $backup -Recurse -Force
  Write-Host "backup      : $backup"
}

# 2) copy the runtime files; never overwrite an existing user configuration
New-Item -ItemType Directory -Force -Path $target | Out-Null
$files = 'index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md'
foreach ($name in $files) {
  $from = Join-Path $source $name
  $to = Join-Path $target $name
  if (-not (Test-Path $from)) { throw "Missing source file: $from" }
  if ($name -eq 'cordis.patch.yml' -and (Test-Path $to)) {
    Write-Host "kept config : $to (existing cordis.patch.yml not overwritten)"
    continue
  }
  Copy-Item $from $to -Force
}
Write-Host "copied to   : $target"

# 3) register the bundle in the profile manifest (backup first, rollback on failure)
$manifest = Join-Path $profileDir 'package.json'
if (-not (Test-Path $manifest)) { throw "Manifest not found: $manifest" }
$manifestBackup = Join-Path $profileDir ('package.json.bak-' + $stamp)
Copy-Item $manifest $manifestBackup -Force
Write-Host "backup      : $manifestBackup"

try {
  $json = Get-Content -Raw -Encoding UTF8 $manifest | ConvertFrom-Json
  if (-not $json.dsh) { $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
  if (-not $json.dsh.profile) { $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
  $bundles = @()
  if ($json.dsh.profile.bundles) { $bundles = @($json.dsh.profile.bundles) }
  if ($bundles -notcontains $pkgName) {
    $bundles += $pkgName
    $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
    Write-Utf8NoBom $manifest ($json | ConvertTo-Json -Depth 24)
    Write-Host "registered  : $pkgName -> dsh.profile.bundles"
  } else {
    Write-Host "registered  : $pkgName already present, manifest untouched"
  }

  # validate: manifest is still valid JSON, the entry is there, the package is well formed
  $check = Get-Content -Raw -Encoding UTF8 $manifest | ConvertFrom-Json
  if (@($check.dsh.profile.bundles) -notcontains $pkgName) { throw 'post-write validation failed (bundle missing)' }
  $pkg = Get-Content -Raw -Encoding UTF8 (Join-Path $target 'package.json') | ConvertFrom-Json
  if ($pkg.dsh.bundle.patch -ne './cordis.patch.yml') { throw 'post-write validation failed (package manifest)' }
  if ($pkg.dsh.client.platform -ne 'web') { throw 'post-write validation failed (client section)' }
} catch {
  Copy-Item $manifestBackup $manifest -Force
  throw "Failed to register the bundle; package.json rolled back: $($_.Exception.Message)"
}

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host 'Next steps:'
Write-Host '  1. Fully quit and restart the DSH desktop app (a page refresh is not enough).'
Write-Host '  2. Open the right sidebar and pick the "AI Browser" tab (or just let the agent use it once).'
Write-Host '  3. Open your target site in the panel and sign in once, if needed.'
Write-Host '  4. Then let the agent read the page / fill the form. In confirm mode, URLs'
Write-Host '     outside the allowlist ask for your approval first.'
Write-Host ''
Write-Host 'To uninstall, run uninstall.cmd in this folder.'
