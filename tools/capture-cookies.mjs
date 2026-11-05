// capture-cookies.mjs — 从已开启调试端口的 Edge/Chrome 读取网页会话 Cookie，
// 一次性拿到 npsso 与 pdccws_p，并让本地服务自动完成登录。
//
// 前置：先双击「启动浏览器.bat」（或手动用 --remote-debugging-port=9222 启动浏览器），
//       在那个浏览器里登录 store.playstation.com，然后运行本脚本。
//
// Cookie 只写入你自己电脑上的数据目录，不会外传。

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const API = process.env.APP_URL || "http://127.0.0.1:8787";

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

if (!npsso || !pdccws) {
  console.log("");
  console.log("❌ 没有找到需要的 Cookie");
  console.log("   npsso:      ", npsso ? "已拿到" : "缺失");
  console.log("   pdccws_p:   ", pdccws ? "已拿到" : "缺失");
  console.log("");
  console.log("   常见原因：还没在那个浏览器里登录 PSN。");
  console.log("   请打开 https://store.playstation.com 登录一次，再运行本脚本。");
  console.log("");
  console.log("   当前浏览器里的 Cookie：", cookies.map((c) => c.name).join(", ").slice(0, 300));
  process.exit(1);
}

const r = await fetch(`${API}/api/cookies`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ npsso, pdccws_p: pdccws }),
});
const data = await r.json().catch(() => ({}));

console.log("");
if (!r.ok) {
  console.log("❌ 保存失败：", data.error || r.status);
  process.exit(1);
}

console.log("✅ npsso 与 pdccws_p 已保存");
if (data.loggedIn) {
  console.log("✅ 已自动完成登录（不用再手动粘贴 npsso）");
} else if (data.loginError) {
  console.log("⚠️ 自动登录失败：", data.loginError);
  console.log("   可以在程序里点右上角头像，手动粘贴 npsso。");
} else {
  console.log("ℹ️ 检测到已有有效登录，直接刷新程序即可");
}
console.log("");
console.log("下一步：回到程序，点「同步交易」。");
console.log("");
