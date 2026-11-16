@echo off
cd /d %~dp0
title video-report

if not exist node_modules\express (
  echo Installing dependencies, this may take 1-2 minutes...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency install failed. Check your network and try again.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1"
