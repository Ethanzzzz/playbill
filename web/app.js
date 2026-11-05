// app.js — PSN 收藏档案（总览仪表盘 + 系列档案）
const $ = (id) => document.getElementById(id);
const OVERVIEW = "__overview__";
let STATE = { games: [], catalog: [], series: [], settings: { currency: "HKD" } };
let ACTIVE = OVERVIEW;

/* ---------- 基础工具 ---------- */
function toast(msg, ms = 2400) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), ms);
}
function fmt(n, currency) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  try {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency: currency || "HKD", maximumFractionDigits: 2 }).format(v);
  } catch {
    return v.toFixed(2);
  }
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function svgEl(tag, attrs = {}) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}
const cur = () => STATE.settings?.currency || "HKD";
const KIND_LABEL = { bundle: "捆绑包", game: "本体", dlc: "DLC", avatar: "化身", voucher: "凭证", subscription: "会员", wallet: "点卡", other: "其他" };

/* ---------- 载入 ---------- */
async function load() {
  try {
    STATE = await api("/api/state");
  } catch (e) {
    toast("读取失败：" + e.message);
  }
  render();
}

function render() {
  const total = (STATE.games || []).reduce((s, g) => s + (Number(g.purchasePrice) || 0), 0);
  $("total").textContent = fmt(total, cur());
  const txCount = (STATE.catalog || []).reduce((s, c) => s + (c.purchases || []).length, 0);
  $("railSub").textContent = `${(STATE.games || []).length} 个条目 · ${txCount} 笔购买`;
  $("sub").textContent = STATE.lastTxSync
    ? `交易同步于 ${new Date(STATE.lastTxSync).toLocaleString("zh-CN")}`
    : "尚未同步交易";

  renderRail();
  renderDetail();
}

/* ---------- 左栏 ---------- */
function renderRail() {
  const nav = $("seriesList");
  nav.innerHTML = "";

  const ov = el("div", "series-item" + (ACTIVE === OVERVIEW ? " active" : ""));
  ov.innerHTML = `<span class="nm">总览</span><span class="amt"></span><span class="cnt">全部数据</span>`;
  ov.onclick = () => { ACTIVE = OVERVIEW; renderRail(); renderDetail(); };
  nav.appendChild(ov);

  for (const s of (STATE.series || []).slice().sort((a, b) => b.totalSpent - a.totalSpent)) {
    const item = el("div", "series-item" + (s.key === ACTIVE ? " active" : ""));
    item.onclick = () => { ACTIVE = s.key; renderRail(); renderDetail(); window.scrollTo({ top: 0, behavior: "smooth" }); };
    item.appendChild(el("span", "nm", s.label));
    item.appendChild(el("span", "amt", s.totalSpent > 0 ? fmt(s.totalSpent, cur()) : "—"));
    item.appendChild(el("span", "cnt", `${s.products.length} 项`));
    nav.appendChild(item);
  }
}

/* ---------- 右栏分发 ---------- */
function renderDetail() {
  const box = $("detail");
  box.innerHTML = "";
  box.className = "fade-up";
  void box.offsetWidth;
  if (ACTIVE === OVERVIEW) renderOverview(box);
  else renderSeries(box);
}

