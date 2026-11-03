# Install the DSH plugin into the desktop profile.
#
# Usage (from the folder containing this file):
#   powershell -ExecutionPolicy Bypass -File install-dsh.ps1
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 as ANSI,
# so CJK text here would be mangled into syntax errors. Folder names that must
# contain CJK are built from code points instead of literals.
$ErrorActionPreference = 'Stop'

# "DSH 插件" -- built from code points so this file stays ASCII.
$dshPluginName = 'DSH ' + [char]0x63D2 + [char]0x4EF6

$here    = $PSScriptRoot
$plugin  = Join-Path $here $dshPluginName
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'

if (-not (Test-Path -LiteralPath $profile)) {
  throw "DSH profile not found: $profile  (start DSH once first)"
}
if (-not (Test-Path -LiteralPath $plugin)) {
  throw "plugin folder not found: $plugin"
}

$dest = Join-Path $profile 'node_modules\dshwb-sync'
Write-Host "installing to $dest"
if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
Copy-Item -LiteralPath $plugin -Destination $dest -Recurse

# 1) package.json: declare the bundle and the dependency
$pkgPath = Join-Path $profile 'package.json'
$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains 'dshwb-sync') {
  $pkg.dsh.profile.bundles = @($bundles + 'dshwb-sync')
}
if (-not $pkg.dependencies.'dshwb-sync') {
  $pkg.dependencies | Add-Member -NotePropertyName 'dshwb-sync' `
    -NotePropertyValue 'file:./node_modules/dshwb-sync' -Force
}
$pkg | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $pkgPath -Encoding UTF8
Write-Host "updated $pkgPath"

# 2) cordis.patch.yml: add the mount row
$patchPath = Join-Path $profile 'cordis.patch.yml'
$patch = [System.IO.File]::ReadAllText($patchPath)
if ($patch -notmatch 'id:\s*dshwb-sync') {
  $nl = [Environment]::NewLine
  $row = $nl + '- id: dshwb-sync' + $nl + '  name: dshwb-sync' + $nl
  $patch = $patch.TrimEnd() + $nl + $row
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($patchPath, $patch, $utf8)
  Write-Host "updated $patchPath"
} else {
  Write-Host "$patchPath already has the plugin row, skipped"
}

Write-Host ''
Write-Host 'Done. Restart DSH; the sync entry appears in the left sidebar.'
