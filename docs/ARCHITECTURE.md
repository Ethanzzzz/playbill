# 技术说明

给想改代码或加功能的人：数据怎么流、接口怎么调、哪些细节必须注意。

---

## 一、数据结构

核心只有一个文件：`%APPDATA%\PLAYBILL\data.json`（可用 `PLAYBILL_DATA_DIR` 覆盖；首启会把旧的 `PSNArchive` 目录改名过来）。

```jsonc
{
  "tokens": {            // OAuth 令牌
    "accessToken": "...",
    "refreshToken": "...",
    "obtainedAt": 1730000000000,
    "expiresIn": 3599
  },
  "webCookies": {        // 交易接口专用
    "npsso": "...",
    "pdccws_p": "..."
  },
  "games": [             // 游戏库（含未购买的拥有项）
    {
      "titleId": "PPSA01547_00",
      "productId": "EP1004-PPSA01547_00-GTAVIULTIMATE001",
      "name": "…",
      "platform": "PS5",
      "cover": "https://…",
      "service": "ps_plus",          // 来源：自有 / 会员 / 其他
      "purchasePrice": 708,
      "purchaseDate": "2026-08-20"
    }
  ],
  "catalog": [           // 交易明细展开后的商品目录
    {
      "productId": "HP0700-CUSA02957_00-NUNS4S0000000000",
      "name": "…",
      "kind": "dlc",                  // bundle | game | dlc | avatar | demo | …
      "series": "naruto",
      "seriesLabel": "火影忍者",
      "totalSpent": 79,
      "purchases": [{ "date": "2025-06-21", "price": 79 }],
      "store": { "price": { "basePrice": 79, "discountedPrice": 79 } },
      "grantedBy": "HP0700-…-OTHER",  // 随包附赠溯源
      "contains": [{ "name": "…", "productId": "…" }]
    }
  ],
  "series": [            // 由 catalog 聚合
    { "key": "naruto", "label": "火影忍者", "totalSpent": 174.8, "products": [ … ] }
  ],
  "services": { "PPSA01547_00": "none(purchased)" }
}
```

另一个文件 `price-history.json`（同目录）：

```jsonc
{
  "HP0700-CUSA02957_00-NUNS4S0000000000": [
    { "d": "2026-11-04", "b": 79, "p": 39.5 }   // b=原价 p=折后价
  ]
}
```

---

## 二、可用接口

全部是索尼未公开接口。**任何一个都可能随时失效。**

### 1. OAuth 换令牌

```
GET https://ca.account.sony.com/api/authz/v3/oauth/authorize
  ?client_id=09515159-7237-4370-9b40-3806e67c0891
  &redirect_uri=com.scee.psxandroid.scecompcall://redirect
  &response_type=code&scope=psn:mobile.v2.core psn:clientapp
  &<其他参数>

POST https://ca.account.sony.com/api/authz/v3/oauth/token
Authorization: Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=
```

`npsso` 放在 Cookie 里，换取 code，再换 token。

### 2. 交易记录（唯一可用）

```
GET https://web.np.playstation.com/api/graphql/v1//op?operationName=transactionHistoryRetrieve
    &variables=…&extensions={"persistedQuery":{"version":1,"sha256Hash":"5b40f778…"}}
```

- 注意 **双斜杠** `v1//op`
- 鉴权用 **网页 Cookie**（`npsso` + `pdccws_p`），OAuth Bearer 会报
  `access token does not contain the required scope(s)`
- 分页：响应里 `hasMore` + `nextEndDate`

### 3. 商店实时价

```
GET https://web.np.playstation.com/api/graphql/v1/op?operationName=productRetrieveForCtasWithPrice
    &variables={"productId":"…"}
```

- **必须带** `Accept-Language: zh-Hans-HK`，否则按 GB/en 解析，直接 404
- 价格在 `webctas[].price`，要挑 `type === "ADD_TO_CART"` 的那个
  （已拥有的商品会有多个 CTA，其余返回 0 或「內含」）

### 4. 游戏来源

```
GET https://m.np.playstation.com/api/gamelist/v2/users/me/titles?limit=100&offset=0
```

每条带 `service` 字段：`none(purchased)` / `ps_plus` / `other`。这是区分「真购买 vs 会员领取」的**唯一可靠依据**。

### 5. 捆绑包内含清单

```
GET https://store.playstation.com/store/api/chihiro/00_09_000/container/HK/zh/999/<productId>
```

`long_desc` 里常有 `- 游戏名 PS4 & PS5` 形式的清单。
**但不可靠**：季票描述往往只写「支线剧情 / 服装」这类泛称。

---

## 三、商品归组规则

这是本项目最核心的逻辑，按优先级：