/* ================= 首次使用引导 ================= */
function renderStartGuide(box) {
  const games = STATE.games || [];
  const hasToken = Boolean(STATE.hasToken);
  const hasGames = games.length > 0;
  const hasCookies = Boolean(STATE.hasCookies);

  const head = el("div", "dash-head");
  head.appendChild(el("div", "kicker", "开始使用"));
  head.appendChild(el("h2", null, hasGames ? "还差最后一步" : "先把数据同步进来"));
  head.appendChild(
    el(
      "p",
      "lede",
      hasGames
        ? `游戏库已经拿到 ${games.length} 个条目。但金额、系列、图表都来自「交易记录」，还需要再同步一次。`
        : "金额、系列、历史价格全部来自你的 PSN 交易记录。按下面四步走一遍，之后就都是自动的。",
    ),
  );
  box.appendChild(head);

  const steps = el("div", "start-steps");
  const mkStep = (n, title, desc, done, action) => {
    const d = el("div", "start-step" + (done ? " done" : ""));
    d.appendChild(el("div", "sn", done ? "✓" : String(n)));
    const body = el("div", "st");
    body.appendChild(el("div", "stt", title));
    body.appendChild(el("div", "std", desc));
    if (action && !done) {
      const b = el("button", "small", action.label);
      b.onclick = action.fn;
      body.appendChild(b);
    }
    d.appendChild(body);
    return d;
  };

  steps.appendChild(
    mkStep(
      1,
      "启动浏览器并登录 PSN",
      hasCookies ? "已完成" : "双击程序文件夹里的「启动浏览器.bat」，在弹出的窗口里登录 store.playstation.com",
      hasCookies,
      null,
    ),
  );
  steps.appendChild(
    mkStep(
      2,
      "抓取 Cookie（自动登录）",
      hasCookies && hasToken
        ? "已完成 —— 登录与 Cookie 一步搞定"
        : "双击「抓取Cookie.bat」，同时拿到 npsso 与 pdccws_p 并自动登录，不用再单独粘贴",
      hasCookies && hasToken,
      null,
    ),
  );
  steps.appendChild(
    mkStep(3, "同步游戏库", hasGames ? `已完成，共 ${games.length} 个条目` : "拉取你拥有的游戏与封面", hasGames, hasGames ? null : { label: "同步游戏", fn: () => doSync(false) }),
  );
  steps.appendChild(
    mkStep(4, "同步交易记录", "拿到每笔订单的商品、金额、日期，同时补全商店现价与封面（首次 1-2 分钟）", false, {
      label: "同步交易",
      fn: () => syncTx(),
    }),
  );
  box.appendChild(steps);

  if (hasGames) {
    const t = el("div", "section-title");
    t.appendChild(document.createTextNode("已同步的游戏"));
    t.appendChild(el("span", "n", String(games.length)));
    box.appendChild(t);
    const grid = el("div", "game-grid");
    for (const g of games.slice(0, 30)) {
      const c = el("div", "gcard");
      const th = el("div", "gcover");
      if (g.cover) {
        const im = new Image();
        im.src = g.cover;
        im.alt = "";
        im.onerror = () => { im.remove(); th.textContent = (g.name || "?").slice(0, 1); };
        th.appendChild(im);
      } else {
        th.textContent = (g.name || "?").slice(0, 1);
      }
      c.appendChild(th);
      c.appendChild(el("div", "gname", g.name || "未知"));
      c.title = g.name || "";
      grid.appendChild(c);
    }
    box.appendChild(grid);
    if (games.length > 30) {
      box.appendChild(el("p", "hint", `仅显示前 30 个，共 ${games.length} 个`));
    }
  }
}

/* ================= 总览 ================= */
function renderOverview(box) {
  const games = STATE.games || [];
  const catalog = STATE.catalog || [];
  // 没有交易记录时，金额/系列/图表都无从谈起，直接给引导页而不是空白
  if (!catalog.length) {
    renderStartGuide(box);
    return;
  }
  const totalSpent = games.reduce((s, g) => s + (Number(g.purchasePrice) || 0), 0);
  const owned = games.filter((g) => g.purchasePrice > 0);
  const nowValue = owned.reduce((s, g) => s + (Number(g.currentPrice) || 0), 0);
  const saved = Math.max(0, nowValue - totalSpent);
  const txCount = catalog.reduce((s, c) => s + (c.purchases || []).length, 0);

  const head = el("div", "dash-head");
  head.appendChild(el("div", "kicker", "Dashboard"));
  head.appendChild(el("h2", null, "你的 PSN 收藏全景"));
  head.appendChild(el("p", "lede", "把 10 年的购买记录、捆绑包与 DLC 摊开来看：花在哪、省了多少、现在值多少。"));
  box.appendChild(head);

  const kpis = el("div", "kpis");
  const kpi = (k, v, s, alt) => {
    const d = el("div", "kpi" + (alt ? " alt" : ""));
    d.appendChild(el("div", "k", k));
    d.appendChild(el("div", "v", v));
    if (s) d.appendChild(el("div", "s", s));
    kpis.appendChild(d);
  };
  kpi("累计投入", fmt(totalSpent, cur()), `${txCount} 笔购买`);
  kpi("当前价值", nowValue ? fmt(nowValue, cur()) : "—", `${owned.length} 件仍可估价`, true);
  kpi("累计省下", saved ? fmt(saved, cur()) : "—", "现价高于买入价", true);
  kpi("系列 / 合集", String((STATE.series || []).filter((s) => s.totalSpent > 0).length), "有消费的系列");
  box.appendChild(kpis);

  const grid = el("div", "chart-grid");
  box.appendChild(grid);

  // 1) 每月消费
  const monthCard = el("div", "chart full");
  const mh = el("div", "chart-h");
  mh.appendChild(el("h3", null, "每月消费"));
  mh.appendChild(el("span", "note", "近 12 个月"));
  monthCard.appendChild(mh);
  const barsWrap = el("div", "bars");
  monthCard.appendChild(barsWrap);
  grid.appendChild(monthCard);
  renderMonthlyBars(barsWrap);

  // 2) 消费构成
  const catCard = el("div", "chart");
  const ch = el("div", "chart-h");
  ch.appendChild(el("h3", null, "消费构成"));
  catCard.appendChild(ch);
  grid.appendChild(catCard);
  renderDonut(catCard);

  // 3) 系列排行
  const rankCard = el("div", "chart");
  const rh = el("div", "chart-h");
  rh.appendChild(el("h3", null, "系列消费排行"));
  rankCard.appendChild(rh);
  grid.appendChild(rankCard);
  renderRank(rankCard);

  // 4) 当前折扣
  const discCard = el("div", "chart full");
  const dh = el("div", "chart-h");
  dh.appendChild(el("h3", null, "当前折扣榜"));
  discCard.appendChild(dh);
  grid.appendChild(discCard);
  renderDiscounts(discCard);
}

