# PLAYBILL

**一份关于你 PlayStation 收藏的账单。**

盘账：这些年到底在 PSN 上花了多少、每款游戏是原价还是打折买的、现在值多少钱、买贵了哪几笔。
按「系列 → 捆绑包 / 本体 / DLC」归档，配商店现价与价格历史。

本地优先（local-first）：账号令牌、Cookie、购买记录全部留在你自己的电脑上，代码里没有任何遥测。

> ⚠️ 本项目调用索尼**未公开接口**，可能违反服务条款，存在账号受限风险，请自行评估后使用。

![总览](docs/img/overview.png)

---

## 功能

| | |
|---|---|
| **消费总览** | 累计投入 / 当前价值 / 累计省下，月度柱状图、构成环形图、系列排行、当前折扣榜 |
| **系列档案** | 点开「生化危机」，看到这个系列花了多少、哪些是本体、哪些是 DLC |
| **树形下钻** | 一个游戏只占一行；捆绑包、季票、DLC 收在展开层，不会重复出现 |
| **价格历史** | 每日商店快照，画出买入以来的价格曲线，标出史低与你的买入价 |
| **来源标记** | 区分真金白银购买、PS Plus 领取、免费领取、随包附赠 |
| **捆绑包分析** | 包内含哪几款、当前包价 vs 单买合计、每个子项的分摊成本 |
| **手机 App** | 装成 PWA：全屏、有图标、离线可开 |

| 系列档案 | 手机 |
|---|---|
| ![系列](docs/img/series.png) | ![手机](docs/img/mobile.png) |

---

## 快速开始

### 下载即用（推荐，零安装）

不需要 Node.js，不需要命令行。

1. 到 [Releases](../../releases) 下载 `PLAYBILL-portable-v*-win64.zip`
2. 解压到任意文件夹（比如桌面）
3. 双击 **`启动程序.bat`**

浏览器会自动打开。首次使用按提示登录一次，之后每次双击即用。

> ⚠️ 不要用「Code → Download ZIP」：那是源码，没有内置运行时，双击启动不了。

首次使用共四步：启动浏览器登录 PSN → 抓取 Cookie → 同步游戏库 → 同步交易记录。
详见 **[使用指南](docs/USAGE.md)**。

### 在手机上装成 App

1. 双击 **`手机访问(HTTPS).bat`** 生成一张本机证书
2. 重开 `启动程序.bat`，窗口里会出现 `https://<局域网地址>`
3. 把证书传到手机并安装、在「证书信任设置」里打开完全信任
4. Safari 打开该地址 → 分享 → **添加到主屏幕**

分步图文见 **[使用指南 · 手机](docs/USAGE.md#9-在手机上装成-app)**。

### 从源码运行（开发者）

需要 Node.js 20+：

```bash
git clone https://github.com/Ethanzzzz/playbill.git
cd playbill
npm start          # → http://localhost:8787
```

---

## 工作原理

数据来自四个只读接口：

| 数据 | 接口 | 用途 |
|---|---|---|
| 账号令牌 | `ca.account.sony.com/api/authz/v3/oauth` | 换取 access token |
| 游戏库 | GraphQL `getPurchasedGameList` | 拥有的游戏与封面 |
| 交易记录 | GraphQL `transactionHistoryRetrieve` | 每笔订单的商品、金额、日期 |
| 商店现价 | GraphQL `productRetrieveForCtasWithPrice` | 当前原价 / 折后价 |

商品按 ID 前两段（如 `HP0700-CUSA02957_00`）归到同一个游戏命名空间，再按「本体 / 捆绑包 / DLC / 其他」分层。
查现价使用匿名请求——带上登录 Cookie 时，已拥有的商品只会返回「已购买」按钮、没有价格。

更多细节见 **[技术说明](docs/ARCHITECTURE.md)**。

---

## 数据安全

### 存在哪里

| 路径 | 内容 |
|---|---|
| `%APPDATA%\PLAYBILL\data.json` | 令牌、Cookie、游戏库、全部交易记录（**极高敏感**） |
| `%APPDATA%\PLAYBILL\price-history.json` | 每日价格快照 |
| `%APPDATA%\PLAYBILL\tls\` | 手机用的自签证书（只有本机有效） |
| `%LOCALAPPDATA%\PLAYBILL\edge-profile` | 抓 Cookie 用的独立浏览器配置 |

macOS / Linux 对应 `~/.config/PLAYBILL`；可用 `PLAYBILL_DATA_DIR` 改位置。

数据不在程序文件夹里，所以换版本、删掉程序目录都不会丢，备份就是复制这个目录。

### 不要做

- 不要把 `data.json` 发给任何人（里面的 `npsso` 等于账号密码）
- 不要开多人共用的公共实例
- 不要把带 `npsso` 的截图发到社交媒体

### 一键登出

应用右上角头像 → 「登出并清除凭证」，删除本地保存的令牌与 Cookie。

---

## 部署

本项目不提供公共托管——凭证不该集中存管。想放到自己的服务器上：

**Render**：Fork 仓库 → New → Blueprint（已带 `render.yaml`）。
**Railway**：Deploy from GitHub（已带 `railway.json`）。
**Docker**：

```bash
docker build -t playbill .
docker run -p 8787:8080 -v playbill-data:/data playbill
```

免费实例的磁盘是临时的，重新部署会清空数据，建议定期用「导出 JSON」备份。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 页面只有引导页 | 还没同步交易：完成四步 |
| 当前价值显示「—」 | 现价覆盖不足 80%，再点一次「更新商店现价与封面」 |
| 交易接口 `Access denied` | 会话被登出或调用过频：等 5 分钟，或重做「启动浏览器 → 抓取Cookie」 |
| 价格全是「未知」 | 同上，先同步现价 |
| 手机装不了 App | 证书没装好；见 [使用指南 · 手机](docs/USAGE.md#9-在手机上装成-app) |
| 页面还是旧样式 | `Ctrl + F5` 强制刷新（Service Worker 缓存） |

更多见 [使用指南的排错表](docs/USAGE.md#8-排错表)。

---

## 已知限制

- 少数已下架商品查不到现价，会显示「—」。
- 索尼的交易接口有频率限制，短时间内反复同步会被拒。
- 网页会话可能被索尼主动登出，重做「启动浏览器 → 抓取Cookie」即可。
- 系列归类覆盖常见 IP，长尾作品归入「其他 / 独立作品」。

---

## 许可

[MIT](LICENSE)。与 Sony Interactive Entertainment 无关，PlayStation / PSN 是其注册商标。
