@echo off
chcp 65001 >nul 2>nul
title PLAYBILL
cd /d "%~dp0"

if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0launcher.mjs"
  goto :end
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] 没有找到 Node 运行时。
  echo.
  echo   请重新下载完整压缩包（带 runtime 文件夹的那个），
  echo   或安装 Node.js 20+ : https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node "%~dp0launcher.mjs"

:end
echo.
echo   已停止。按任意键关闭。
pause >nul