function renderMonthlyBars(container) {
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: d.getMonth() + 1, value: 0 });
  }
  const map = new Map(months.map((m) => [m.key, m]));
  for (const c of STATE.catalog || []) {
    for (const p of c.purchases || []) {
      const m = map.get(String(p.date || "").slice(0, 7));
      if (m) m.value += Number(p.price) || 0;
    }
  }
  const max = Math.max(...months.map((m) => m.value), 1);

  for (const m of months) {
    const col = el("div", "bar-col");
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill" + (m.value === 0 ? " muted" : ""));
    fill.title = `${m.label} 月 · ${fmt(m.value, cur())}`;
    if (m.value > 0) {
      fill.appendChild(el("div", "bar-v", m.value >= 1000 ? (m.value / 1000).toFixed(1) + "k" : String(Math.round(m.value))));
    }
    track.appendChild(fill);
    col.appendChild(track);
    col.appendChild(el("div", "bar-x", m.label + "月"));
    container.appendChild(col);
    const target = Math.max(m.value > 0 ? 4 : 0, (m.value / max) * 118);
    requestAnimationFrame(() => setTimeout(() => { fill.style.height = target + "px"; }, 40));
  }
}

function renderDonut(card) {
  const groups = { bundle: 0, game: 0, dlc: 0, other: 0 };
  for (const c of STATE.catalog || []) {
    const v = Number(c.totalSpent) || 0;
    if (!v) continue;
    if (c.kind === "bundle") groups.bundle += v;
    else if (c.kind === "game") groups.game += v;
    else if (c.kind === "dlc") groups.dlc += v;
    else groups.other += v;
  }
  const colors = { bundle: "var(--c-bundle)", game: "var(--c-game)", dlc: "var(--c-dlc)", other: "var(--c-other)" };
  const labels = { bundle: "捆绑包", game: "本体", dlc: "DLC", other: "其他" };
  const entries = Object.entries(groups).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);

  const wrap = el("div", "donut-wrap");
  const R = 46, C = 2 * Math.PI * R;
  const root = svgEl("svg", { viewBox: "0 0 120 120", class: "donut" });
  root.appendChild(svgEl("circle", { cx: 60, cy: 60, r: R, fill: "none", stroke: "#f0ece5", "stroke-width": 14 }));

  let offset = 0;
  for (const [k, v] of entries) {
    const frac = v / total;
    const seg = svgEl("circle", {
      cx: 60, cy: 60, r: R, fill: "none",
      "stroke-width": 14,
      "stroke-dasharray": `0 ${C.toFixed(2)}`,
      "stroke-dashoffset": `${(-offset * C).toFixed(2)}`,
      transform: "rotate(-90 60 60)",
    });
    seg.style.stroke = colors[k];
    root.appendChild(seg);
    offset += frac;
    const len = frac * C;
    requestAnimationFrame(() => setTimeout(() => { seg.setAttribute("stroke-dasharray", `${len.toFixed(2)} ${C.toFixed(2)}`); }, 80));
  }

  const t1 = svgEl("text", { x: 60, y: 57, "text-anchor": "middle", fill: "#16171a", "font-size": "13", "font-weight": "700" });
  t1.textContent = total >= 1000 ? (total / 1000).toFixed(1) + "k" : Math.round(total);
  const t2 = svgEl("text", { x: 60, y: 70, "text-anchor": "middle", fill: "#767676", "font-size": "8" });
  t2.textContent = "HKD";
  root.appendChild(t1);
  root.appendChild(t2);
  wrap.appendChild(root);

  const legend = el("div", "legend");
  for (const [k, v] of entries) {
    const row = el("div", "legend-row");
    const dot = el("span", "legend-dot");
    dot.style.background = colors[k];
    row.appendChild(dot);
    row.appendChild(el("span", "legend-name", labels[k]));
    row.appendChild(el("span", "legend-val", `${Math.round((v / total) * 100)}%`));
    legend.appendChild(row);
  }
  wrap.appendChild(legend);
  card.appendChild(wrap);
}

