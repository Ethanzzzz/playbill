// catalog.mjs — 从交易记录重建「商品目录 + 系列」
// 这是服务端内置的归类逻辑，替代原先的离线脚本（build-taxonomy / reassign-series）。
// 目标：任何新用户点一次「同步交易」，就能得到完整的 catalog 与 series。

// ---------- 系列映射 ----------
const SERIES = [
  { key: "re", label: "生化危机 Resident Evil", re: /resident evil|生化危机/i },
  { key: "he", label: "绝地潜兵 Helldivers", re: /helldivers|绝地潜兵/i },
  { key: "naruto", label: "火影忍者", re: /naruto|火影/i },
  { key: "bioshock", label: "生化奇兵 BioShock", re: /bioshock|生化奇兵/i },
  { key: "batman", label: "蝙蝠侠 阿卡姆", re: /batman|蝙蝠侠|arkham|阿卡姆/i },
  { key: "tomb", label: "古墓丽影 Tomb Raider", re: /tomb raider|古墓丽影|lara croft/i },
  { key: "ff", label: "最终幻想 Final Fantasy", re: /final fantasy|最终幻想/i },
  { key: "cod", label: "使命召唤 Call of Duty", re: /call of duty|使命召唤/i },
  { key: "ac", label: "刺客信条 Assassin's Creed", re: /assassin|刺客信条/i },
  { key: "dmc", label: "鬼泣 Devil May Cry", re: /devil may cry|鬼泣/i },
  { key: "mgs", label: "合金装备 Metal Gear", re: /metal gear|合金装备/i },
  { key: "spidey", label: "蜘蛛侠 Spider-Man", re: /spider-?man|蜘蛛侠/i },
  { key: "gow", label: "战神 God of War", re: /god of war|战神/i },
  { key: "horizon", label: "地平线 Horizon", re: /horizon|地平线/i },
  { key: "tlou", label: "最后生还者 The Last of Us", re: /last of us|最后生还者|最後生還者/i },
  { key: "uncharted", label: "神秘海域 Uncharted", re: /uncharted|神秘海域/i },
  { key: "ace", label: "皇牌空战 Ace Combat", re: /ace combat|皇牌空战/i },
  { key: "yakuza", label: "如龙 Yakuza", re: /yakuza|如龙|龍が如く/i },
  { key: "persona", label: "女神异闻录 Persona", re: /persona|女神异闻录/i },
  { key: "fallen", label: "星球大战 Star Wars", re: /star wars|星球大战/i },
  { key: "borderlands", label: "无主之地 Borderlands", re: /borderlands|无主之地/i },
  { key: "witcher", label: "巫师 The Witcher", re: /witcher|巫师/i },
  { key: "souls", label: "魂系 Souls", re: /dark souls|elden ring|sekiro|bloodborne|恶魔之魂|黑暗之魂|只狼/i },
];

const OTHER = { key: "other", label: "其他 / 独立作品" };

function seriesOf(name) {
  for (const s of SERIES) if (s.re.test(name || "")) return s;
  return OTHER;
}

// ---------- 类型判定 ----------
const BUNDLE_RE = /Collection|Trilogy|Bundle|合集|捆绑|三部曲|套装|组合包|同捆|Anthology|Pack$|Collection™|Legacy/i;
const DLC_RE =
  /DLC|追加|扩展|季票|Season Pass|升级包|Unlock|解锁|服装|Skin|Avatar|头像|虚拟形象|礼包|增援|Expert Pack|点数|Pack\b|更新包|扩充包|语音包|武器|道具|模式|皮肤|货币|Bundle\b/i;

function kindOf(row) {
  const n = row.name || "";
  if (row.category === "subscription") return "subscription";
  if (row.category === "wallet") return "wallet";
  if (row.category === "avatar") return "avatar";
  if (BUNDLE_RE.test(n)) return "bundle";
  if (DLC_RE.test(n)) return "dlc";
  if (row.skuType === "VOUCHER" && !(row.totalSpent > 0)) return "voucher";
  return "game";
}

/** 商品 ID 的命名空间（前两段），同一游戏的本体/DLC/季票共享 */
export function familyOf(productId) {
  if (!productId) return null;
  return String(productId).split("-").slice(0, 2).join("-");
}

/** 从 skuId 推导商店 productId：去掉最后一段 */
export function productIdOf(skuId) {
  if (!skuId) return null;
  const parts = String(skuId).split("-");
  if (parts.length < 3) return null;
  return parts.slice(0, -1).join("-");
}

/**
 * 从交易记录重建 catalog 与 series，写回 state。
 * @param {object} state 已有 games / 旧 catalog（用于继承封面与旧字段）
 * @param {Array}  txs   原始交易记录数组
 * @returns {{catalog:number, series:number, paid:number}}
 */
