// index.mjs — 本地服务端：托管 PWA 前端 + 提供 PSN 数据 API。
// 设计原则：令牌与全部数据只保存在本机 data.json，不向任何第三方上传。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import * as psn from "./psn.mjs";
import { csvToTransactions } from "./csv.mjs";
import { rebuildCatalog, rebuildSeries } from "./catalog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 数据目录：放在用户配置目录，而不是程序文件夹里。
// 这样换版本 / 删掉程序文件夹，账号和购买记录都还在。
// 可用环境变量 PSN_DATA_DIR 覆盖。
function resolveDataDir() {
  if (process.env.PSN_DATA_DIR) return process.env.PSN_DATA_DIR;
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : path.join(os.homedir(), ".config");
  return path.join(base, "PSNArchive");
}

let DATA_DIR = resolveDataDir();
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  // 极端情况下（权限/只读盘）回退到程序目录，保证能启动
  console.log("  ⚠ 无法使用用户数据目录，回退到程序目录：" + e.message);
  DATA_DIR = __dirname;
}
const DATA_FILE = path.join(DATA_DIR, "data.json");
const HISTORY_FILE = path.join(DATA_DIR, "price-history.json");

// 老版本把数据放在 server/ 下，首次启动时迁移过来
(function migrateLegacyData() {
  try {
    const legacyData = path.join(__dirname, "data.json");
    const legacyHist = path.join(__dirname, "price-history.json");
    if (!fs.existsSync(DATA_FILE) && fs.existsSync(legacyData)) {
      fs.copyFileSync(legacyData, DATA_FILE);
      console.log("  已迁移旧数据：" + legacyData);
    }
    if (!fs.existsSync(HISTORY_FILE) && fs.existsSync(legacyHist)) {
      fs.copyFileSync(legacyHist, HISTORY_FILE);
    }
  } catch (e) {
    console.log("  旧数据迁移失败（可忽略）：" + e.message);
  }
})();

const WEB_DIR = path.join(__dirname, "..", "web");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

const DEFAULT_SETTINGS = {
  currency: "HKD",
  country: "HK",
  lang: "zh",
  autoPrices: true,
};

// ---------------- 数据存取 ----------------
function emptyState() {
  return {
    tokens: null,
    settings: { ...DEFAULT_SETTINGS },
    games: [],
    lastSync: null,
    lastSyncNote: null,
    lastTxAttempts: null,
    webCookies: null,
    lastTxSync: null,
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const s = JSON.parse(raw);
    return { ...emptyState(), ...s, settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) } };
  } catch {
    return emptyState();
  }
}

function saveState(state) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

// ---------------- 工具 ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function tokenExpired(tokens) {
  if (!tokens) return true;
  const expiresAt = (tokens.obtainedAt || 0) + (tokens.expiresIn || 0) * 1000;
  return Date.now() > expiresAt - 60_000;
}