function renderRank(card) {
  const list = (STATE.series || [])
    .filter((s) => s.totalSpent > 0 && s.key !== "other")
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, 8);
  const max = Math.max(...list.map((s) => s.totalSpent), 1);
  const wrap = el("div", "rank");
  for (const s of list) {
    const row = el("div", "rank-row");
    row.appendChild(el("span", "rank-name", s.label));
    const track = el("div", "rank-track");
    const fill = el("div", "rank-fill");
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("span", "rank-val", fmt(s.totalSpent, cur())));
    wrap.appendChild(row);
    requestAnimationFrame(() => setTimeout(() => { fill.style.width = (s.totalSpent / max) * 100 + "%"; }, 60));
  }
  card.appendChild(wrap);
}

function renderDiscounts(card) {
  const list = (STATE.catalog || [])
    .filter((c) => c.basePrice != null && c.discountedPrice != null && c.discountedPrice > 0 && c.discountedPrice < c.basePrice)
    .map((c) => ({ ...c, off: 1 - c.discountedPrice / c.basePrice }))
    .sort((a, b) => b.off - a.off)
    .slice(0, 8);
  if (!list.length) { card.appendChild(el("p", "hint", "暂无打折数据，同步交易后更新。")); return; }

  const wrap = el("div", "disc");
  for (const c of list) {
    const row = el("div", "disc-row");
    row.appendChild(el("span", "disc-pct", `-${Math.round(c.off * 100)}%`));
    row.appendChild(el("span", "disc-name", c.name || "未知"));
    const p = el("span", "disc-price");
    p.appendChild(el("s", null, fmt(c.basePrice, cur())));
    p.appendChild(document.createTextNode(fmt(c.discountedPrice, cur())));
    row.appendChild(p);
    wrap.appendChild(row);
  }
  card.appendChild(wrap);
}

