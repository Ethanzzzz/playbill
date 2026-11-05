# make-cert.ps1 — 为 PLAYBILL 生成局域网 HTTPS 证书（手机装成 App 用）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-cert.ps1 [-Force]
#
# 产物都在 %APPDATA%\PLAYBILL\tls\：
#   playbill.pfx   服务端用（含私钥，别外传）
#   playbill.cer   手机装这个（只有公钥）
#   pass.txt       pfx 口令（本机随机生成）
#
# 换 Wi-Fi / IP 变了要重新跑一次，脚本会自动发现并重签。

param([switch]$Force)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$dir = Join-Path $env:APPDATA "PLAYBILL\tls"
$pfx = Join-Path $dir "playbill.pfx"
$cer = Join-Path $dir "playbill.cer"
$passFile = Join-Path $dir "pass.txt"
$metaFile = Join-Path $dir "meta.json"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# 当前所有内网 IPv4（含热点网关）
$ips = @()
try {
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress -Unique
} catch {
  $ips = @((Get-NetIPConfiguration | Where-Object { $_.IPv4Address } | ForEach-Object { $_.IPv4Address.IPAddress }))
}
$ips = @($ips | Where-Object { $_ })

$want = @("127.0.0.1") + $ips

# 已有证书且仍然覆盖当前地址 → 直接复用
# （只看自己写的 meta.json，不去碰 pfx 的口令，避免弹密码框）
if ((Test-Path $pfx) -and (Test-Path $metaFile) -and -not $Force) {
  try {
    $meta = Get-Content $metaFile -Raw | ConvertFrom-Json
    $have = @($meta.ips)
    $missing = @($want | Where-Object { $have -notcontains $_ })
    if ($missing.Count -eq 0) {
      Write-Host ""
      Write-Host "  证书已经存在，且覆盖当前所有地址：" -ForegroundColor Green
      Write-Host "  $pfx"
      if (-not (Test-Path $cer)) {
        $p = Get-Content $passFile -Raw
        $x = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($pfx, $p.Trim())
        $der = $x.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
        [System.IO.File]::WriteAllBytes($cer, $der)
      }
      Write-Host "  手机安装用： $cer"
      Write-Host ""
      Write-Host "  如果服务还没以 HTTPS 启动：关掉黑窗口，重新双击「启动程序.bat」。"
      Write-Host ""
      exit 0
    }
    Write-Host "  地址变了（缺 $($missing -join ', ')），重新签发证书…" -ForegroundColor Yellow
  } catch {
    Write-Host "  读取旧证书信息失败，重新签发…" -ForegroundColor Yellow
  }
}

# 生成 SAN：本机 + 所有内网地址 + 一个固定别名
$san = @("DNS=localhost", "DNS=playbill.local") + @($want | ForEach-Object { "IPAddress=$_" })
$sanText = $san -join "&"

# 本机随机口令（避免空口令在导出/PFX 读取时的兼容问题）
$chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray()
$pass = -join (1..20 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })

Write-Host ""
Write-Host "  正在生成证书（本机自签，不会联网）…" -ForegroundColor Cyan

$cert = New-SelfSignedCertificate `
  -Subject "CN=PLAYBILL" `
  -TextExtension @("2.5.29.17={text}$sanText", "2.5.29.37={text}1.3.6.1.5.5.7.3.1") `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -KeyExportPolicy Exportable `
  -KeyLength 2048 `
  -NotAfter (Get-Date).AddDays(365) `
  -CertStoreLocation "Cert:\CurrentUser\My"

$sec = ConvertTo-SecureString -String $pass -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $sec | Out-Null
Export-Certificate -Cert $cert -FilePath $cer -Type CERT | Out-Null
Set-Content -LiteralPath $passFile -Value $pass -Encoding ASCII
$meta = @{ ips = $want; generatedAt = (Get-Date).ToString("s"); notAfter = $cert.NotAfter.ToString("s") } | ConvertTo-Json
Set-Content -LiteralPath $metaFile -Value $meta -Encoding UTF8

Write-Host ""
Write-Host "  ✅ 证书已生成" -ForegroundColor Green
Write-Host "     服务端： $pfx"
Write-Host "     手机用： $cer"
Write-Host "     覆盖地址： localhost, $($want -join ', ')"
Write-Host ""
Write-Host "  下一步：" -ForegroundColor Cyan
Write-Host "    1) 关掉正在运行的程序窗口，重新双击「启动程序.bat」（这次会以 HTTPS 启动）"
Write-Host "    2) 把 playbill.cer 传到手机（AirDrop / 微信文件传输 / 邮件都行）"
Write-Host "    3) 手机上：设置 → 已下载描述文件 → 安装；再到 设置 → 通用 → 关于本机 →"
Write-Host "       证书信任设置 → 打开对 PLAYBILL 的完全信任"
Write-Host "    4) Safari 打开程序窗口里显示的 https://地址，分享 → 添加到主屏幕"
Write-Host ""
