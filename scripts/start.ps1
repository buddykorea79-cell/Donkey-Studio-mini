param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$miniRoot = Split-Path -Parent $PSScriptRoot
$miniData = Join-Path $miniRoot 'data'
New-Item -ItemType Directory -Force -Path $miniData | Out-Null
$miniPort = if ($env:PORT) { $env:PORT } else { '4310' }
if ($miniPort -notmatch '^\d+$' -or [long]$miniPort -lt 1 -or [long]$miniPort -gt 65535) { throw 'PORT must be a number between 1 and 65535.' }
$miniUrl = "http://127.0.0.1:$miniPort"
try {
  $ready = Invoke-RestMethod -Uri "$miniUrl/api/health" -TimeoutSec 2
  if ($ready.app -eq 'donkey-studio-mini') { if (-not $NoBrowser) { Start-Process $miniUrl }; exit 0 }
} catch {}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22 or newer is required. Install Node.js, then launch again.' }
$nodeMajor = & $node.Source -p 'parseInt(process.versions.node)'
if ($LASTEXITCODE -ne 0 -or [int]$nodeMajor -lt 22) { throw 'Node.js 22 or newer is required. Update Node.js, then launch again.' }
$entry = Join-Path $miniRoot 'server\index.mjs'
$process = Start-Process -FilePath $node.Source -ArgumentList @('"' + $entry + '"') -WorkingDirectory $miniRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $miniData 'server.log') -RedirectStandardError (Join-Path $miniData 'server-error.log')
Set-Content -LiteralPath (Join-Path $miniData 'server.pid') -Value $process.Id
@{ pid = $process.Id; port = [int]$miniPort } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $miniData 'launcher.json') -Encoding UTF8
for ($i = 0; $i -lt 40; $i++) {
  try {
    $ready = Invoke-RestMethod -Uri "$miniUrl/api/health" -TimeoutSec 1
    if ($ready.app -eq 'donkey-studio-mini' -and $ready.pid -eq $process.Id) { if (-not $NoBrowser) { Start-Process $miniUrl }; exit 0 }
  } catch {}
  if ($process.HasExited) { throw "Donkey-Studio Mini could not start. See $miniData\server-error.log" }
  Start-Sleep -Milliseconds 250
}
throw "Startup timed out. See $miniData\server-error.log"
