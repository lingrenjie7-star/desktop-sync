# Publish the three repos to GitHub (ASCII only; paths from env).
$ErrorActionPreference = 'Stop'

$token = $env:DSHWB_TOKEN
$user  = 'lingrenjie7-star'
$base  = $env:DSHWB_BASE
if ([string]::IsNullOrEmpty($token)) { throw 'DSHWB_TOKEN not set' }
if ([string]::IsNullOrEmpty($base))  { throw 'DSHWB_BASE not set' }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$hdr = @{ Authorization = "token $token"; 'User-Agent' = 'publish'; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }

$repos = @(
  @{ dir = 'dsh-sync';     desc = ([char]0x8DE8 + [char]0x7535 + [char]0x8111 + [char]0x540C + [char]0x6B65 + ' - DeepSeek Harness plugin'); tag = 'v1.0.1' },
  @{ dir = 'wb-sync';      desc = ([char]0x8DE8 + [char]0x7535 + [char]0x8111 + [char]0x540C + [char]0x6B65 + ' - WorkBuddy extension'); tag = 'v2.0.0' },
  @{ dir = 'desktop-sync'; desc = ([char]0x8DE8 + [char]0x7535 + [char]0x8111 + [char]0x540C + [char]0x6B65 + ' - desktop client'); tag = 'v2.0.7' }
)

$env:GIT_TERMINAL_PROMPT = '0'

foreach ($r in $repos) {
  Write-Host ""
  Write-Host "===== $($r.dir) ====="

  # 1. create repo
  $body = @{ name = $r.dir; description = $r.desc; private = $false; has_issues = $true; has_wiki = $false; has_projects = $false; auto_init = $false } | ConvertTo-Json
  $bytes = $utf8.GetBytes($body)
  try {
    $res = Invoke-WebRequest -Uri 'https://api.github.com/user/repos' -Method POST -Headers $hdr -Body $bytes -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec 60
    Write-Host "  created"
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 422) { Write-Host "  already exists" } else { throw "create failed ($code)" }
  }

  # 2. init + commit + push
  $path = Join-Path $base $r.dir
  if (-not (Test-Path $path)) { throw ("missing: " + $path) }
  Push-Location $path

  if (Test-Path '.git') { Remove-Item '.git' -Recurse -Force -ErrorAction SilentlyContinue }
  git init -b main 2>&1 | Out-Null
  git config user.name  $user
  git config user.email ($user + '@users.noreply.github.com')
  git config core.autocrlf false

  git add -A 2>&1 | Out-Null
  $n = (git status --porcelain | Measure-Object).Count
  Write-Host "  staged: $n"
  git commit -m ($r.dir + ' ' + $r.tag) 2>&1 | Out-Null

  $url = 'https://x-access-token:' + $token + '@github.com/' + $user + '/' + $r.dir + '.git'
  git remote add origin $url

  $pushed = $false
  for ($i = 1; $i -le 5 -and -not $pushed; $i++) {
    $out = git push -u origin main 2>&1
    if ($out -match 'main -> main') { $pushed = $true; Write-Host "  push OK (attempt $i)" }
    else { Write-Host "  push retry $i"; Start-Sleep -Seconds 6 }
  }
  if (-not $pushed) { Pop-Location; throw ("push failed: " + $r.dir) }

  git tag -a $r.tag -m $r.tag 2>&1 | Out-Null
  for ($i = 1; $i -le 3; $i++) {
    $t = git push origin $r.tag 2>&1
    if ($t -match 'new tag|up-to-date') { Write-Host "  tag $($r.tag) OK"; break }
    Start-Sleep -Seconds 4
  }

  Pop-Location
}

Write-Host ""
Write-Host "ALL DONE"
