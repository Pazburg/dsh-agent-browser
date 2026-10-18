# Uninstall dsh-agent-browser: drop it from dsh.profile.bundles and delete the plugin folder.
# One-click: double-click "uninstall.cmd" in this folder.
# NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less UTF-8 .ps1 as ANSI).
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$profileDir = $ProfileDir
$pkgName = '@local/dsh-agent-browser'
$target = Join-Path $profileDir 'node_modules\@local\dsh-agent-browser'
$manifest = Join-Path $profileDir 'package.json'

if (-not (Test-Path $manifest)) { throw "Manifest not found: $manifest" }

function Write-Utf8NoBom([string]$path, [string]$text) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $utf8)
}

$backup = Join-Path $profileDir ('package.json.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item $manifest $backup -Force
Write-Host "backup      : $backup"

try {
  $json = Get-Content -Raw -Encoding UTF8 $manifest | ConvertFrom-Json
  $bundles = @()
  if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) { $bundles = @($json.dsh.profile.bundles) }
  $kept = @($bundles | Where-Object { $_ -ne $pkgName })
  if ($kept.Count -ne $bundles.Count) {
    $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $kept -Force
    Write-Utf8NoBom $manifest ($json | ConvertTo-Json -Depth 24)
    Write-Host "unregistered: $pkgName"
  } else {
    Write-Host "unregistered: $pkgName was not listed, manifest untouched"
  }
  $check = Get-Content -Raw -Encoding UTF8 $manifest | ConvertFrom-Json
  if (@($check.dsh.profile.bundles) -contains $pkgName) { throw 'post-write validation failed' }
} catch {
  Copy-Item $backup $manifest -Force
  throw "Failed to unregister; package.json rolled back: $($_.Exception.Message)"
}

if (Test-Path $target) {
  Remove-Item -Recurse -Force $target
  Write-Host "removed     : $target"
}
Write-Host 'Uninstalled. Restart the DSH desktop app.' -ForegroundColor Green
