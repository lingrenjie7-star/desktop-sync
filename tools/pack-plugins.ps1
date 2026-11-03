# Package both plugins into a distributable zip.
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI.
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
if ([string]::IsNullOrEmpty($here)) { throw 'PSScriptRoot is empty; run this file directly' }

$root  = Split-Path -Parent $here
$dist  = Join-Path $root 'dist'
$stage = Join-Path $env:TEMP 'dshwb-plugins-stage'

Write-Host "root  = $root"
Write-Host "dist  = $dist"

if (-not (Test-Path $dist)) { throw "dist not found: $dist" }

if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

# Folder names from code points so this file stays ASCII.
$outName = -join @(0x8DE8,0x7535,0x8111,0x540C,0x6B65,0x63D2,0x4EF6 | ForEach-Object { [char]$_ })
$dshName = 'DSH ' + [char]0x63D2 + [char]0x4EF6
$wbName  = 'WorkBuddy ' + [char]0x6269 + [char]0x5C55

$out = Join-Path $stage $outName
New-Item -ItemType Directory -Path $out | Out-Null

# DSH plugin = dsh-dntb (same name as the npm/GitHub package)
# WorkBuddy extension = dshwb-sync (its own extension system)
$dshDist = $dist + '\dsh\dsh-dntb'
$wbDist  = $dist + '\workbuddy\dshwb-sync'

Write-Host "dshDist = $dshDist  exists=$(Test-Path $dshDist)"
Write-Host "wbDist  = $wbDist  exists=$(Test-Path $wbDist)"

if (-not (Test-Path $dshDist)) { throw "missing DSH build: $dshDist" }
if (-not (Test-Path $wbDist))  { throw "missing WorkBuddy build: $wbDist" }

Copy-Item -LiteralPath $dshDist -Destination (Join-Path $out $dshName) -Recurse
Copy-Item -LiteralPath $wbDist  -Destination (Join-Path $out $wbName)  -Recurse

$readme = $root + '\plugins\README.md'
$install = $root + '\plugins\install-dsh.ps1'
if (Test-Path $readme)  { Copy-Item -LiteralPath $readme  -Destination (Join-Path $out 'README.md') }
if (Test-Path $install) { Copy-Item -LiteralPath $install -Destination (Join-Path $out 'install-dsh.ps1') }

# Version comes from the DSH plugin's package.json so the filename never lies.
$pkgFile = $dshDist + '\package.json'
$pkg = Get-Content -LiteralPath $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version

$zip = $root + '\' + $outName + '-v' + $version + '.zip'
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }

Push-Location $stage
& tar.exe -a -c -f $zip $outName
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "pack failed (tar exit $code)" }

Write-Host "version: $version"
Get-Item -LiteralPath $zip | Select-Object Name, Length
