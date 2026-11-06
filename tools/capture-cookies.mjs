// capture-cookies.mjs — 从已开启调试端口的 Edge/Chrome 读取网页会话 Cookie，
// 一次性拿到 npsso / pdccws_p 以及风控所需的其它 Cookie，并让本地服务自动完成登录。
//
// 前置：先双击「启动浏览器.bat」（或手动用 --remote-debugging-port=9222 启动浏览器），
//       在那个浏览器里登录 store.playstation.com，然后运行本脚本。
//
// Cookie 只写入你自己电脑上的数据目录，不会外传。
//
// 注意：程序在装了手机证书时走 HTTPS，没装时走 HTTP。本脚本会自己探测，两种都能连。

import http from "node:http";
import https from "node:https";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const PORT = process.env.PORT || "8787";

// 本机请求：自签证书要跳过校验；http / https 都支持
function rawRequest(base, pathname, { method = "GET", body = null, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + pathname);
    const mod = u.protocol === "https:" ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = mod.request(
      u,
      {
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": payload.length }
          : {},
        rejectUnauthorized: false, // 只连本机
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("连接超时")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 程序可能以 HTTP 或 HTTPS 启动，先探一下
async function findApi() {
  const candidates = [];
  if (process.env.APP_URL) candidates.push(process.env.APP_URL.replace(/\/+$/, ""));
  candidates.push(`https://127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}`);
  for (const base of candidates) {
    try {
      const r = await rawRequest(base, "/api/state", { timeout: 2500 });
      if (r.ok) return base;
    } catch {}
  }
  return null;
}

async function getCookies() {
  const ver = await (await fetch(`${CDP}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  let cr = await send("Storage.getCookies");
  if (!cr?.cookies) {
    await send("Network.enable");
    cr = await send("Network.getAllCookies");
  }
  ws.close();
  return cr?.cookies || [];
}

let cookies;
try {
  cookies = await getCookies();
} catch (e) {
  console.log("");
  console.log("❌ 连不上调试端口 127.0.0.1:9222");
  console.log("");
  console.log("   请先双击「启动浏览器.bat」，等 Edge 打开并登录 PSN，再运行本脚本。");
  console.log("   （错误：", e.message, "）");
  console.log("");
  process.exit(1);
}

const get = (n) => cookies.find((c) => c.name === n)?.value || "";
const npsso = get("npsso");
const pdccws = get("pdccws_p");

// 索尼域下所有 Cookie 一起带上（_abck / bm_sz 等风控 Cookie 少了会被 403）
const RELEVANT = /playstation\.com|sony\.com|np\.playstation/i;
const bundle = {};
for (const c of cookies) {
  if (!c.domain || !RELEVANT.test(c.domain)) continue;
  if (!c.value) continue;
  bundle[c.name] = c.value;
}

if (!npsso || !pdccws) {
  console.log("");
  console.log("❌ 没有找到需要的 Cookie");
  console.log("   npsso:      ", npsso ? "已拿到" : "缺失");
  console.log("   pdccws_p:   ", pdccws ? "已拿到" : "缺失");
  console.log("");
  console.log("   常见原因：还没在那个浏览器里登录 PSN。");
  console.log("   请打开 https://store.playstation.com 登录一次，并随便点开一个游戏页面，再运行本脚本。");
  console.log("");
  console.log("   当前浏览器里的 Cookie：", cookies.map((c) => c.name).join(", ").slice(0, 300));
  process.exit(1);
}

const api = await findApi();
if (!api) {
  console.log("");
  console.log("❌ 连不上程序（127.0.0.1:" + PORT + "）");
  console.log("");
  console.log("   请先双击「启动程序.bat」，等黑窗口里出现地址，再回来运行本脚本。");
  console.log("   如果程序已经开着，看看它显示的地址端口是不是 " + PORT + "。");
  console.log("");
  process.exit(1);
}
console.log("   程序地址： " + api);

let r;
try {
  r = await rawRequest(api, "/api/cookies", {
    method: "POST",
    body: { npsso, pdccws_p: pdccws, cookies: bundle },
    timeout: 30000,
  });
} catch (e) {
  console.log("");
  console.log("❌ 保存 Cookie 时连接中断：" + e.message);
  console.log("   程序可能刚好被关掉了。重新双击「启动程序.bat」后再运行本脚本。");
  console.log("");
  process.exit(1);
}
const data = r.json || {};

console.log("");
if (!r.ok) {
  console.log("❌ 保存失败：", data.error || r.status);
  process.exit(1);
}

console.log(`✅ 已保存 ${data.cookieCount || Object.keys(bundle).length} 个 Cookie（含风控 Cookie）`);
if (data.loggedIn) {
  console.log("✅ 已自动完成登录（不用再手动粘贴 npsso）");
} else if (data.loginError) {
  console.log("⚠️ 自动登录失败：", data.loginError);
  console.log("   可以在程序里点右上角头像，手动粘贴 npsso。");
} else {
  console.log("ℹ️ 检测到已有有效登录，直接刷新程序即可");
}

if (data.txOk) {
  console.log("✅ 交易接口验证通过，可以回程序点「同步交易」了");
} else if (/access denied|authoriz|401|403/i.test(String(data.txError || ""))) {
  console.log("");
  console.log("⚠️ 交易接口这次拒绝了（两种可能：会话被登出，或短时间调用太频繁）");
  console.log("   " + (data.txError || "未知错误"));
  console.log("");
  console.log("   常见触发：刚刚连续跑过价格更新、连点了几次同步，或这个会话被索尼登出了。");
  console.log("   处理：先等 5 分钟再抓一次；仍然失败就去浏览器重新登录，再跑本脚本。");
} else {
  console.log("");
  console.log("❌ 交易接口拒绝了这组 Cookie：");
  console.log("   " + (data.txError || "未知错误"));
  console.log("");
  console.log("   按顺序试：");
  console.log("   1) 在那个浏览器里打开 https://store.playstation.com ，确认右上角是你的头像");
  console.log("   2) 随便点开一个游戏详情页（让商店写入会话 Cookie）");
  console.log("   3) 重新运行本脚本");
  console.log("   4) 仍失败 → 关掉浏览器，重新双击「启动浏览器.bat」，等 1 分钟再试");
}
console.log("");
