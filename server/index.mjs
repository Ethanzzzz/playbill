// index.mjs — 本地服务端：托管 PWA 前端 + 提供 PSN 数据 API。
// 设计原则：令牌与全部数据只保存在本机 data.json，不向任何第三方上传。
import http from "node:http";
import https from "node:https";
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
// 可用环境变量 PLAYBILL_DATA_DIR 覆盖（兼容旧的 PSN_DATA_DIR）。
const APP_DIR_NAME = "PLAYBILL";
const LEGACY_DIR_NAME = "PSNArchive";

function userBase() {
  return process.platform === "win32"
    ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    : path.join(os.homedir(), ".config");
}

// 老用户升级：把 PSNArchive 整个目录改名过来，数据不丢、也不用重新登录
function migrateDirName() {
  try {
    const base = userBase();
    const next = path.join(base, APP_DIR_NAME);
    const prev = path.join(base, LEGACY_DIR_NAME);
    if (!fs.existsSync(next) && fs.existsSync(prev)) {
      fs.renameSync(prev, next);
      console.log("  已迁移数据目录： " + prev + " → " + next);
    }
  } catch (e) {
    console.log("  数据目录迁移失败（继续使用旧目录）：" + e.message);
  }
}

function resolveDataDir() {
  const override = process.env.PLAYBILL_DATA_DIR || process.env.PSN_DATA_DIR;
  if (override) return override;
  return path.join(userBase(), APP_DIR_NAME);
}

if (!process.env.PLAYBILL_DATA_DIR && !process.env.PSN_DATA_DIR) migrateDirName();

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
 * 抓取当前商店价并记录当天快照。每个 productId 每天只记一条（幂等）。
 *
 * 关键：查价必须用「匿名」请求。带上登录 Cookie 时，已拥有的商品只会返回
 * PURCHASED / DOWNLOAD 的 CTA，price 里每个字段都是 null，会被误判成 HK$0。
 */
