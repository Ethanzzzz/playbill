// capture-cookies.mjs — 从已开启调试端口的 Edge/Chrome 读取网页会话 Cookie，
// 并保存到本地服务（用于「同步交易记录」）。
//
// 前置：先以调试模式启动浏览器（关掉所有浏览器窗口后执行）：
//   Edge:   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
//   Chrome: "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
// 然后在浏览器里登录 store.playstation.com，再运行本脚本：
//   node tools/capture-cookies.mjs
//
// Cookie 只写入你自己电脑上的 server/data.json，不会外传。

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

const cookies = await getCookies();
const get = (n) => cookies.find((c) => c.name === n)?.value || "";
const npsso = get("npsso");
const pdccws = get("pdccws_p");

if (!npsso || !pdccws) {
  console.log("未找到所需 Cookie。请确认：");
  console.log("  1) 浏览器以 --remote-debugging-port=9222 启动");
  console.log("  2) 已在同一浏览器登录 store.playstation.com");
  console.log(`  当前找到的 Cookie：${cookies.map((c) => c.name).join(", ")}`);
  process.exit(1);
}

const r = await fetch(`${API}/api/cookies`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ npsso, pdccws_p: pdccws }),
});
console.log(r.ok ? "✅ Cookie 已保存，可以点「同步交易」了" : `❌ 保存失败：${r.status}`);
