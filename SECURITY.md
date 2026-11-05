# 安全说明

## 本项目会接触哪些敏感数据

| 数据 | 位置 | 说明 |
|---|---|---|
| `npsso` | `%APPDATA%\PLAYBILL\data.json` | 等同于账号登录凭证，有效期约 2 个月 |
| `pdccws_p` | `%APPDATA%\PLAYBILL\data.json` | 商店网页会话 Cookie，有效期约 30 天 |
| OAuth `access_token` / `refresh_token` | `%APPDATA%\PLAYBILL\data.json` | 索尼接口令牌 |
| 交易记录 | `%APPDATA%\PLAYBILL\data.json` | 每笔订单的商品、金额、时间 |

以上全部**只写入本地磁盘**，代码中不存在任何上传、上报、遥测逻辑。

## 如何确认

全仓库搜索网络调用，只应出现以下域名：

```
ca.account.sony.com
web.np.playstation.com
m.np.playstation.com
store.playstation.com
image.api.playstation.com
vulcan.dl.playstation.net
```

```bash
grep -rn "fetch(" server/ web/ | grep -v "sony.com\|playstation"
```

## 报告安全问题

如果发现凭证泄露风险（例如某个接口会把数据外发），请开 Issue 并标注 `security`，不要附带真实的 `npsso`。
