# 绿色版打包说明

这里的文件用于生成「解压即用」的 Windows 绿色版（挂到 GitHub Releases 上分发）。

## 包内结构

```
PSN收藏档案/
├─ 启动程序.bat        # 双击启动，自动开浏览器
├─ 启动浏览器.bat      # 以调试模式启动 Edge（抓 Cookie 用）
├─ 抓取Cookie.bat      # 从浏览器读取 npsso + pdccws_p
├─ 使用说明.txt
├─ launcher.mjs        # 启动器：端口检查 + 拉起服务 + 开浏览器
├─ runtime/
│  └─ node.exe         # Node 运行时（约 89 MB，不放进仓库）
├─ server/             # ← 从仓库根目录复制
├─ web/                # ← 从仓库根目录复制
└─ tools/
   └─ capture-cookies.mjs
```

## 怎么打包

```powershell
# 1. 准备目录
mkdir PSN收藏档案
copy 启动程序.bat,启动浏览器.bat,抓取Cookie.bat,使用说明.txt,launcher.mjs PSN收藏档案\
xcopy /E /I ..\..\server PSN收藏档案\server
xcopy /E /I ..\..\web PSN收藏档案\web
mkdir PSN收藏档案\tools
copy ..\capture-cookies.mjs PSN收藏档案\tools\

# 2. 放入 Node 运行时
mkdir PSN收藏档案\runtime
copy <node安装目录>\node.exe PSN收藏档案\runtime\node.exe

# 3. 压缩
Compress-Archive -Path PSN收藏档案 -DestinationPath PSN收藏档案-绿色版-vX.Y.Z.zip
```

## 注意事项

- **`runtime/node.exe` 不进仓库**（89 MB，会让 clone 极慢），只放 Release 附件
- `.bat` 文件必须是 **CRLF 换行**，否则双击会闪退（Windows cmd 的要求）
- 打包前确认目录里**没有** `server/data.json` 和 `server/price-history.json`
- 别把 `edge-profile/`（浏览器配置）打进去