async function snapshotPrices(state) {
  const history = loadHistory();
  const today = new Date().toISOString().slice(0, 10);
  const entries = (state.catalog || []).filter((c) => c.productId);
  const byPid = new Map(entries.map((c) => [c.productId, c]));
  const gameByPid = new Map();
  const gameByName = new Map();
  const normName = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[®™©:：\-–—.,'"()（）\[\]【】《》]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  for (const g of state.games || []) {
    if (g.productId) gameByPid.set(g.productId, g);
    if (g.name) gameByName.set(normName(g.name), g);
  }

  // 清掉旧版本误写的 0 元价格（拿不到价 ≠ 免费）
  let cleaned = 0;
  for (const c of entries) {
    const pr = c.store?.price;
    const bad = pr && !pr.isFree && !(Number(pr.discountedPrice) > 0) && !(Number(pr.basePrice) > 0);
    if (!bad) continue;
    delete c.store.price;
    cleaned++;
    const g = gameByPid.get(c.productId);
    if (g && g.priceSource === "store-gql" && !(Number(g.currentPrice) > 0)) {
      g.currentPrice = null;
      delete g.currentPriceAt;
      delete g.currentBasePrice;
    }
  }

  const ids = [...byPid.keys()];
  let added = 0;
  let skipped = 0;
  let failed = 0;
  const failedIds = [];

  const apply = (pid, p) => {
    const c = byPid.get(pid);
    const arr = history[pid] || (history[pid] = []);
    const already = arr.some((x) => x.d === today);
    if (c) {
      c.store = c.store || {};
      c.store.price = {
        currency: p.currency,
        basePrice: p.base,
        discountedPrice: p.price,
        discountText:
          Number(p.base) > 0 && p.price != null && p.price < p.base
            ? `-${Math.round((1 - p.price / p.base) * 100)}%`
            : null,
        isFree: Boolean(p.isFree),
      };
      c.store.checkedAt = today;
    }
    const g = gameByPid.get(pid) || gameByName.get(normName(c?.name));
    if (g) {
      if (p.price != null) g.currentPrice = p.price;
      if (p.base != null) g.currentBasePrice = p.base;
      g.currentPriceAt = today;
      g.priceSource = "store-gql";
    }
    if (already) skipped++;
    else {
      arr.push({ d: today, b: p.base, p: p.price });
      added++;
    }
  };

  const fetchPrice = async (pid, allowContainer = true) => {
    let p = await psn.fetchCtaPrice(pid);
    if (!p && allowContainer) {
      // 兜底：商店容器接口，同样是公开接口，不需要登录
      const s = await psn.fetchStorePrice(pid, state.settings.country, state.settings.lang);
      if (s && (Number(s.amount) > 0 || Number(s.baseAmount) > 0)) {
        p = { currency: s.currency || state.settings.currency, base: s.baseAmount, price: s.amount, isFree: false };
      }
    }
    return p && (Number(p.price) > 0 || Number(p.base) > 0 || p.isFree) ? p : null;
  };

  // 第一遍：并发 2，失败记下来
  async function priceWorker() {
    while (ids.length) {
      const pid = ids.shift();
      if (!pid) break;
      try {
        const p = await fetchPrice(pid);
        if (p) apply(pid, p);
        else failedIds.push(pid);
      } catch {
        failedIds.push(pid);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  await Promise.all([priceWorker(), priceWorker()]);

  // 第二遍：失败的再试一次（间隔久一点，避开瞬时风控）
  if (failedIds.length) {
    await new Promise((r) => setTimeout(r, 2000));
    for (const pid of [...failedIds]) {
      try {
        const p = await fetchPrice(pid, false); // 重试只打 CTA，不再重复容器请求
        if (p) {
          apply(pid, p);
          failedIds.splice(failedIds.indexOf(pid), 1);
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // 第三遍：补封面。先补花过钱的（用户最常看的），并发 2，给 120 秒预算
  let imgFixed = 0;
  const imgQueue = (state.catalog || [])
    .filter((x) => x.productId && !x.image)
    .sort((a, b) => (Number(b.totalSpent) || 0) - (Number(a.totalSpent) || 0));
  const imgDeadline = Date.now() + 120_000;
  async function imgWorker() {
    while (imgQueue.length && Date.now() < imgDeadline) {
      const c = imgQueue.shift();
      if (!c) break;
      try {
        const img = await psn.fetchStoreImage(c.productId);
        if (img) {
          c.image = img;
          const g = gameByPid.get(c.productId);
          if (g && !g.cover) g.cover = img;
          imgFixed++;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  await Promise.all([imgWorker(), imgWorker()]);

  failed = failedIds.length;
  rebuildSeries(state); // 把新补的封面/现价同步到 series
  saveHistory(history);
  saveState(state);
  return { date: today, total: byPid.size, added, skipped, failed, imgFixed, cleaned };
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
    // 付过钱的命名空间：这些组里的赠品/免费项不该再被丢进「其他」
    const paidFamilies = new Set();
    const familyHasPaidGame = new Set();
    for (const c of state.catalog || []) {
      if (Number(c.totalSpent) > 0 && c.productId) {
        const f = String(c.productId).split("-").slice(0, 2).join("-");
        paidFamilies.add(f);
        if (c.kind === "game") familyHasPaidGame.add(f);
      }
    }
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
        const fam = p.productId ? String(p.productId).split("-").slice(0, 2).join("-") : null;
        const famPaid = fam ? paidFamilies.has(fam) : false;
        // 「Dive Harder 同捆包」这类：同组里没有单独买过本体，它其实就是本体
        if (kind === "bundle" && Number(p.spent) > 0 && fam && !familyHasPaidGame.has(fam)) {
          kind = "game";
        }
        const isOther =
          ["system", "avatar", "demo", "upgrade", "voucher"].includes(kind) ||
          (!hasPrice && Number(p.spent || 0) === 0 && !famPaid);

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
    const body = await readBody(req).catch(() => ({}));
    // 索尼的交易接口被拒时，可能有两种原因：会话被登出，或短时间调用太频繁。先冷处理 5 分钟，别继续撞
    const waitMs = (state.txBlockedUntil || 0) - Date.now();
    if (waitMs > 0) {
      return json(res, 429, {
        error: `索尼刚刚拒绝了交易接口，还要等 ${Math.ceil(waitMs / 1000)} 秒。到点再点一次；如果仍然不行，就重做「启动浏览器.bat → 抓取Cookie.bat」（会话可能被登出了）。`,
        retryAfterSec: Math.ceil(waitMs / 1000),
      });
    }
    try {
      const txs = await psn.fetchTransactionHistory(c);
      const paid = psn.extractPaidPurchases(txs);
      const merged = mergePaidPurchases(state, paid);
      // 关键：把交易重新整理成 catalog / series，否则前端拿不到任何图表数据
      const built = rebuildCatalog(state, txs);
      // 现价默认不在这里抓：263 个商品要两三分钟，单独走 /api/prices/refresh，
      // 前端可以给进度、也不会因为单个请求太久被中间层掐断。
      let priced = null;
      if (body && body.withPrices) {
        try {
          priced = await snapshotPrices(state);
        } catch {}
      }
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
      const msg = String(e.message || e);
      if (/access denied|authoriz|401|403/i.test(msg)) {
        state.txBlockedUntil = Date.now() + 5 * 60 * 1000;
        saveState(state);
        return json(res, 429, {
          error: "索尼的交易接口拒绝了这次请求：可能是会话被登出，也可能是短时间调用太频繁。等 5 分钟再试；不行就重做「启动浏览器 → 抓取Cookie」。",
          retryAfterSec: 300,
        });
      }
      return json(res, 400, { error: msg });
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

    // 除了这两颗，浏览器里还有 _abck / bm_sz 等风控 Cookie，一起带上才不容易被拒
    const extra = body.cookies && typeof body.cookies === "object" ? body.cookies : {};
    const merged = { ...extra, npsso, pdccws_p: pdccws };
    state.webCookies = merged;
    const cookieCount = Object.keys(merged).length;

    // 一次性完成登录：用同一颗 npsso 换 OAuth 令牌，用户不用再单独粘贴
    let loggedIn = false;
    let loginError = null;
    try {
      if (!state.tokens || tokenExpired(state.tokens)) {
        const code = await psn.npssoToCode(npsso);
        const tokens = await psn.codeToTokens(code);
        state.tokens = tokens;
        applyRegionFromToken(state, tokens.idToken);
        loggedIn = true;
      }
    } catch (e) {
      loginError = String(e.message || e);
    }

    saveState(state);

    // 立刻用这对 Cookie 试一下交易接口，把问题暴露在“抓取”这一步，而不是等同步时才发现
    let txOk = false;
    let txError = null;
    try {
      await psn.fetchTransactionHistory({ ...merged }, { limit: 1, maxPages: 1 });
      txOk = true;
    } catch (e) {
      txError = String(e.message || e);
    }

    return json(res, 200, { ok: true, loggedIn, loginError, txOk, txError, cookieCount });
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
const requestHandler = async (req, res) => {
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
};

// 手机要装成 App（PWA），浏览器要求 HTTPS。有证书就用 HTTPS，没有就照旧 HTTP。
// 证书固定放在配置目录（不受 PLAYBILL_DATA_DIR 影响），重启/换数据目录都不用重签
const CONFIG_DIR = path.join(userBase(), APP_DIR_NAME);
const TLS_PFX = process.env.PLAYBILL_TLS_PFX || path.join(CONFIG_DIR, "tls", "playbill.pfx");
const TLS_PASS_FILE = path.join(CONFIG_DIR, "tls", "pass.txt");
function tlsPassphrase() {
  if (process.env.PLAYBILL_TLS_PASS) return process.env.PLAYBILL_TLS_PASS;
  try {
    return fs.readFileSync(TLS_PASS_FILE, "utf8").trim();
  } catch {
    return "";
  }
}
let server = null;
let scheme = "http";
if (fs.existsSync(TLS_PFX)) {
  try {
    server = https.createServer(
      { pfx: fs.readFileSync(TLS_PFX), passphrase: tlsPassphrase() },
      requestHandler,
    );
    scheme = "https";
  } catch (e) {
    console.log("  ⚠ HTTPS 证书加载失败，回退到 HTTP：" + e.message);
  }
}
if (!server) server = http.createServer(requestHandler);

// 本地单用户工具：抓价格要两三分钟，别让 Node 的默认 5 分钟请求超时把请求掐断
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) lan.push(n.address);
    }
  }
  console.log("");
  console.log("  PLAYBILL · 本地服务已启动（" + scheme.toUpperCase() + "）");
  console.log("  本机访问： " + scheme + "://localhost:" + PORT);
  if (lan.length) {
    console.log(
      "  手机访问（同一 Wi-Fi）： " + lan.map((a) => `${scheme}://${a}:${PORT}`).join("  "),
    );
    if (scheme === "http") {
      console.log("  ⚠ 想装成手机 App（PWA）需要 HTTPS：双击「手机访问(HTTPS).bat」生成证书后重启");
    }
  }
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
