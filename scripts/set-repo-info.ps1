$ErrorActionPreference = 'Stop'

$repo = 'ChenyangZhao7/video'
$infoPath = Join-Path $PSScriptRoot 'repo-info.json'

try {
  $gcm = 'C:\Program Files\Git\mingw64\bin\git-credential-manager.exe'
  $query = @('protocol=https', 'host=github.com', '')
  $credential = $query | & $gcm get 2>$null
} catch {
  $credential = $null
}

$token = $null
foreach ($line in $credential) {
  if ($line -match '^password=(.+)$') {
    $token = $Matches[1]
  }
}

if (-not $token) {
  Write-Host 'No GitHub credential found, skipping repo description update.'
  Write-Host "Set it manually at https://github.com/$repo (About -> gear icon)."
  exit 0
}

$body = Get-Content $infoPath -Raw -Encoding UTF8

try {
  Invoke-RestMethod -Method Patch -Uri "https://api.github.com/repos/$repo" `
    -Headers @{
      Authorization        = "Bearer $token"
      Accept               = 'application/vnd.github+json'
      'User-Agent'         = 'video-filter'
      'X-GitHub-Api-Version' = '2022-11-28'
    } `
    -Body $body `
    -ContentType 'application/json; charset=utf-8' | Out-Null

  Write-Host "Repo description and topics updated: https://github.com/$repo"
} catch {
  Write-Host "Could not update repo description automatically: $($_.Exception.Message)"
  Write-Host "Set it manually at https://github.com/$repo (About -> gear icon)."
}
