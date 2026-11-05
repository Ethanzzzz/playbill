@echo off
chcp 65001 >nul 2>nul
title PSN Archive - Browser
cd /d "%~dp0"

echo.
echo   正在以「调试模式」启动 Edge 浏览器...
echo.
echo   接下来请在这个浏览器窗口里：
echo     1. 登录你的 PSN 账号
echo     2. 打开 store.playstation.com
echo.
echo   登录完成后，回来双击「抓取Cookie.bat」
echo.

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"

if not exist "%EDGE%" (
  echo   [X] 没有找到 Edge 浏览器。
  echo       请安装 Microsoft Edge 后再试。
  echo.
  pause
  exit /b 1
)

rem 浏览器配置放在用户目录，不放进程序文件夹（否则会有几百 MB，还删不掉）
set "PROFILE=%LOCALAPPDATA%\PSNArchive\edge-profile"
if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>nul

start "" "%EDGE%" --remote-debugging-port=9222 --user-data-dir="%PROFILE%" "https://store.playstation.com/"

echo   已启动。等浏览器打开后，登录 PSN 即可。
echo.
echo   （这个窗口可以直接关掉）
timeout /t 6 >nul
exit /b 0