// 从 id_token（JWT）里尽力解析账号地区，用于自动选择商店地区/语言/币种
function decodeJwtPayload(token) {
  if (!token) return null;
  const part = String(token).split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

const REGION_PRESET = {
  HK: { currency: "HKD", lang: "zh" },
  TW: { currency: "TWD", lang: "zh" },
  US: { currency: "USD", lang: "en" },
  JP: { currency: "JPY", lang: "ja" },
  GB: { currency: "GBP", lang: "en" },
  DE: { currency: "EUR", lang: "de" },
  FR: { currency: "EUR", lang: "fr" },
  CA: { currency: "CAD", lang: "en" },
  AU: { currency: "AUD", lang: "en" },
  SG: { currency: "SGD", lang: "en" },
  KR: { currency: "KRW", lang: "ko" },
};

function applyRegionFromToken(state, idToken) {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return;
  const cc = String(payload.country || payload.region || payload.ctry || "").toUpperCase();
  const preset = REGION_PRESET[cc];
  if (preset) {
    state.settings.country = cc;
    state.settings.currency = preset.currency;
    state.settings.lang = preset.lang;
  }
}

async function ensureAccessToken(state) {
  if (!state.tokens) throw Object.assign(new Error("尚未登录"), { code: "NO_TOKEN" });
  if (!tokenExpired(state.tokens)) return state.tokens.accessToken;
  if (!state.tokens.refreshToken) throw Object.assign(new Error("令牌已过期，请重新登录"), { code: "NO_TOKEN" });
  const t = await psn.refreshTokens(state.tokens.refreshToken);
  state.tokens = { ...state.tokens, ...t };
  saveState(state);
  return state.tokens.accessToken;
}

function idOf(g) {
  return g.titleId || g.productId || g.entitlementId || g.name;
}

function normalizePurchased(g, prev) {
  const id = idOf(g);
  return {
    id,
    titleId: g.titleId || null,
    productId: g.productId || null,
    conceptId: g.conceptId || null,
    name: g.name || g.titleId || "未知游戏",
    platform: g.platform || null,
    cover: (g.image && g.image.url) || null,
    isPreOrder: Boolean(g.isPreOrder),
    membership: g.membership || null,
    // 用户可编辑 / 自动获取的字段，重同步时保留已有值
    purchasePrice: prev?.purchasePrice ?? null,
    purchaseDate: prev?.purchaseDate ?? null,
    currentPrice: prev?.currentPrice ?? null,
    currentPriceAt: prev?.currentPriceAt ?? null,
    priceSource: prev?.priceSource || null,
    note: prev?.note || "",
    owned: true,
  };
}

// ---------------- 交易流水解析（宽松匹配） ----------------
function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return v.name || v.title || v.titleName || v.text || "";
  return "";
}

function amountOf(o) {
  const cands = [
    o.amount,
    o.price,
    o.totalAmount,
    o.amountValue,
    o.transactionAmount,
    o.paidAmount,
    o.chargeAmount,
    o.value,
  ];
  for (const c of cands) {
    if (c == null) continue;
    if (typeof c === "number") return c;
    if (typeof c === "object") {
      const n = c.value ?? c.amount ?? c.amountValue;
      if (n != null && Number.isFinite(Number(n))) return Number(n);
    }
    if (Number.isFinite(Number(c))) return Number(c);
  }
  return null;
}

