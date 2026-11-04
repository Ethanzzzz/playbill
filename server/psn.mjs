// psn.mjs — 与 Sony PlayStation Network 私有接口交互的连接层。
//
// 说明：
//  - 认证流程（npsso -> access code -> tokens）来自开源库 psn-api 的实现，已验证可用。
//  - “已购买游戏列表”使用 Sony 网页端 GraphQL persisted query（psn-api 同款 hash）。
//  - “交易流水 / 购入价”与“商店现价”属于未公开接口，不同账号/区域/时间可能变化，
//    因此这里做成“候选端点探测 + 失败降级”，不会因为某个端点失效导致整个应用不可用。

const OAUTH = "https://ca.account.sony.com/api/authz/v3/oauth";
const BASIC_AUTH =
  "MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=";
const REDIRECT_URI = "com.scee.psxandroid.scecompcall://redirect";
const CLIENT_ID = "09515159-7237-4370-9b40-3806e67c0891";
const SCOPE = "psn:mobile.v2.core psn:clientapp";

const GQL = "https://web.np.playstation.com/api/graphql/v1/op";
const HASH_PURCHASED_GAMES =
  "827a423f6a8ddca4107ac01395af2ec0eafd8396fc7fa204aaf9b7ed2eefa168";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 带超时的 fetch */
async function req(url, { method = "GET", headers = {}, body, timeout = 25000, redirect = "follow" } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    return await fetch(url, {
      method,
      headers: { "User-Agent": UA, ...headers },
      body,
      signal: ac.signal,
      redirect,
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractCode(location) {
  if (!location) return null;
  try {
    const u = new URL(location);
    const c = u.searchParams.get("code");
    if (c) return c;
  } catch {
    /* not a standard URL, fall through */
  }
  const m = /[?&#]code=([^&]+)/.exec(location);
  return m ? decodeURIComponent(m[1]) : null;
}

function authError(msg) {
  const e = new Error(msg);
  e.code = "AUTH";
  return e;
}

/**
 * 第一步：npsso -> access code
 * npsso 获取方式：浏览器登录 https://www.playstation.com/ 后，
 * 同浏览器打开 https://ca.account.sony.com/api/v1/ssocookie ，得到 {"npsso":"..."}
 */
export async function npssoToCode(npsso) {
  const qs = new URLSearchParams({
    access_type: "offline",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
  });
  const url = `${OAUTH}/authorize?${qs.toString()}`;
  let res;
  try {
    res = await req(url, {
      headers: { Cookie: `npsso=${npsso}` },
      redirect: "manual",
      timeout: 25000,
    });
  } catch (e) {
    throw authError(
      `无法连接索尼登录服务器（${e.message}）。如果你在中国大陆，通常需要代理/VPN 才能访问 api.playstation.com 与 ca.account.sony.com。`,
    );
  }
  const location = res.headers.get("location");
  const code = extractCode(location);
  if (!code) {
    throw authError(
      "npsso 无效或已过期，未能换到授权码。请重新登录 PlayStation 官网后，再打开 https://ca.account.sony.com/api/v1/ssocookie 复制新的 npsso。",
    );
  }
  return code;
}

/** 第二步：access code -> access/refresh token */
export async function codeToTokens(code) {
  const res = await req(`${OAUTH}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${BASIC_AUTH}`,
    },
    body: new URLSearchParams({
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
      token_format: "jwt",
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    throw authError(
      `换取令牌失败：${data.error_description || data.error || res.status}`,
    );
  }
  return normalizeTokens(data);
}

/** 用 refresh token 续期 */
export async function refreshTokens(refreshToken) {
  const res = await req(`${OAUTH}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${BASIC_AUTH}`,
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      token_format: "jwt",
      scope: SCOPE,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    throw authError("令牌已失效，请重新登录（粘贴新的 npsso）。");
  }
  return normalizeTokens(data);
}

function normalizeTokens(d) {
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresIn: d.expires_in,
    refreshTokenExpiresIn: d.refresh_token_expires_in,
    tokenType: d.token_type,
    scope: d.scope,
    obtainedAt: Date.now(),
  };
}

/** 统一的带 Bearer 的调用 */
async function callAuthed(url, accessToken, { method = "GET", body, headers = {}, timeout = 25000 } = {}) {
  return req(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
    timeout,
  });
}

/**
 * 拉取“已购买游戏列表”（Sony 网页 GraphQL persisted query）。
 * 分页直到取完。
 */
export async function fetchPurchasedGames(accessToken, { pageSize = 50, maxPages = 40 } = {}) {
  const all = [];
  let start = 0;
  let seen = 0;

  for (let page = 0; page < maxPages; page++) {
    const u = new URL(GQL);
    u.searchParams.set("operationName", "getPurchasedGameList");
    u.searchParams.set(
      "variables",
      JSON.stringify({
        isActive: true,
        platform: ["ps4", "ps5"],
        size: pageSize,
        start,
        sortBy: "ACTIVE_DATE",
        sortDirection: "desc",
      }),
    );
    u.searchParams.set(
      "extensions",
      JSON.stringify({ persistedQuery: { version: 1, sha256Hash: HASH_PURCHASED_GAMES } }),
    );

    const res = await callAuthed(u.toString(), accessToken);
    const data = await res.json().catch(() => ({}));
    const games = data?.data?.purchasedTitlesRetrieve?.games;
    if (!Array.isArray(games)) {
      const msg = data?.errors?.[0]?.message || `HTTP ${res.status}`;
      throw new Error(`获取已购买游戏失败：${msg}`);
    }
    if (games.length === 0) break;

    all.push(...games);
    seen += games.length;
    if (games.length < pageSize) break;
    start += pageSize;
  }

  return all;
}

/**
 * 交易流水（含购入价）。
 * 索尼没有公开文档，这里探测若干社区已知的候选端点；返回第一个“看起来像交易数据”的结果。
 * 全部失败时返回 { ok:false }，调用方降级到手动/导入。
 */
export async function fetchTransactions(accessToken) {
  const candidates = [
    {
      name: "web.transactions.v1",
      url: (offset) =>
        `https://web.np.playstation.com/api/v1/users/me/transactions?limit=100&offset=${offset}`,
    },
    {
      name: "m.gwlb.transactions.v1",
      url: (offset) =>
        `https://m.np.playstation.com/api/gwlb/v1/users/me/transactions?limit=100&offset=${offset}`,
    },
    {
      name: "web.transactions.all",
      url: (offset) =>
        `https://web.np.playstation.com/api/v1/users/me/transactions?limit=100&offset=${offset}&transactionType=ALL`,
    },
  ];

  const attempts = [];
  for (const c of candidates) {
    try {
      const res = await callAuthed(c.url(0), accessToken, { timeout: 20000 });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        /* non-json */
      }
      const items = pickTransactionArray(data);
      attempts.push({ endpoint: c.name, status: res.status, ok: Boolean(items) });
      if (items && items.length) {
        return { ok: true, endpoint: c.name, items, attempts };
      }
    } catch (e) {
      attempts.push({ endpoint: c.name, status: "ERR", ok: false, error: String(e.message || e) });
    }
  }
  return { ok: false, items: [], attempts };
}

function pickTransactionArray(data) {
  if (!data) return null;
  if (Array.isArray(data)) return data;
  for (const key of ["transactions", "items", "data", "results", "transactionList"]) {
    const v = data[key];
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.items)) return v.items;
    if (v && Array.isArray(v.transactions)) return v.transactions;
  }
  return null;
}

