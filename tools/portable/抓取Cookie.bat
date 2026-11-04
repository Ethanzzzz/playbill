@echo off
chcp 65001 >nul 2>nul
title PSN Archive - Capture Cookies
cd /d "%~dp0"

echo.
echo   正在从浏览器读取 PSN Cookie...
echo   请确认：浏览器以 --remote-debugging-port=9222 启动，且已登录 store.playstation.com
echo.

if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0tools\capture-cookies.mjs"
) else (
  node "%~dp0tools\capture-cookies.mjs"
)

echo.
pause
