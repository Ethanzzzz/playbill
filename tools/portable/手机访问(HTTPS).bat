@echo off
chcp 65001 >nul 2>nul
title PLAYBILL - Phone (HTTPS)
cd /d "%~dp0"

echo.
echo   === 手机装成 App（PWA）===
echo.
echo   这一步会生成一张本机自签证书，让手机能用 HTTPS 打开。
echo   证书只在你自己的电脑和手机上生效，不会联网。
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\make-cert.ps1"
if errorlevel 1 (
  echo.
  echo   [X] 证书生成失败。可以先把错误发给我。
  echo.
  pause
  exit /b 1
)

echo   正在打开证书所在文件夹...
start "" "%APPDATA%\PLAYBILL\tls"

echo.
echo   记得：关掉正在运行的「启动程序.bat」窗口，再重新双击它，
echo   这次服务会以 HTTPS 启动（黑窗口里会显示 https:// 地址）。
echo.
pause