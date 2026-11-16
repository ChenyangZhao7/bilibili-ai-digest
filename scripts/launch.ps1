$ErrorActionPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$url = 'http://127.0.0.1:4318'

function Test-ServicePort {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', 4318)
    $client.Close()
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

if (Test-ServicePort) {
  Write-Host 'Service already running, opening browser...'
  Start-Process $url
  exit 0
}

Write-Host 'Starting the report service in a new window. Close that window to stop it.'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'node server.ts' -WorkingDirectory $root

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest "$url/api/health" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    # 还没起来，继续等
  }
}

if (-not $ready) {
  Write-Host 'Service did not start in 20 seconds. Check the other window for errors.'
  exit 1
}

Start-Process $url
exit 0
