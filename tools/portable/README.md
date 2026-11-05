# 绿色版打包说明

这里的文件用于生成「解压即用」的 Windows 绿色版（挂到 GitHub Releases 上分发）。

## 包内结构

```
PLAYBILL/
├─ 启动程序.bat          # 双击启动，自动开浏览器
├─ 启动浏览器.bat        # 以调试模式启动 Edge（抓 Cookie 用）
├─ 抓取Cookie.bat        # 从浏览器读取 npsso + pdccws_p
├─ 手机访问(HTTPS).bat   # 生成局域网证书，手机装成 App 用
├─ 使用说明.txt
├─ launcher.mjs          # 启动器：端口检查 + 拉起服务 + 开浏览器
├─ runtime/
│  └─ node.exe           # Node 运行时（约 89 MB，不放进仓库）
├─ server/               # ← 从仓库根目录复制
├─ web/                  # ← 从仓库根目录复制
└─ tools/
   ├─ capture-cookies.mjs
   └─ make-cert.ps1
```

## 怎么打包

```powershell
# 1. 准备目录
mkdir PLAYBILL
copy 启动程序.bat,启动浏览器.bat,抓取Cookie.bat,手机访问(HTTPS).bat,使用说明.txt,launcher.mjs PLAYBILL\
xcopy /E /I ..\..\server PLAYBILL\server
xcopy /E /I ..\..\web PLAYBILL\web
mkdir PLAYBILL\tools
copy ..\capture-cookies.mjs,..\make-cert.ps1 PLAYBILL\tools\

# 2. 放入 Node 运行时
mkdir PLAYBILL\runtime
copy <node安装目录>\node.exe PLAYBILL\runtime\node.exe

# 3. 压缩
Compress-Archive -Path PLAYBILL -DestinationPath PLAYBILL-portable-vX.Y.Z-win64.zip
```

## 注意事项

- **`runtime/node.exe` 不进仓库**（89 MB，会让 clone 极慢），只放 Release 附件
- `.bat` 文件必须是 **CRLF 换行**，否则双击会闪退（Windows cmd 的要求）
- 打包前确认目录里**没有** `data.json`、`price-history.json`、`tls/`、`edge-profile/`
- Release 资产名必须是 **ASCII**（GitHub 会把中文清洗成点号）
- 打完跑一次 `node tools/verify-portable.mjs <zip>`，它会逐文件比对并扫描旧品牌与个人数据
