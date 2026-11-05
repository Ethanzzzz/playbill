@echo off
chcp 65001 >nul 2>nul
title PSN Archive - Browser
cd /d "%~dp0"

echo.
echo   正在启动「带调试端口」的 Edge...
echo.
echo   在这个窗口里请做一件事：
echo     打开 https://store.playstation.com  并登录你的 PSN 账号
echo.
echo   登录成功后，回来双击「抓取Cookie.bat」
echo   它会一次性拿到 npsso 和 pdccws_p，并自动完成登录。
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

rem 浏览器配置放用户目录，不占程序文件夹，也不会锁住它
set "PROFILE=%LOCALAPPDATA%\PSNArchive\edge-profile"
if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>nul

rem 下面这些参数用来关掉「首次运行」的欢迎页、扩展推荐、默认浏览器提示
start "" "%EDGE%" ^
 --remote-debugging-port=9222 ^
 --user-data-dir="%PROFILE%" ^
 --no-first-run ^
 --no-default-browser-check ^
 --no-service-autorun ^
 --disable-sync ^
 --disable-features=msEdgeFirstRunExperience,msEdgeSyncPromo,EdgeShoppingAssistant ^
 --disable-background-networking ^
 --noerrdialogs ^
 "https://store.playstation.com/"

echo   已启动。登录完成后回来双击「抓取Cookie.bat」即可。
echo.
echo   （这个窗口可以直接关掉）
timeout /t 6 >nul
exit /b 0