/* ================= 系列详情 ================= */
function renderSeries(box) {
  const s = (STATE.series || []).find((x) => x.key === ACTIVE);
  if (!s) { box.appendChild(el("p", "hint", "暂无数据，请先同步交易。")); return; }

  const prods = s.products.slice();
  const main = prods.filter((p) => p.bucket !== "other");
  const others = prods.filter((p) => p.bucket === "other");
  const owned = main.filter((p) => p.spent > 0);
  const nowOf = (p) =>
    p.kind === "bundle" && p.bundle?.currentPrice ? p.bundle.currentPrice : p.currentPrice != null && p.currentPrice > 0 ? p.currentPrice : null;
  const nowValue = owned.reduce((a, p) => a + (nowOf(p) || 0), 0);
  const diff = nowValue - s.totalSpent;

  const head = el("div", "detail-head");
  head.appendChild(el("div", "kicker", "系列档案"));
  head.appendChild(el("h2", null, s.label));
  const meta = el("div", "meta");
  meta.innerHTML = `累计 <b>${fmt(s.totalSpent, cur())}</b> · 条目 <b>${main.length}</b> · 付费购买 <b>${owned.length}</b>`;
  head.appendChild(meta);
  box.appendChild(head);

  const stats = el("div", "stat-row");
  const mk = (k, v, cls) => {
    const d = el("div", "stat");
    d.appendChild(el("div", "k", k));
    d.appendChild(el("div", "v" + (cls ? " " + cls : ""), v));
    return d;
  };
  stats.appendChild(mk("累计投入", fmt(s.totalSpent, cur())));
  stats.appendChild(mk("当前价值", nowValue ? fmt(nowValue, cur()) : "—"));
  stats.appendChild(mk(diff >= 0 ? "累计省下" : "累计多花", fmt(Math.abs(diff), cur()), diff >= 0 ? "pos" : "neg"));
  stats.appendChild(mk("付费件数", String(owned.length)));
  const plusCount = prods.filter((p) => p.service === "ps_plus").length;
  if (plusCount) stats.appendChild(mk("会员领取", String(plusCount)));
  box.appendChild(stats);

  // 全局命名空间表：同一游戏的本体 / DLC / 季票 / 组合包
  const famAll = new Map();
  for (const c of STATE.catalog || []) {
    if (!c.family) continue;
    if (!famAll.has(c.family)) famAll.set(c.family, []);
    famAll.get(c.family).push({
      name: c.name,
      kind: c.kind,
      productId: c.productId,
      spent: c.totalSpent || 0,
      grantedBy: c.grantedBy || null,
      grantedByName: c.grantedByName || null,
      image: c.image || null,
    });
  }
  const famHead = (arr) => {
    const games = arr.filter((x) => x.kind === "game");
    const pool = games.length ? games : arr;
    return pool.slice().sort((a, b) => (b.spent || 0) - (a.spent || 0) || (a.name || "").length - (b.name || "").length)[0];
  };

  // 树化：顶层只保留「父条目」，子项全部收进展开层，避免重复出现
  const visible = [];
  const childMap = new Map();
  for (const p of prods) {
    const arr = p.family ? famAll.get(p.family) || [] : [];
    if (arr.length < 2) {
      visible.push(p);
      continue;
    }
    const h = famHead(arr);
    if (h && h.productId === p.productId) {
      visible.push(p);
      childMap.set(p.productId, arr.filter((x) => x.productId !== p.productId));
    }
    // 子项不在顶层重复渲染
  }

  const mainVis = visible.filter((p) => p.bucket !== "other");
  const otherVis = visible.filter((p) => p.bucket === "other");

  const groups = { bundle: [], game: [], dlc: [] };
  for (const p of mainVis) {
    if (p.kind === "bundle") groups.bundle.push(p);
    else if (p.kind === "dlc") groups.dlc.push(p);
    else groups.game.push(p);
  }

  const order = [
    ["bundle", "捆绑包 / 合集"],
    ["game", "本体 / 版本"],
    ["dlc", "DLC / 追加内容"],
  ];
  for (const [key, title] of order) {
    const arr = groups[key];
    if (!arr.length) continue;
    arr.sort((a, b) => b.spent - a.spent);
    const t = el("div", "section-title");
    t.appendChild(document.createTextNode(title));
    t.appendChild(el("span", "n", String(arr.length)));
    box.appendChild(t);
    for (const p of arr) box.appendChild(productRow(p, childMap.get(p.productId) || []));
  }

  // 其他：升级 / 试玩 / App / 头像 / 领取 —— 默认折叠
  if (otherVis.length) {
    const sec = el("div", "other-section");
    const btn = el("button", "other-toggle");
    btn.appendChild(document.createTextNode(`其他（升级 / 试玩 / App / 头像 / 领取）`));
    btn.appendChild(el("span", "n", String(otherVis.length)));
    const body = el("div", "other-body");
    body.hidden = true;
    btn.onclick = () => { body.hidden = !body.hidden; btn.classList.toggle("open", !body.hidden); };
    otherVis.sort((a, b) => b.spent - a.spent);
    for (const p of otherVis) body.appendChild(productRow(p, childMap.get(p.productId) || []));
    sec.appendChild(btn);
    sec.appendChild(body);
    box.appendChild(sec);
  }
}

function fillThumb(node, name, image, kind) {
  node.innerHTML = "";
  node.classList.remove("plus", "wallet");
  if (image) {
    const im = new Image();
    im.src = image;
    im.alt = "";
    im.onerror = () => {
      im.remove();
      node.textContent = (name || "?").slice(0, 1).toUpperCase();
    };
    node.appendChild(im);
    return;
  }
  if (kind === "subscription") {
    node.classList.add("plus");
    node.textContent = "PS+";
    return;
  }
  if (kind === "wallet") {
    node.classList.add("wallet");
    node.textContent = "¥";
    return;
  }
  node.textContent = (name || "?").slice(0, 1).toUpperCase();
}

function childItem(name, note, priceText, image, kind) {
  const bi = el("div", "bitem");
  const bt = el("span", "bthumb");
  fillThumb(bt, name, image, kind);
  bi.appendChild(bt);
  bi.appendChild(el("span", "bn", name));
  bi.appendChild(el("span", "ba", note || ""));
  bi.appendChild(el("span", "bp", priceText || "—"));
  return bi;
}

function bindToggle(row, box, expander, count) {
  row.style.cursor = "pointer";
  row.classList.add("expandable");
  row.onclick = () => {
    box.hidden = !box.hidden;
    row.classList.toggle("open", !box.hidden);
    if (expander) {
      expander.classList.toggle("is-open", !box.hidden);
    }
  };
}