| 层级 | 依据 | 可靠度 |
|---|---|---|
| 1 | **商品 ID 命名空间**（前两段，如 `HP0700-CUSA02957_00`） | 高 |
| 2 | **交易时间邻近**（付费行后 ±150 秒内的 0 元行，且同命名空间） | 高但覆盖低 |
| 3 | 商品描述里的项目符号清单 | 低，**已弃用** |

命名空间示例：

```
HP0700-CUSA02957_00
  ├─ 火影忍者 疾风传 终极风暴4        （本体）
  ├─ NARUTO...STORM 4 Season Pass    （季票）
  ├─ 可操纵角色组合包「音之忍者四人组」  （组合包）
  └─ 追加故事组合包「我爱罗传」        （DLC）
```

同一命名空间内，**花费最高的本体**作为父节点，其余全部收进展开层。

---

## 四、前端结构

```
web/
├─ index.html      左栏系列导航 + 右栏详情 + 弹层
├─ app.js          原生 JS，无框架；SVG 图表手写
├─ styles.css      瑞士极简：纯白 / 黑 / 单一红 #e0301e，无圆角无阴影
└─ sw.js           Service Worker：导航走网络，静态资源 stale-while-revalidate
```

核心渲染函数：

- `renderOverview()` — KPI + 四张图
- `renderSeries()` — 树形列表，`childMap` 维护父子关系
- `productRow(p, family)` — 单行 + 展开层
- `openHistory(p)` — 价格历史弹层

改完前端记得升 `sw.js` 里的 `CACHE` 版本号，否则用户看到旧的。

---

## 五、开发流程

数据流水线（`tools/`，按顺序）：

```
build-taxonomy.mjs   # 系列归类 + 类型判定 + 解析包内清单
enrich-bundles.mjs   # 为包内子项补单独现价
fix-ids-covers.mjs   # 回填 productId + 封面
fill-free.mjs        # 免费游戏标记
sync-catalog.mjs     # 逐个查商店双价格
merge-catalog.mjs    # 合并进 data.json
reassign-series.mjs  # 按命名空间重新归属系列
build-grants.mjs     # 推断「随包附赠」
```

调试脚本（一次性）：`analyze-*.mjs`、`probe-*.mjs`、`check-*.mjs`、`cdp-*.mjs`（需要 Edge 调试端口 9222）。

---

## 六、实现要点

1. **名字不能用来匹配商品**
   商店名带语言后缀（`(泰语, 日语…)`）、版本后缀，搜索按热度不按相关度。
   只用 `productId` 命名空间做匹配；名字仅用于展示。

2. **`total` 字段单位是「分」**
   70800 = HK$708，别忘了除以 100。

3. **差值方向容易搞反**
   `d = 现价 − 买入价`，正数才是「省了」。

4. **已拥有商品的 CTA 有多个**
   挑 `ADD_TO_CART`，否则会拿到 0 或「內含」。

5. **Service Worker 会缓存旧前端**
   调试时先 `Ctrl+F5`，或直接注销 SW。

---

## 七、加新功能建议

- **新区域**：`psn.mjs` 里写死了 `HK/zh` 和 `zh-Hans-HK`，需要参数化
- **新图表**：`app.js` 里的 `svgEl()` + 手写 path，不引入图表库
- **新分类**：改 `index.mjs` 里的 `displayKind()`，同时更新前端的 `KIND_LABEL`

---

## 八、HTTP / HTTPS 两种运行方式

服务端默认 HTTP（`http://localhost:8787`）。当配置目录下存在证书时自动切到 HTTPS：

| 文件 | 说明 |
|---|---|
| `%APPDATA%\PLAYBILL\tls\playbill.pfx` | 服务端证书（含私钥） |
| `%APPDATA%\PLAYBILL\tls\pass.txt` | 上面这个 pfx 的口令 |
| `%APPDATA%\PLAYBILL\tls\playbill.cer` | 手机安装用（只有公钥） |

- 证书由 `tools/make-cert.ps1` 用 Windows 自带 `New-SelfSignedCertificate` 生成，SAN 覆盖 `localhost`、`127.0.0.1` 与当前所有内网 IPv4（含热点网关），换网络后重跑即可重签。
- 环境变量：`PLAYBILL_TLS_PFX` / `PLAYBILL_TLS_PASS` 可覆盖路径与口令；`PLAYBILL_DATA_DIR` 只影响数据文件，不影响证书位置。
- 手机要装成 PWA 必须走 HTTPS（iOS Safari 要求安全上下文）；普通浏览 HTTP 也能用。
- 若证书存在但加载失败（口令错、文件损坏），服务端会打印警告并回退 HTTP，不会启动失败。