/**
 * 商店现价（公开店铺接口，非账号接口）。
 * 失败返回 null，前端可用手动价格。
 */
export async function fetchStorePrice(productId, country = "HK", lang = "zh") {
  if (!productId) return null;
  const url = `https://store.playstation.com/store/api/chihiro/00_09_000/container/${country}/${lang}/999/${encodeURIComponent(
    productId,
  )}`;
  try {
    const res = await req(url, { timeout: 15000 });
    if (!res.ok) return null;
    const d = await res.json().catch(() => null);
    if (!d) return null;

    // 实测结构：price 在 default_sku.price（整数，单位=分），展示串在 display_price
    const sku = d.default_sku;
    const display = sku?.display_price || null;
    let cents = num(sku?.price);

    // 兜底：从展示串 "HK$158.00" 里解析数字
    if (cents == null && display) {
      const m = /([\d,]+(?:\.\d+)?)/.exec(display);
      if (m) cents = Math.round(Number(m[1].replaceAll(",", "")) * 100);
    }
    if (cents == null) return null;

    // 免费/未定价
    if (display && /free/i.test(display)) {
      return { currency: guessCurrency(display, country), amount: 0, baseAmount: 0, discounted: false, display };
    }

    return {
      currency: guessCurrency(display, country),
      amount: cents / 100,
      baseAmount: cents / 100,
      discounted: false,
      display,
    };
  } catch {
    return null;
  }
}

function guessCurrency(display, country) {
  if (display) {
    if (display.includes("HK$")) return "HKD";
    if (display.includes("NT$")) return "TWD";
    if (display.includes("US$") || display.startsWith("$")) return "USD";
    if (display.includes("€")) return "EUR";
    if (display.includes("£")) return "GBP";
    if (display.includes("¥")) return "JPY";
  }
  const map = { HK: "HKD", TW: "TWD", US: "USD", JP: "JPY", GB: "GBP", DE: "EUR", FR: "EUR" };
  return map[country] || null;
}