function productRow(p, family = []) {
  const wrap = el("div");
  const row = el("div", "prow");

  const thumb = el("div", "thumb");
  fillThumb(thumb, p.name, p.image, p.kind);
  row.appendChild(thumb);

  const info = el("div", "pinfo");
  info.appendChild(el("div", "pname", p.name || "未知"));
  const sub = el("div", "psub");
  sub.appendChild(el("span", "badge " + p.kind, KIND_LABEL[p.kind] || "其他"));
  // 来源标记：真购买 / 会员领取 / 免费领取
  if (p.service === "ps_plus") sub.appendChild(el("span", "badge plus", "会员领取"));
  else if (p.service === "none(purchased)" && Number(p.spent || 0) === 0) sub.appendChild(el("span", "badge free", "免费领取"));
  else if (p.service === "other") sub.appendChild(el("span", "badge", "其他来源"));
  if (p.grantedBy) sub.appendChild(el("span", "badge free", "随包附赠"));
  const dates = [...new Set((p.purchases || []).map((x) => x.date).filter(Boolean))].sort();
  sub.appendChild(el("span", null, dates.length ? (dates.length > 1 ? `${dates[0]} 起 · 共 ${dates.length} 次` : dates[0]) : p.spent > 0 ? "已购买" : "未购买 / 免费"));
  const bundleItems = p.kind === "bundle" && p.bundle?.items?.length ? p.bundle.items : null;
  const childCount = family.length || (bundleItems ? bundleItems.length : 0);
  const canExpand = childCount > 0;
  if (p.kind === "bundle" && p.bundle?.contents?.length && !family.length) sub.appendChild(el("span", null, `内含 ${p.bundle.contents.length} 项`));
  let expander = null;
  if (canExpand) {
    expander = el("span", "expander", `${childCount} 项`);
    sub.appendChild(expander);
  }
  if (p.productId) {
    const link = el("span", "hist-link", "价格历史");
    link.onclick = (e) => { e.stopPropagation(); openHistory(p); };
    sub.appendChild(link);
  }
  info.appendChild(sub);
  row.appendChild(info);

  const price = el("div", "pprice");
  price.appendChild(el("div", "paid", p.spent > 0 ? fmt(p.spent, cur()) : "—"));

  const refNow =
    p.kind === "bundle" && p.bundle?.currentPrice ? p.bundle.currentPrice
      : p.currentPrice != null && p.currentPrice > 0 ? p.currentPrice
        : p.kind === "bundle" ? p.bundle?.currentPrice : null;

  const nowLine = el("div", "now");
  if (refNow != null && refNow > 0) {
    if (p.kind !== "bundle" && p.basePrice != null && p.basePrice > refNow) nowLine.appendChild(el("s", null, fmt(p.basePrice, cur())));
    nowLine.appendChild(document.createTextNode(`现 ${fmt(refNow, cur())}`));
  } else {
    nowLine.textContent = "现价未知";
  }
  price.appendChild(nowLine);

  if (p.spent > 0 && refNow != null && refNow > 0) {
    const d = refNow - p.spent;
    const cls = Math.abs(d) < 0.01 ? "flat" : d > 0 ? "down" : "up";
    price.appendChild(el("div", "delta " + cls, Math.abs(d) < 0.01 ? "持平" : d > 0 ? `省 ${fmt(d, cur())}` : `多花 ${fmt(-d, cur())}`));
  }
  row.appendChild(price);
  wrap.appendChild(row);

  // 树形展开：优先展示「同命名空间」的附加内容（带缩略图与金额），否则退回商店描述里的内含清单
  if (canExpand) {
    const boxEl = el("div", "bundle-box");
    boxEl.hidden = true;

    if (family.length) {
      const hd = el("div", "bb-head");
      hd.innerHTML = `包含 <b>${family.length}</b> 项附加内容`;
      boxEl.appendChild(hd);
      for (const f of family) {
        boxEl.appendChild(
          childItem(
            f.name,
            f.grantedBy ? `随「${(f.grantedByName || "").slice(0, 16)}」获得` : KIND_LABEL[f.kind] || "",
            f.spent > 0 ? fmt(f.spent, cur()) : "—",
            f.image,
            f.kind,
          ),
        );
      }
    } else {
      const hd = el("div", "bb-head");
      hd.innerHTML = `当前包价 <b>${p.bundle.currentPrice ? fmt(p.bundle.currentPrice, cur()) : "—"}</b>
        内含单买合计 <b>${p.bundle.sumIndividualNow ? fmt(p.bundle.sumIndividualNow, cur()) : "—"}</b>
        ${p.bundle.savingsVsIndividual != null ? (p.bundle.savingsVsIndividual > 0 ? `买包省 <b>${fmt(p.bundle.savingsVsIndividual, cur())}</b>` : `单买省 <b>${fmt(-p.bundle.savingsVsIndividual, cur())}</b>`) : ""}`;
      boxEl.appendChild(hd);
      for (const it of bundleItems) {
        boxEl.appendChild(
          childItem(
            it.name,
            it.allocated != null ? `分摊 ${fmt(it.allocated, cur())}` : "",
            it.currentPrice ? fmt(it.currentPrice, cur()) : "—",
            null,
            null,
          ),
        );
      }
    }

    bindToggle(row, boxEl, expander, childCount);
    wrap.appendChild(boxEl);
  }
  return wrap;
}

