// csv.mjs — 解析交易记录 CSV（兼容 PSN Export Transaction History 等导出文件）
// 特点：列名模糊匹配、金额/日期多格式容错、退款识别。

/** 标准 CSV 解析（支持引号、逗号、换行、转义双引号） */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      /* skip */
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}

const normKey = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[\s_\-()（）[\]【】:：]/g, "")
    .trim();

const COLUMN_HINTS = {
  name: ["名称", "游戏", "游戏名", "商品", "项目", "内容", "name", "title", "product", "productname", "item", "description", "game"],
  price: ["价格", "金额", "购入价", "实付", "付款金额", "交易金额", "总额", "amount", "price", "total", "cost", "charge", "paid", "value"],
  date: ["日期", "时间", "交易日期", "购买日期", "date", "datetime", "transactiondate", "purchasedate", "createdat", "time"],
  platform: ["平台", "设备", "platform", "device", "console"],
  currency: ["币种", "货币", "currency", "ccy"],
  type: ["类型", "交易类型", "type", "kind", "category"],
};

function scoreCell(headerCell, hints) {
  const h = normKey(headerCell);
  if (!h) return 0;
  let best = 0;
  for (const hint of hints) {
    const k = normKey(hint);
    if (!k) continue;
    if (h === k) return 3;
    if (h.includes(k) || k.includes(h)) best = Math.max(best, 2);
  }
  return best;
}

/** 根据首行表头推断列索引 */
export function detectHeader(rows) {
  if (!rows.length) return null;
  const first = rows[0];
  const mapping = {};
  let scores = 0;

  for (const [field, hints] of Object.entries(COLUMN_HINTS)) {
    let bestIdx = -1;
    let bestScore = 0;
    first.forEach((cell, idx) => {
      const sc = scoreCell(cell, hints);
      if (sc > bestScore) {
        bestScore = sc;
        bestIdx = idx;
      }
    });
    if (bestIdx >= 0 && bestScore >= 2) {
      mapping[field] = bestIdx;
      scores++;
    }
  }

  // 至少要识别出“名称 + 价格”或“名称 + 日期”，否则视为无表头
  if (mapping.name != null && (mapping.price != null || mapping.date != null)) {
    return { mapping, hasHeader: true, headerRow: first, score: scores };
  }
  return { mapping: {}, hasHeader: false, headerRow: first, score: scores };
}

/** 从任意金额字符串提取数值（去掉货币符号/千分位） */
export function parseAmount(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/free|免费/i.test(s)) return 0;
  const m = /-?[\d,]+(?:\.\d+)?/.exec(s.replace(/\s/g, ""));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** 日期归一化为 YYYY-MM-DD */
export function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // 2023-03-15 / 2023/03/15 / 2023.03.15 (+ 时间)
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // 15/03/2023
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return null;
}

function isRefund(row, typeIdx) {
  if (typeIdx == null) return false;
  const t = normKey(row[typeIdx]);
  return /refund|退款|取消|cancel/.test(t);
}

/**
 * 把 CSV 文本转成交易数组。
 * 返回 { transactions, skipped, hasHeader, mapping }
 */
export function csvToTransactions(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { transactions: [], skipped: 0, hasHeader: false, mapping: {} };

  const det = detectHeader(rows);
  const transactions = [];
  let skipped = 0;

  const pick = (row, idx) => (idx != null && idx < row.length ? row[idx] : undefined);

  if (det.hasHeader) {
    const { mapping } = det;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row.length) continue;
      const name = String(pick(row, mapping.name) ?? "").trim();
      if (!name) {
        skipped++;
        continue;
      }
      if (isRefund(row, mapping.type)) {
        skipped++;
        continue;
      }
      const rawPrice = parseAmount(pick(row, mapping.price));
      const price = rawPrice == null ? null : Math.abs(rawPrice);
      const date = parseDate(pick(row, mapping.date));
      if (price == null && !date) {
        skipped++;
        continue;
      }
      transactions.push({
        name,
        price,
        date,
        platform: String(pick(row, mapping.platform) ?? "").trim() || null,
        currency: String(pick(row, mapping.currency) ?? "").trim() || null,
      });
    }
    return { transactions, skipped, hasHeader: true, mapping: det.mapping };
  }

  // 无表头：按“含金额的列 + 最长的文本列”启发式识别
  for (const row of rows) {
    const cells = row.map((c) => String(c).trim());
    if (!cells.length) continue;

    let priceIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      if (/^[-+]?\s*(?:[A-Z]{2,3}\s*)?[¥$€£]?\s*[\d,]+(?:\.\d+)?$/.test(cells[i]) && cells[i].length <= 20) {
        priceIdx = i;
      }
    }
    let dateIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      if (parseDate(cells[i]) && /\d{4}|\d{1,2}[-/.]\d{1,2}/.test(cells[i])) {
        dateIdx = i;
        break;
      }
    }
    let nameIdx = -1;
    let bestLen = 0;
    for (let i = 0; i < cells.length; i++) {
      if (i === priceIdx || i === dateIdx) continue;
      if (cells[i].length > bestLen && !/^[-+]?[\d,.]+$/.test(cells[i])) {
        bestLen = cells[i].length;
        nameIdx = i;
      }
    }
    if (nameIdx < 0 || (priceIdx < 0 && dateIdx < 0)) {
      skipped++;
      continue;
    }
    const price = priceIdx >= 0 ? parseAmount(cells[priceIdx]) : null;
    transactions.push({
      name: cells[nameIdx],
      price: price == null ? null : Math.abs(price),
      date: dateIdx >= 0 ? parseDate(cells[dateIdx]) : null,
      platform: null,
      currency: null,
    });
  }

  return { transactions, skipped, hasHeader: false, mapping: {} };
}