function dateOf(o) {
  const cands = [o.date, o.transactionDate, o.createdAt, o.createdDate, o.purchaseDate, o.timestamp];
  for (const c of cands) {
    if (!c) continue;
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function mergeTransactions(state, items) {
  let matched = 0;
  const games = state.games;
  for (const item of items) {
    const name = textOf(item);
    if (!name) continue;
    const amount = amountOf(item);
    const date = dateOf(item);
    if (amount == null && !date) continue;
    const key = name.toLowerCase().replace(/[®™©]/g, "").trim();
    const found = games.find((g) => {
      const gn = (g.name || "").toLowerCase().replace(/[®™©]/g, "").trim();
      return gn && (gn === key || gn.includes(key) || key.includes(gn));
    });
    if (!found) continue;
    if (amount != null && found.purchasePrice == null) {
      found.purchasePrice = Math.abs(amount) > 1000 ? Math.abs(amount) / 100 : Math.abs(amount);
      found.priceSource = found.priceSource || "transaction";
    }
    if (date && !found.purchaseDate) found.purchaseDate = date;
    matched++;
  }
  return matched;
}

// ---------------- CSV 导入合并 ----------------
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[®™©:：\-–—_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeCsvTransactions(state, transactions) {
  let matched = 0;
  let created = 0;
  for (const t of transactions) {
    const key = normName(t.name);
    if (!key) continue;
    const found = state.games.find((g) => {
      const gn = normName(g.name);
      return gn && (gn === key || gn.includes(key) || key.includes(gn));
    });
    if (found) {
      // 演示数据不是真实数据，应允许被导入值覆盖；真实来源则只补空、不覆盖
      const overwrite = found.priceSource === "demo" || found.priceSource == null;
      if (t.price != null && (found.purchasePrice == null || overwrite)) found.purchasePrice = t.price;
      if (t.date && (!found.purchaseDate || overwrite)) found.purchaseDate = t.date;
      if (!found.priceSource || found.priceSource === "demo") found.priceSource = "csv";
      matched++;
    } else {
      state.games.push({
        id: "csv:" + key,
        titleId: null,
        productId: null,
        conceptId: null,
        name: t.name,
        platform: t.platform || null,
        cover: null,
        purchasePrice: t.price ?? null,
        purchaseDate: t.date || null,
        currentPrice: null,
        currentPriceAt: null,
        priceSource: "csv",
        note: "",
        owned: true,
      });
      created++;
    }
  }
  return { matched, created };
}

// ---------------- 交易记录合并 ----------------
function normNameTx(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[®™©:：\-–—.,'"()（）\[\]【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mergePaidPurchases(state, paid) {
  const byName = new Map();
  for (const p of paid) {
    const k = normNameTx(p.name) || "unknown";
    const e = byName.get(k) || { name: p.name, total: 0, date: p.date, count: 0 };
    e.total += p.price;
    e.count++;
    if (p.date < e.date) e.date = p.date;
    byName.set(k, e);
  }

  const accByGame = new Map();
  let matched = 0;
  let created = 0;

  for (const [k, p] of byName) {
    let g = state.games.find((x) => normNameTx(x.name) === k);
    if (!g) {
      g = state.games.find((x) => {
        const gn = normNameTx(x.name);
        return gn && (gn.includes(k) || k.includes(gn)) && Math.abs(gn.length - k.length) <= 12;
      });
    }
    if (!g) {
      g = {
        id: "tx:" + k,
        titleId: null,
        productId: null,
        conceptId: null,
        name: p.name,
        platform: null,
        cover: null,
        purchasePrice: null,
        purchaseDate: null,
        currentPrice: null,
        currentPriceAt: null,
        priceSource: "transaction",
        note: "",
        owned: true,
      };
      state.games.push(g);
      created++;
    } else {
      matched++;
    }
    const acc = accByGame.get(g.id) || { total: 0, date: p.date, count: 0 };
    acc.total += p.total;
    acc.count += p.count;
    if (p.date < acc.date) acc.date = p.date;
    accByGame.set(g.id, acc);
  }

  for (const g of state.games) {
    const acc = accByGame.get(g.id);
    if (!acc) continue;
    g.purchasePrice = Number(acc.total.toFixed(2));
    g.purchaseDate = acc.date;
    g.priceSource = "transaction";
    if (acc.count > 1) g.note = `合并 ${acc.count} 笔`;
  }

  return { matched, created, applied: accByGame.size };
}

// ---------------- 演示数据 ----------------
function demoGames() {
  const samples = [
    ["PPSA01234_00", "God of War Ragnarök", "PS5", 468, "2023-03-15", 568],
    ["CUSA07820_00", "Ghost of Tsushima", "PS4", 398, "2022-11-02", 468],
    ["PPSA01999_00", "Spider-Man 2", "PS5", 568, "2024-01-10", 508],
    ["CUSA10212_00", "Elden Ring", "PS4", 398, "2022-03-01", 468],
    ["PPSA03000_00", "Returnal", "PS5", 298, "2023-06-20", 398],
    ["CUSA14112_00", "Hollow Knight", "PS4", 78, "2021-09-09", 78],
    ["PPSA01555_00", "Horizon Forbidden West", "PS5", 468, "2023-02-18", 398],
    ["CUSA08829_00", "The Last of Us Part II", "PS4", 398, "2022-01-05", 308],
    ["PPSA02020_00", "Resident Evil 4", "PS5", 398, "2024-04-12", 468],
    ["CUSA12345_00", "Red Dead Redemption 2", "PS4", 398, "2021-12-25", 308],
    ["PPSA04545_00", "Baldur's Gate 3", "PS5", 468, "2024-02-14", 468],
    ["CUSA22222_00", "Stardew Valley", "PS4", 108, "2020-07-01", 78],
  ];
  return samples.map(([tid, name, platform, pp, pd, cp], i) => ({
    id: tid,
    titleId: tid,
    productId: tid,
    conceptId: null,
    name,
    platform,
    cover: null,
    purchasePrice: pp,
    purchaseDate: pd,
    currentPrice: cp,
    currentPriceAt: new Date().toISOString().slice(0, 10),
    priceSource: "demo",
    note: "",
    owned: true,
  }));
}

// ---------------- 业务处理 ----------------
async function handleSync(state, body) {
  if (body.mode === "demo") {
    state.games = demoGames();
    state.lastSync = new Date().toISOString();
    state.lastSyncNote = "演示数据";
    saveState(state);
    return { mode: "demo", count: state.games.length };
  }

  const accessToken = await ensureAccessToken(state);
  const purchased = await psn.fetchPurchasedGames(accessToken);
  const prevById = new Map(state.games.map((g) => [g.id, g]));
  const merged = purchased.map((g) => normalizePurchased(g, prevById.get(idOf(g))));
  // 保留演示/手动添加但不在账号库里的条目
  for (const old of state.games) {
    if (!merged.find((m) => m.id === old.id)) merged.push(old);
  }
  state.games = merged;

  // 尝试交易流水
  let tx = { ok: false, items: [], attempts: [] };
  try {
    tx = await psn.fetchTransactions(accessToken);
    if (tx.ok) state.games = state.games; // no-op for clarity
  } catch (e) {
    tx = { ok: false, items: [], attempts: [], error: String(e.message || e) };
  }
  let matched = 0;
  if (tx.ok && tx.items.length) matched = mergeTransactions(state, tx.items);
  state.lastTxAttempts = tx.attempts || [];
  if (tx.error) state.lastTxAttempts.push({ endpoint: "internal", status: "ERR", ok: false, error: tx.error });

  // 现价（可选，较慢）
  let priced = 0;
  if (body.withPrices) {
    const targets = state.games.filter((g) => !g.currentPrice || body.forcePrices).slice(0, 60);
    const queues = [];
    const worker = async (g) => {
      const p = await psn.fetchStorePrice(g.productId || g.titleId, state.settings.country, state.settings.lang);
      if (p && p.amount != null) {
        g.currentPrice = p.amount;
        g.currentPriceAt = new Date().toISOString().slice(0, 10);
        g.priceSource = p.discounted ? "store-discount" : "store";
        priced++;
      }
    };
    for (let i = 0; i < targets.length; i += 4) {
      queues.push(Promise.all(targets.slice(i, i + 4).map(worker)));
    }
    for (const q of queues) await q;
  }

  state.lastSync = new Date().toISOString();
  state.lastSyncNote = `账号游戏 ${purchased.length} 个；交易流水匹配 ${matched} 条；现价更新 ${priced} 个`;
  saveState(state);
  return {
    mode: "live",
    count: state.games.length,
    purchased: purchased.length,
    transactions: { ok: tx.ok, matched, attempts: tx.attempts },
    priced,
  };
}

// ---------------- 价格历史快照 ----------------
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveHistory(h) {
  const tmp = HISTORY_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(h), "utf8");
  fs.renameSync(tmp, HISTORY_FILE);
}

/**
 * 抓取当前商店价并记录当天快照。
 * 每个 productId 每天只记一条（幂等）。
 */
async function snapshotPrices(state) {
  const history = loadHistory();
  const today = new Date().toISOString().slice(0, 10);
  const entries = (state.catalog || []).filter((c) => c.productId);
  const byPid = new Map(entries.map((c) => [c.productId, c]));
  const gameByPid = new Map();
  for (const g of state.games || []) {
    if (g.productId) gameByPid.set(g.productId, g);
  }
  const ids = [...byPid.keys()];

  let added = 0;
  let skipped = 0;
  let failed = 0;
  const queue = [...ids];

  async function worker() {
    while (queue.length) {
      const pid = queue.shift();
      if (!pid) break;
      const arr = history[pid] || (history[pid] = []);
      const already = arr.some((x) => x.d === today);
      // 今天已记录且有封面 → 直接跳过，避免重复同步时反复请求
      if (already && byPid.get(pid)?.image) {
        skipped++;
        continue;
      }
      try {
        const p = await psn.fetchCtaPrice(pid, state.webCookies || {});
        if (p && (p.price != null || p.base != null)) {
          // 同步刷新目录里的当前价，保证列表与历史一致
          const c = byPid.get(pid);
          if (c) {
            c.store = c.store || {};
            c.store.price = {
              currency: p.currency,
              basePrice: p.base,
              discountedPrice: p.price,
              discountText:
                p.base && p.price && p.price < p.base ? `-${Math.round((1 - p.price / p.base) * 100)}%` : null,
              isFree: p.isFree,
            };
            c.store.checkedAt = today;
          }
          // 同步到游戏库，总览的「当前价值 / 累计省下」用的是这里
          const g = gameByPid.get(pid);
          if (g) {
            if (p.price != null) g.currentPrice = p.price;
            if (p.base != null) g.currentBasePrice = p.base;
            g.currentPriceAt = today;
            g.priceSource = "store-gql";
          }
          // 缺封面的，顺手从商店容器补一张
          if (c && !c.image) {
            const img = await psn.fetchStoreImage(pid).catch(() => null);
            if (img) {
              c.image = img;
              if (g && !g.cover) g.cover = img;
            }
          }
          if (already) {
            skipped++;
          } else {
            arr.push({ d: today, b: p.base, p: p.price });
            added++;
          }
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  rebuildSeries(state); // 把新补的封面/现价同步到 series
  saveHistory(history);
  saveState(state);
  return { date: today, total: ids.length, added, skipped, failed };
}

// ---------------- 路由 ----------------
async function handleApi(req, res, url) {
  const state = loadState();
  const p = url.pathname;
  const method = req.method || "GET";

  if (p === "/api/state" && method === "GET") {
    const catalog = (state.catalog || []).map((c) => ({
      name: c.name,      category: c.category,
      kind: c.kind || null,
      series: c.series || null,
      family: c.productId ? String(c.productId).split("-").slice(0, 2).join("-") : null,
      productId: c.productId || null,
      grantedBy: c.grantedBy || null,
      grantedByName: c.grantedByName || null,
      image: c.image || null,
      totalSpent: c.totalSpent || 0,
      purchases: (c.purchases || []).map((x) => ({ date: x.date, price: x.price })),
      basePrice: c.store?.price?.basePrice ?? null,
      discountedPrice: c.store?.price?.discountedPrice ?? null,
    }));
    const svcByPid = new Map(
      (state.catalog || []).filter((c) => c.productId).map((c) => [c.productId, c.service || null]),
    );
    const catByPid = new Map(
      (state.catalog || []).filter((c) => c.productId).map((c) => [c.productId, c]),
    );
    const series = (state.series || []).map((s) => ({
      key: s.key,
      label: s.label,
      totalSpent: s.totalSpent || 0,
      products: (s.products || []).map((p) => {
        // 细分类：把 App / 头像 / 试玩 / 升级 / 凭证 归到「其他」，
        // 以及「没花钱又查不到价」的条目（升级、领取、测试）
        const name = p.name || "";
        let kind = p.kind;
        if (kind !== "subscription" && kind !== "wallet") {
          if (/(netflix|youtube|spotify|twitch|disney\+|apple music|bilibili|iqiyi|prime video|crunchyroll)/i.test(name)) kind = "system";
          else if (/(avatar|头像|虚拟形象|主题|theme)/i.test(name)) kind = "avatar";
          else if (/(demo|试玩|beta|公开测试|server slam|tech test|stress test|trial|测试)/i.test(name)) kind = "demo";
          else if (/(光盘升级|实体盘升级|PS4™ 到 PS5™|到 PS5™|upgrade)/i.test(name)) kind = "upgrade";
          else if (/特典|bonus|凭证/i.test(name)) kind = "voucher";
        }
        const hasPrice = p.currentPrice != null && p.currentPrice > 0;
        const isOther =
          ["system", "avatar", "demo", "upgrade", "voucher"].includes(kind) ||
          (!hasPrice && Number(p.spent || 0) === 0);

        return {
          name: p.name,
          kind,
          bucket: isOther ? "other" : "game",
          service: p.productId ? p.service ?? svcByPid.get(p.productId) ?? null : p.service ?? null,
          family: p.productId ? String(p.productId).split("-").slice(0, 2).join("-") : null,
          grantedBy: p.productId ? catByPid.get(p.productId)?.grantedBy ?? null : null,
          grantedByName: p.productId ? catByPid.get(p.productId)?.grantedByName ?? null : null,
          productId: p.productId,
          spent: p.spent || 0,
          purchases: p.purchases || [],
          basePrice: p.basePrice ?? null,
          currentPrice: p.currentPrice ?? null,
          image: p.image || null,
          bundle: p.bundle
            ? {
                contents: p.bundle.contents || [],
                // 优先用 CTA 折后价；容器价只作为「原价」参考
                currentPrice: p.currentPrice ?? p.bundle.currentPrice ?? null,
                containerPrice: p.bundle.currentPrice ?? null,
                sumIndividualNow: p.bundle.sumIndividualNow ?? null,
                savingsVsIndividual: p.bundle.savingsVsIndividual ?? null,
                items: p.bundle.items || [],
              }
            : null,
        };
      }),
    }));
    return json(res, 200, {
      hasToken: Boolean(state.tokens),
      tokenExpired: tokenExpired(state.tokens),
      settings: state.settings,
      games: state.games,
      catalog,
      series,
      lastSync: state.lastSync,
      lastSyncNote: state.lastSyncNote,
      lastTxAttempts: state.lastTxAttempts || null,
      hasCookies: Boolean(state.webCookies && state.webCookies.npsso && state.webCookies.pdccws_p),
      lastTxSync: state.lastTxSync || null,
      dataDir: DATA_DIR,
    });
  }

  if (p === "/api/login" && method === "POST") {
    const body = await readBody(req);
    const npsso = String(body.npsso || "").trim();
    if (!npsso) return json(res, 400, { error: "请粘贴 npsso" });
    const code = await psn.npssoToCode(npsso);
    const tokens = await psn.codeToTokens(code);
    state.tokens = tokens;
    applyRegionFromToken(state, tokens.idToken);
    saveState(state);
    return json(res, 200, {
      ok: true,
      expiresIn: tokens.expiresIn,
      settings: state.settings,
    });
  }

  if (p === "/api/logout" && method === "POST") {
    state.tokens = null;
    saveState(state);
    return json(res, 200, { ok: true });
  }

  if (p === "/api/settings" && method === "PATCH") {
    const body = await readBody(req);
    if (body.country) state.settings.country = String(body.country).toUpperCase().slice(0, 2);
    if (body.currency) state.settings.currency = String(body.currency).toUpperCase().slice(0, 3);
    if (body.lang) state.settings.lang = String(body.lang).slice(0, 12);
    saveState(state);
    return json(res, 200, { ok: true, settings: state.settings });
  }

  if (p === "/api/netcheck" && method === "GET") {
    const results = await psn.netCheck();
    return json(res, 200, { results });
  }

  if (p === "/api/sync" && method === "POST") {
    const body = await readBody(req);
    try {
      const out = await handleSync(state, body);
      return json(res, 200, out);
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }
  }

  if (p.startsWith("/api/games/") && (method === "PATCH" || method === "PUT")) {
    const id = decodeURIComponent(p.slice("/api/games/".length));
    const body = await readBody(req);
    const g = state.games.find((x) => x.id === id);
    if (!g) return json(res, 404, { error: "未找到游戏" });
    if (body.purchasePrice !== undefined)
      g.purchasePrice = body.purchasePrice === null ? null : Number(body.purchasePrice);
    if (body.purchaseDate !== undefined) g.purchaseDate = body.purchaseDate || null;
    if (body.currentPrice !== undefined)
      g.currentPrice = body.currentPrice === null ? null : Number(body.currentPrice);
    if (body.note !== undefined) g.note = String(body.note || "");
    if (body.currentPrice !== undefined) g.currentPriceAt = new Date().toISOString().slice(0, 10);
    saveState(state);
    return json(res, 200, { ok: true, game: g });
  }

  if (p === "/api/sync/transactions" && method === "POST") {
    const c = state.webCookies;
    if (!c || !c.npsso || !c.pdccws_p) {
      return json(res, 400, {
        error: "缺少网页会话 Cookie（需要 npsso 与 pdccws_p）。请先完成「从浏览器获取 Cookie」。",
      });
    }
    try {
      const txs = await psn.fetchTransactionHistory(c);
      const paid = psn.extractPaidPurchases(txs);
      const merged = mergePaidPurchases(state, paid);
      // 关键：把交易重新整理成 catalog / series，否则前端拿不到任何图表数据
      const built = rebuildCatalog(state, txs);
      // 顺便刷新商店现价（「当前价值 / 累计省下」依赖它）
      let priced = null;
      try {
        priced = await snapshotPrices(state);
      } catch {}
      state.lastTxSync = new Date().toISOString();
      state.lastSync = state.lastTxSync;
      state.lastSyncNote = `交易 ${txs.length} 条，付费 ${paid.length} 笔`;
      saveState(state);
      const total = state.games.reduce((s, g) => s + (Number(g.purchasePrice) || 0), 0);
      return json(res, 200, {
        ok: true,
        transactions: txs.length,
        paid: paid.length,
        ...merged,
        ...built,
        priced: priced ? { updated: priced.added + priced.skipped, failed: priced.failed } : null,
        total: Number(total.toFixed(2)),
      });
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }
  }

  if (p === "/api/prices/refresh" && method === "POST") {
    try {
      const r = await snapshotPrices(state);
      saveState(state);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }
  }

  if (p === "/api/snapshot" && method === "POST") {
    const r = await snapshotPrices(state);
    return json(res, 200, { ok: true, ...r });
  }

  if (p === "/api/price-history" && method === "GET") {
    const pid = url.searchParams.get("productId");
    const h = loadHistory();
    if (pid) return json(res, 200, { productId: pid, points: h[pid] || [] });
    const summary = {};
    for (const [k, v] of Object.entries(h)) summary[k] = Array.isArray(v) ? v.length : 0;
    return json(res, 200, summary);
  }

  if (p === "/api/cookies" && method === "POST") {
    const body = await readBody(req);
    const npsso = String(body.npsso || "").trim();
    const pdccws = String(body.pdccws_p || "").trim();
    if (!npsso || !pdccws) return json(res, 400, { error: "需要 npsso 与 pdccws_p 两个值" });
    state.webCookies = { npsso, pdccws_p: pdccws };
    saveState(state);
    return json(res, 200, { ok: true });
  }

  if (p === "/api/prices/refresh" && method === "POST") {
    const body = await readBody(req);
    const onlyIds = Array.isArray(body.ids) ? new Set(body.ids) : null;
    const targets = state.games.filter((g) => !onlyIds || onlyIds.has(g.id));
    const today = new Date().toISOString().slice(0, 10);
    let updated = 0;
    let failed = 0;

    const refreshOne = async (g) => {
      let price = null;
      if (g.productId) {
        price = await psn.fetchStorePrice(g.productId, state.settings.country, state.settings.lang);
      }
      if (!price || price.amount == null) {
        // 没有 productId（手动/CSV 导入）时，按名称搜索商店
        const s = await psn.searchStorePrice(g.name, state.settings.country, state.settings.lang);
        if (s && s.amount != null) {
          price = { amount: s.amount, display: s.display, currency: s.currency };
          if (!g.productId && s.productId && s.score >= 60) g.productId = s.productId;
        }
      }
      if (price && price.amount != null) {
        g.currentPrice = price.amount;
        g.currentPriceAt = today;
        g.priceSource = "store";
        updated++;
      } else {
        failed++;
      }
    };

    for (let i = 0; i < targets.length; i += 3) {
      await Promise.all(targets.slice(i, i + 3).map(refreshOne));
      await new Promise((r) => setTimeout(r, 120));
    }

    saveState(state);
    return json(res, 200, { ok: true, total: targets.length, updated, failed });
  }

  if (p === "/api/games" && method === "POST") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (!name) return json(res, 400, { error: "请填写游戏名称" });
    const toNum = (v) => (v == null || v === "" ? null : Number(v));
    const g = {
      id: "manual:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      titleId: null,
      productId: null,
      conceptId: null,
      name,
      platform: body.platform ? String(body.platform) : null,
      cover: null,
      purchasePrice: toNum(body.purchasePrice),
      purchaseDate: body.purchaseDate || null,
      currentPrice: toNum(body.currentPrice),
      currentPriceAt: body.currentPrice != null && body.currentPrice !== "" ? new Date().toISOString().slice(0, 10) : null,
      priceSource: "manual",
      note: body.note ? String(body.note) : "",
      owned: true,
    };
    state.games.push(g);
    saveState(state);
    return json(res, 200, { ok: true, game: g });
  }

  if (p.startsWith("/api/games/") && method === "DELETE") {
    const id = decodeURIComponent(p.slice("/api/games/".length));
    const before = state.games.length;
    state.games = state.games.filter((g) => g.id !== id);
    saveState(state);
    return json(res, 200, { ok: true, removed: before - state.games.length });
  }

  if (p === "/api/import/csv" && method === "POST") {
    const body = await readBody(req);
    const text = String(body.csv || "");
    if (!text.trim()) return json(res, 400, { error: "CSV 内容为空" });
    const parsed = csvToTransactions(text);
    if (parsed.transactions.length === 0) {
      return json(res, 400, {
        error: `未能从 CSV 中识别出交易记录（识别到 ${parsed.skipped} 行可跳过）。请确认至少包含「名称」和「价格/日期」列。`,
      });
    }
    const merged = mergeCsvTransactions(state, parsed.transactions);
    saveState(state);
    return json(res, 200, {
      ok: true,
      total: parsed.transactions.length,
      skipped: parsed.skipped,
      hasHeader: parsed.hasHeader,
      mapping: parsed.mapping,
      matched: merged.matched,
      created: merged.created,
      games: state.games.length,
    });
  }

  if (p === "/api/import" && method === "POST") {
    const body = await readBody(req);
    const items = Array.isArray(body.games) ? body.games : [];
    for (const it of items) {
      const id = it.id || it.titleId || it.name;
      if (!id) continue;
      const existing = state.games.find((g) => g.id === id);
      if (existing) {
        Object.assign(existing, {
          purchasePrice: it.purchasePrice ?? existing.purchasePrice,
          purchaseDate: it.purchaseDate ?? existing.purchaseDate,
          currentPrice: it.currentPrice ?? existing.currentPrice,
          note: it.note ?? existing.note,
        });
      } else {
        state.games.push({ ...it, id, owned: it.owned ?? true });
      }
    }
    saveState(state);
    return json(res, 200, { ok: true, count: state.games.length });
  }

  if (p === "/api/export.json" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="psn-spend.json"',
    });
    return res.end(JSON.stringify({ settings: state.settings, games: state.games }, null, 2));
  }

  if (p === "/api/export.csv" && method === "GET") {
    const cur = state.settings.currency || "";
    const header = ["名称", "平台", "购入价", "购入日期", "现价", "差额", "币种", "备注"];
    const rows = state.games.map((g) => [
      g.name,
      g.platform || "",
      g.purchasePrice ?? "",
      g.purchaseDate || "",
      g.currentPrice ?? "",
      g.purchasePrice != null && g.currentPrice != null ? (g.purchasePrice - g.currentPrice).toFixed(2) : "",
      cur,
      g.note || "",
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","))
      .join("\r\n");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="psn-spend.csv"',
    });
    return res.end("\uFEFF" + csv);
  }

  return json(res, 404, { error: "未知接口" });
}

// ---------------- 静态文件 ----------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ""));
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  });
}