/* ---------- 操作 ---------- */
async function doSync(withPrices) {
  const btn = $("btnSync");
  btn.disabled = true;
  try {
    const r = await api("/api/sync", { method: "POST", body: JSON.stringify({ withPrices }) });
    toast(`游戏同步完成：${r.purchased ?? r.count} 个`);
    await load();
  } catch (e) { toast("同步失败：" + e.message, 5000); }
  finally { btn.disabled = false; }
}
async function syncTx() {
  const btn = $("btnSyncTx");
  btn.disabled = true;
  toast("正在同步交易并更新商店现价，首次约 1-2 分钟…", 180000);
  try {
    const r = await api("/api/sync/transactions", { method: "POST", body: "{}" });
    const extra = r.priced ? ` / 现价 ${r.priced.updated} 个` : "";
    toast(`交易同步：${r.transactions} 条 / 付费 ${r.paid} 笔 / 合计 ${fmt(r.total, cur())}${extra}`, 6000);
    await load();
  } catch (e) { toast("同步交易失败：" + e.message, 7000); }
  finally { btn.disabled = false; }
}

async function refreshPrices() {
  const btn = $("btnRefreshPrices");
  if (!btn) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "更新中…";
  try {
    const r = await api("/api/prices/refresh", { method: "POST", body: "{}" });
    toast(`现价已更新：成功 ${r.added + r.skipped} 个，失败 ${r.failed} 个`, 5000);
    await load();
  } catch (e) {
    toast("更新失败：" + e.message, 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

async function doLogin() {
  const npsso = ($("npssoInput").value || "").trim();
  if (!npsso) return toast("请粘贴 npsso");
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ npsso }) });
    toast("登录成功");
    closeModal("loginModal");
    $("npssoInput").value = "";
    await load();
  } catch (e) { toast("登录失败：" + e.message, 5000); }
}
async function doLogout() {
  await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  toast("已清除令牌");
  closeModal("loginModal");
  await load();
}
function openSettings() {
  const s = STATE.settings || {};
  $("setCountry").value = s.country || "HK";
  $("setCurrency").value = s.currency || "HKD";
  $("setLang").value = s.lang || "zh";
  $("diagBox").innerHTML = "";
  $("diagBox").appendChild(el("p", "hint", `网页 Cookie：${STATE.hasCookies ? "已保存 ✅" : "未保存 ❌"}`));
  if (STATE.dataDir) {
    const d = el("p", "hint", "数据目录：" + STATE.dataDir);
    d.style.wordBreak = "break-all";
    $("diagBox").appendChild(d);
    $("diagBox").appendChild(el("p", "hint", "换版本或删掉程序文件夹都不会丢数据；备份就复制这个目录。"));
  }
  openModal("settingsModal");
}
async function saveSettings() {
  try {
    await api("/api/settings", { method: "PATCH", body: JSON.stringify({ country: $("setCountry").value, currency: $("setCurrency").value, lang: $("setLang").value }) });
    closeModal("settingsModal");
    toast("已保存");
    await load();
  } catch (e) { toast("保存失败：" + e.message); }
}

/* ---------- 价格历史 ---------- */
function nowOfProduct(p) {
  if (p.kind === "bundle" && p.bundle?.currentPrice) return p.bundle.currentPrice;
  if (p.currentPrice != null && p.currentPrice > 0) return p.currentPrice;
  return p.kind === "bundle" ? p.bundle?.currentPrice ?? null : null;
}