/**
 * 按名称在商店里搜索，取最匹配的商品的现价。
 * 用途：手动添加 / CSV 导入的游戏没有 productId，也能拿到现价。
 * 返回 { name, productId, amount, display, score, currency }
 */
export async function searchStorePrice(query, country = "HK", lang = "zh") {
  if (!query) return null;
  const url = `https://store.playstation.com/store/api/chihiro/00_09_000/search/${country}/${lang}/999/${encodeURIComponent(
    query,
  )}`;
  let res;
  try {
    res = await req(url, { timeout: 15000 });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const links = data?.links;
  if (!Array.isArray(links) || links.length === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const l of links) {
    const sku = l.default_sku;
    if (!sku) continue;

    // 只要“完整游戏”，排除 DLC / 头像 / 点数 / 会员等
    if (l.top_category && l.top_category !== "downloadable_game") continue;

    const name = l.name || l.title_name || "";
    const score = matchScore(query, name);
    if (score <= 0) continue;

    const cents = Number(sku.price);
    // 只接受有正价的结果；0 元大多是试玩/免费版，价格不可比
    if (!Number.isFinite(cents) || cents <= 0) continue;

    if (score > bestScore) {
      bestScore = score;
      best = { link: l, cents, score };
    }
  }

  // 阈值收紧到 0.95：只接受“近乎完全一致”的匹配，避免张冠李戴
  if (!best || best.score < 0.95) return null;

  return {
    name: best.link.name,
    productId: best.link.id || null,
    amount: best.cents / 100,
    display: best.link.default_sku.display_price || null,
    currency: guessCurrency(best.link.default_sku.display_price || "", country),
    score: Number(best.score.toFixed(3)),
  };
}

const STOP_WORDS = new Set([
  "the", "of", "a", "an", "and", "edition", "game", "deluxe", "standard", "complete",
  "ps4", "ps5", "remastered", "remake",
  "版", "套装", "普通版", "制品版", "数位", "标准版", "中文版", "豪华版",
]);

function normalizeText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // 去掉变音符号：Ragnarök -> Ragnarok
    .toLowerCase()
    .replace(/[®™©:：\-–—.,!?'"()（）\[\]【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  return normalizeText(s)
    .split(" ")
    .map((w) => w.trim())
    .filter((w) => w && !STOP_WORDS.has(w));
}

/**
 * 严格匹配：查询词必须全部出现在候选名里；越接近（多余词越少）分越高。
 * 宁可返回 0（未知）也不返回张冠李戴的价格。
 */
function matchScore(query, candidate) {
  const q = normalizeText(query);
  const c = normalizeText(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;

  const qt = tokenize(query);
  const ct = tokenize(candidate);
  if (!qt.length || !ct.length) return 0;

  // 中文等无空格语言：退化为包含判断
  if (qt.length === 1 && c.includes(q)) return 0.8;

  const setC = new Set(ct);
  const allIn = qt.every((t) => setC.has(t));
  if (!allIn) return 0;

  return 0.7 + 0.3 * (qt.length / Math.max(ct.length, qt.length));
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 网络连通性自检：判断本机能否访问索尼相关域名 */
export async function netCheck() {
  const targets = [
    { name: "ca.account.sony.com", url: "https://ca.account.sony.com/" },
    { name: "web.np.playstation.com", url: "https://web.np.playstation.com/" },
    { name: "store.playstation.com", url: "https://store.playstation.com/" },
  ];
  const out = [];
  for (const t of targets) {
    const started = Date.now();
    try {
      const res = await req(t.url, { timeout: 8000 });
      out.push({ target: t.name, ok: true, status: res.status, ms: Date.now() - started });
    } catch (e) {
      out.push({ target: t.name, ok: false, ms: Date.now() - started, error: String(e.message || e) });
    }
  }
  return out;
}

// ============ 交易记录（transactionHistoryRetrieve）============
// 该操作位于 web.np.playstation.com 的 GraphQL，鉴权用的是“网页会话 Cookie”
// （npsso + pdccws_p），不是 OAuth Bearer —— 实测前者可用、后者会报缺 scope。
const TX_HASH = "5b40f778091eb1c8e47adbfffb6a72bcee9b5fd1deb33e3ea5373989ca89773c";
const TX_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "x-psn-storefront-type": "checkout:store",
  "X-PSN-App-Ver": "@sie-ppr-web-checkout/app/v2.186.2-hotfix.2",
  "apollographql-client-name": "@sie-ppr-web-checkout/app",
  "apollographql-client-version": "2.186.2-hotfix.2",
  Referer: "https://checkout.playstation.com/",
  Origin: "https://checkout.playstation.com",
};

function txUrl(startDate, endDate, limit) {
  const variables = JSON.stringify({ startDate, endDate, limit });
  const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: TX_HASH } });
  return (
    "https://web.np.playstation.com/api/graphql/v1//op?operationName=transactionHistoryRetrieve" +
    `&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`
  );
}