export function rebuildCatalog(state, txs) {
  const prevByPid = new Map();
  for (const c of state.catalog || []) {
    if (c.productId) prevByPid.set(c.productId, c);
    if (c.name) prevByPid.set("name:" + c.name, c);
  }

  // 游戏库里的封面 / 现价，用于回填
  const gameByPid = new Map();
  for (const g of state.games || []) {
    if (g.productId) gameByPid.set(g.productId, g);
    if (g.titleId) gameByPid.set(g.titleId, g);
  }

  // ---------- 1. 把交易展开成商品行 ----------
  const rows = [];
  for (const t of txs || []) {
    const date = String(t.date || "").slice(0, 10);
    for (const p of t.purchaseDetails?.productPurchases || []) {
      const cents = Number(p.total ?? 0);
      rows.push({
        name: p.productName || p.skuId || "未知",
        skuId: p.skuId || null,
        productId: productIdOf(p.skuId),
        skuType: p.skuType || null,
        price: Math.round(cents) / 100,
        date,
      });
    }
  }

  // ---------- 2. 按商品聚合 ----------
  const byKey = new Map();
  for (const r of rows) {
    const key = r.productId || "name:" + r.name;
    let item = byKey.get(key);
    if (!item) {
      item = {
        name: r.name,
        productId: r.productId,
        skuType: r.skuType,
        totalSpent: 0,
        purchases: [],
        dates: [],
      };
      byKey.set(key, item);
    }
    item.totalSpent += r.price;
    if (r.price > 0 || item.purchases.length === 0) {
      item.purchases.push({ date: r.date, price: r.price });
    }
    if (r.date) item.dates.push(r.date);
  }

  // ---------- 3. 组装 catalog ----------
  const catalog = [];
  for (const item of byKey.values()) {
    const prev = (item.productId && prevByPid.get(item.productId)) || prevByPid.get("name:" + item.name) || {};
    const game = (item.productId && gameByPid.get(item.productId)) || null;

    const entry = {
      ...prev, // 继承旧的 bundle / store / image 等信息
      name: item.name,
      productId: item.productId,
      skuType: item.skuType,
      totalSpent: Number(item.totalSpent.toFixed(2)),
      purchases: item.purchases.sort((a, b) => String(a.date).localeCompare(String(b.date))),
      dates: [...new Set(item.dates)].sort(),
      image: prev.image || game?.cover || null,
      store: prev.store || null,
    };
    entry.kind = prev.kind && prev.kind !== "game" ? prev.kind : kindOf({ ...entry, name: entry.name });
    entry.series = seriesOf(entry.name).key;
    entry.seriesLabel = seriesOf(entry.name).label;
    catalog.push(entry);
  }

  // ---------- 4. 按命名空间校正系列（DLC 名字里往往没有关键词） ----------
  const fams = new Map();
  for (const c of catalog) {
    const f = familyOf(c.productId);
    if (!f) continue;
    if (!fams.has(f)) fams.set(f, []);
    fams.get(f).push(c);
  }
  for (const arr of fams.values()) {
    if (arr.length < 2) continue;
    const score = new Map();
    for (const c of arr) {
      if (!c.series || c.series === "other") continue;
      score.set(c.series, (score.get(c.series) || 0) + (c.kind === "game" ? 10 : 1));
    }
    if (!score.size) continue;
    const top = [...score.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const label = arr.find((c) => c.series === top)?.seriesLabel || top;
    for (const c of arr) {
      if (c.series !== top) {
        c.series = top;
        c.seriesLabel = label;
      }
    }
  }

  // ---------- 5. 聚合 series ----------
  state.catalog = catalog;
  rebuildSeries(state);
  state.catalogUpdatedAt = new Date().toISOString();

  return {
    catalog: catalog.length,
    series: state.series.length,
    paid: rows.filter((r) => r.price > 0).length,
  };
}

/** 由 catalog 重新聚合 series（不涉及网络，可单独调用） */
export function rebuildSeries(state) {
  const bySeries = new Map();
  for (const c of state.catalog || []) {
    if (!bySeries.has(c.series)) {
      bySeries.set(c.series, { key: c.series, label: c.seriesLabel || c.series, products: [], totalSpent: 0 });
    }
    const s = bySeries.get(c.series);
    s.products.push({
      name: c.name,
      kind: c.kind,
      productId: c.productId,
      spent: c.totalSpent || 0,
      purchases: c.purchases || [],
      basePrice: c.store?.price?.basePrice ?? c.store?.basePrice ?? null,
      currentPrice: c.store?.price?.discountedPrice ?? c.store?.discountedPrice ?? null,
      image: c.image || null,
      bundle: c.bundle || null,
    });
    s.totalSpent += c.totalSpent || 0;
  }
  state.series = [...bySeries.values()].sort((a, b) => b.totalSpent - a.totalSpent);
  return state.series.length;
}