function lineChart(points) {
  const W = 680, H = 250, L = 54, R = 16, T = 18, B = 30;
  const max = Math.max(...points.map((p) => p.v), 1) * 1.15;
  const x = (i) => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = (v) => T + (1 - v / max) * (H - T - B);

  const root = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "hist-svg" });

  for (let i = 0; i <= 3; i++) {
    const v = (max * i) / 3;
    const yy = y(v);
    root.appendChild(svgEl("line", { x1: L, y1: yy, x2: W - R, y2: yy, stroke: "#ebebeb", "stroke-width": 1 }));
    const t = svgEl("text", { x: L - 8, y: yy + 3, "text-anchor": "end", fill: "#9a9a9a", "font-size": "10" });
    t.textContent = Math.round(v);
    root.appendChild(t);
  }

  if (points.length > 1) {
    const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    root.appendChild(svgEl("path", { d, fill: "none", stroke: "#111", "stroke-width": "1.8" }));
  }

  const low = Math.min(...points.map((p) => p.v));
  const ly = y(low);
  root.appendChild(svgEl("line", { x1: L, y1: ly, x2: W - R, y2: ly, stroke: "#e0301e", "stroke-width": 1, "stroke-dasharray": "4 3" }));

  points.forEach((p, i) => {
    const isBuy = p.src === "buy";
    const c = svgEl("circle", { cx: x(i), cy: y(p.v), r: isBuy ? 4.5 : 3.2, fill: isBuy ? "#e0301e" : "#111" });
    c.appendChild(svgEl("title")).textContent = `${p.d} · ${p.v}`;
    root.appendChild(c);
    const t = svgEl("text", { x: x(i), y: H - 10, "text-anchor": "middle", fill: "#9a9a9a", "font-size": "9" });
    t.textContent = p.d.slice(5);
    root.appendChild(t);
  });

  return root;
}

async function openHistory(p) {
  openModal("historyModal");
  $("histTitle").textContent = p.name || "价格历史";
  $("histStats").innerHTML = "";
  $("histNote").textContent = "";
  $("histChart").innerHTML = '<p class="hint">加载中…</p>';

  let raw = [];
  if (p.productId) {
    try {
      const r = await api("/api/price-history?productId=" + encodeURIComponent(p.productId));
      raw = r.points || [];
    } catch {}
  }

  // 快照点 + 购买点（同一天取较低价）
  const map = new Map();
  const add = (d, v, src) => {
    if (!d || v == null || !(v > 0)) return;
    const cur0 = map.get(d);
    if (!cur0 || v < cur0.v) map.set(d, { d, v, src });
  };
  for (const x of raw) add(x.d, x.p, "snap");
  for (const pu of p.purchases || []) add(pu.date, pu.price, "buy");

  const list = [...map.values()].sort((a, b) => a.d.localeCompare(b.d));
  const buyTotal = (p.purchases || []).reduce((s, x) => s + (Number(x.price) || 0), 0);
  const now = nowOfProduct(p);
  const low = list.length ? Math.min(...list.map((x) => x.v)) : null;

  const stats = $("histStats");
  const mk = (label, value) => {
    const d = el("div", "hs");
    d.appendChild(document.createTextNode(label));
    d.appendChild(el("b", null, value));
    stats.appendChild(d);
  };
  mk("史低", low != null ? fmt(low, cur()) : "—");
  mk("当前", now != null ? fmt(now, cur()) : "—");
  mk("你的买入", buyTotal > 0 ? fmt(buyTotal, cur()) : "—");
  mk("记录点", String(list.length));

  const box = $("histChart");
  box.innerHTML = "";
  if (!list.length) {
    box.appendChild(el("p", "hint", "还没有历史数据。服务端每天会自动记录一次，明天起就会累积。"));
    $("histNote").textContent = "红点 = 你的买入价；黑点 = 每日商店快照。";
    return;
  }
  box.appendChild(lineChart(list));
  $("histNote").textContent =
    "红点 = 你的买入价（当日实付）；黑点 = 每日商店快照；红色虚线 = 史低。" +
    (raw.length < 2 ? " 目前只有少量数据点，随着每日记录会自动补全。" : "");
}

/* ---------- 绑定 ---------- */
function bind() {
  $("btnSync").onclick = () => { if (!STATE.hasToken) return openModal("loginModal"); doSync(confirm("是否同时抓取商店现价？（较慢）")); };
  $("btnSyncTx").onclick = syncTx;
  $("btnSettings").onclick = openSettings;
  $("btnSaveSettings").onclick = saveSettings;
  const rp = $("btnRefreshPrices");
  if (rp) rp.onclick = refreshPrices;
  $("btnLogin").onclick = () => openModal("loginModal");
  $("btnDoLogin").onclick = doLogin;
  $("btnLogout").onclick = doLogout;
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => closeModal(b.getAttribute("data-close"))));
  document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; }));
}

bind();
load();
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
