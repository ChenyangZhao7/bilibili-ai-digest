@echo off
chcp 65001 >nul
cd /d %~dp0
title 视频报告服务

if not exist node_modules\express (
  echo 首次运行，正在安装依赖，大约需要 1-2 分钟…
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo 依赖安装失败，检查网络后重试。
    pause
    exit /b 1
  )
)

powershell -NoProfile -Command "if (Test-NetConnection -ComputerName 127.0.0.1 -Port 4318 -InformationLevel Quiet) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
  echo 服务已经在运行，直接打开浏览器。
  start "" http://127.0.0.1:4318
  exit /b 0
)

start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:4318"

echo 服务启动中，关掉这个窗口就等于关闭服务。
node server.ts
pause