/**
 * 拉取全部交易记录（自动翻页）。
 * cookies: { npsso, pdccws_p }
 */
export async function fetchTransactionHistory(cookies, { limit = 50, maxPages = 100 } = {}) {
  const cookieHeader = Object.entries(cookies || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (!cookieHeader) throw new Error("缺少网页会话 Cookie");

  const startDate = "2013-11-01T00:00:00.000Z";
  let endDate = new Date().toISOString().slice(0, 10) + "T23:59:59.999Z";
  const all = [];

  for (let page = 0; page < maxPages; page++) {
    const url = txUrl(startDate, endDate, limit);
    const res = await req(url, {
      headers: { ...TX_HEADERS, Cookie: cookieHeader },
      timeout: 30000,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`交易接口返回非 JSON（HTTP ${res.status}）`);
    }
    const node = data?.data?.transactionHistoryRetrieve;
    if (!node) {
      const msg = data?.errors?.[0]?.message || `HTTP ${res.status}`;
      throw new Error(`获取交易记录失败：${msg}`);
    }
    const txs = node.transactions || [];
    all.push(...txs);
    if (!node.hasMore || !node.nextEndDate || txs.length === 0) break;
    endDate = node.nextEndDate;
    await new Promise((r) => setTimeout(r, 500));
  }
  return all;
}

/** 从交易里提取“真正花钱”的商品行，金额换算为元 */
export function extractPaidPurchases(transactions) {
  const out = [];
  for (const t of transactions || []) {
    if (t.invoiceType !== "PRODUCT_PURCHASE") continue;
    const date = (t.date || "").slice(0, 10);
    for (const p of t.purchaseDetails?.productPurchases || []) {
      const cents = Number(p.total ?? 0);
      if (!(cents > 0)) continue;
      out.push({
        date,
        name: p.productName || p.skuId || "未知",
        price: Math.round(cents) / 100,
        skuId: p.skuId || null,
        transactionId: t.id || null,
      });
    }
  }
  return out;
}

// ============ 商店实时价（原价 + 折后价）============
// 用于每日价格快照。必须带 Accept-Language，否则服务端按 GB/en 解析直接 404。
const CTA_HASH = "911a43f47dbbf7b2f3d513d6237dedfd679e57af3f34787667a22ecad6a249cd";

export async function fetchCtaPrice(productId, cookies = {}) {
  if (!productId) return null;
  const cookieHeader = Object.entries(cookies)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const variables = JSON.stringify({ productId });
  const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: CTA_HASH } });
  const url =
    "https://web.np.playstation.com/api/graphql/v1/op?operationName=productRetrieveForCtasWithPrice" +
    `&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`;

  let res;
  try {
    res = await req(url, {
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-psn-storefront-type": "web",
        "Accept-Language": "zh-Hans-HK,zh;q=0.9",
        "X-PSN-App-Ver": "@sie-ppr-web-checkout/app/v2.186.2-hotfix.2",
        "apollographql-client-name": "@sie-ppr-web-checkout/app",
        "apollographql-client-version": "2.186.2-hotfix.2",
        Referer: "https://store.playstation.com/",
        Origin: "https://store.playstation.com",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      timeout: 20000,
    });
  } catch {
    return null;
  }
  const data = await res.json().catch(() => null);
  const prod = data?.data?.productRetrieve;
  if (!prod) return null;

  const ctas = prod.webctas || [];
  const cta =
    ctas.find((x) => x.type === "ADD_TO_CART" && x.price) ||
    ctas.find((x) => x.price && (x.price.discountedValue > 0 || x.price.basePriceValue > 0)) ||
    ctas.find((x) => x.price);
  const pr = cta?.price;
  if (!pr) return null;

  const base = Number(pr.basePriceValue);
  const disc = Number(pr.discountedValue);
  if (!Number.isFinite(base) && !Number.isFinite(disc)) return null;

  return {
    productId: prod.id,
    name: prod.name,
    currency: pr.currencyCode || "HKD",
    base: Number.isFinite(base) ? base / 100 : null,
    price: Number.isFinite(disc) ? disc / 100 : null,
    isFree: Boolean(pr.isFree),
  };
}
