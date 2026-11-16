$ErrorActionPreference = 'Stop'
$miniRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $miniRoot 'data\server.pid'
$launcherPath = Join-Path $miniRoot 'data\launcher.json'
if (-not (Test-Path -LiteralPath $pidPath)) { Write-Host 'No launcher-managed server is running.'; exit 0 }
$miniPid = [int](Get-Content -LiteralPath $pidPath)
$miniProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $miniPid"
$entry = Join-Path $miniRoot 'server\index.mjs'
if ($miniProcess -and $miniProcess.Name -eq 'node.exe' -and $miniProcess.CommandLine.Contains($entry)) {
  $miniPort = if ($env:PORT) { $env:PORT } else { '4310' }
  if (Test-Path -LiteralPath $launcherPath) {
    $launcher = Get-Content -Raw -LiteralPath $launcherPath | ConvertFrom-Json
    if ($launcher.pid -ne $miniPid) { throw 'Launcher metadata does not match the server. Nothing was stopped.' }
    $miniPort = $launcher.port
  }
  if (Test-Path -LiteralPath $launcherPath) {
    $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$miniPort/api/health" -TimeoutSec 3
    if ($ready.app -ne 'donkey-studio-mini' -or $ready.pid -ne $miniPid) { throw 'The port belongs to another server. Nothing was stopped.' }
  }
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$miniPort/api/shutdown" -TimeoutSec 10 | Out-Null
  Wait-Process -Id $miniPid -Timeout 20 -ErrorAction SilentlyContinue
  if (Get-Process -Id $miniPid -ErrorAction SilentlyContinue) { throw 'The server is still shutting down. Wait, then run this launcher again.' }
  Write-Host 'Donkey-Studio Mini stopped.'
} else { Write-Host 'No matching Donkey-Studio Mini process. Nothing was stopped.' }
Remove-Item -LiteralPath $pidPath
if (Test-Path -LiteralPath $launcherPath) { Remove-Item -LiteralPath $launcherPath }
