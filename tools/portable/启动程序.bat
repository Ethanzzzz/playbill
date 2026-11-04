@echo off
chcp 65001 >nul 2>nul
title PSN Archive
cd /d "%~dp0"

if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0launcher.mjs"
  goto :end
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] Node runtime not found.
  echo.
  echo   Please download the FULL package again ^(the one with runtime\ folder^),
  echo   or install Node.js 20+ from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node "%~dp0launcher.mjs"

:end
echo.
echo   Stopped. Press any key to close.
pause >nul