// ---------------- 启动 ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  // 允许局域网内 iPhone 访问
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) lan.push(n.address);
    }
  }
  console.log("");
  console.log("  PSN 消费统计（本地）已启动");
  console.log("  本机访问： http://localhost:" + PORT);
  if (lan.length) console.log("  iPhone 访问（同一 Wi-Fi）： " + lan.map((a) => `http://${a}:${PORT}`).join("  "));
  console.log("  数据文件： " + DATA_FILE);
  console.log("  价格历史： " + HISTORY_FILE);
  console.log("");

  // 每天自动快照一次（启动 25 秒后检查，之后每 6 小时检查）
  const autoSnapshot = async () => {
    try {
      const st = loadState();
      if (!st.catalog?.length) return;
      const h = loadHistory();
      const today = new Date().toISOString().slice(0, 10);
      const done = Object.values(h).some((arr) => Array.isArray(arr) && arr.some((x) => x.d === today));
      if (done) return;
      console.log("  [价格快照] 开始记录 " + today);
      const r = await snapshotPrices(st);
      console.log(`  [价格快照] 完成：新增 ${r.added}，跳过 ${r.skipped}，失败 ${r.failed}`);
    } catch (e) {
      console.log("  [价格快照] 失败：" + e.message);
    }
  };
  setTimeout(autoSnapshot, 25000);
  setInterval(autoSnapshot, 6 * 3600 * 1000);
});
