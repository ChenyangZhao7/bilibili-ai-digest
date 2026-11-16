@echo off
cd /d %~dp0
echo === Push video-filter to GitHub ===
echo.

powershell -NoProfile -Command "if (Test-NetConnection github.com -Port 443 -InformationLevel Quiet) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo GitHub is not reachable from this network.
  echo Turn on your VPN / proxy, then double-click this file again.
  pause
  exit /b 1
)

echo Step 1/2: configuring Git Credential Manager (a browser sign-in may open once).
git credential-manager configure

echo.
echo Step 2/2: pushing main to https://github.com/ChenyangZhao7/video
git push -u origin main
if errorlevel 1 (
  echo.
  echo Push failed.
  echo If it asked for a password: use a Personal Access Token (classic, scope: repo) as the password.
  echo If it said the remote moved: run "git pull --rebase origin main" first.
  pause
  exit /b 1
)

echo.
echo Done: https://github.com/ChenyangZhao7/video
pause
