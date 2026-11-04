# 启动 PSN 收藏档案（本地）
# 用法：powershell -ExecutionPolicy Bypass -File .\start.ps1
param(
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"

$cmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $cmd) {
  Write-Host ""
  Write-Host "未找到 Node.js。" -ForegroundColor Red
  Write-Host "请先安装 Node 20 或更高版本： https://nodejs.org/" -ForegroundColor Yellow
  Write-Host "安装后重新运行本脚本。" -ForegroundColor Yellow
  Write-Host ""
  Read-Host "按回车退出"
  exit 1
}

Write-Host ""
Write-Host "Node: $($cmd.Source)" -ForegroundColor DarkGray
$env:PORT = "$Port"
& $cmd.Source "$PSScriptRoot\server\index.mjs"
