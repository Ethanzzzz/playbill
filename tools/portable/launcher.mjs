// launcher.mjs — PLAYBILL 启动器：检查端口、启动服务、自动开浏览器
import { spawn } from "node:child_process";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HTTP = `http://localhost:${PORT}`;
const HTTPS = `https://localhost:${PORT}`;
const NO_OPEN = process.env.NO_OPEN === "1";



function openBrowser(u) {
  if (NO_OPEN) return;
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", u], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [u], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [u], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* 打不开浏览器就让用户手动访问 */
  }
}

async function alive(u) {
  try {
    const r = await fetch(`${u}/api/state`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// HTTPS 用的是本机自签证书，这里只做端口探测，跳过校验即可
function aliveHttps(u) {
  return new Promise((resolve) => {
    const req = https.request(`${u}/api/state`, { method: "GET", rejectUnauthorized: false, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

// 服务可能在 HTTP 或 HTTPS 上（有证书就走 HTTPS），两个都探一下
async function runningUrl() {
  if (await aliveHttps(HTTPS)) return HTTPS;
  if (await alive(HTTP)) return HTTP;
  return null;
}

console.log("");
console.log("  ┌──────────────────────────────────────────┐");
console.log("  │        PLAYBILL · PSN 存档账单           │");
console.log("  └──────────────────────────────────────────┘");
console.log("");

const existing = await runningUrl();
if (existing) {
  console.log(`  程序已经在运行了，正在为你打开浏览器…`);
  console.log(`  地址：${existing}`);
  console.log("");
  openBrowser(existing);
  setTimeout(() => process.exit(0), 800);
} else {
  console.log(`  正在启动，请稍候…`);
  console.log("");
  console.log("  ↓ 下面出现 http(s)://localhost:" + PORT + " 就说明启动成功");
  console.log("  ↓ 想关闭程序：直接关掉这个窗口，或按 Ctrl + C");
  console.log("");

  const server = spawn(process.execPath, [path.join(HERE, "server", "index.mjs")], {
    stdio: "inherit",
    env: { ...process.env, PORT: String(PORT) },
  });

  // 等端口真的能响应再开浏览器，避免打开一个空白页
  (async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const u = await runningUrl();
      if (u) {
        openBrowser(u);
        return;
      }
    }
    openBrowser(HTTP);
  })();

  server.on("exit", (code) => {
    if (code && code !== 0) {
      console.log("");
      console.log("  启动失败。常见原因：");
      console.log(`  · 端口 ${PORT} 被别的程序占用了`);
      console.log("  · 试试换个端口：在命令行运行  set PORT=9000  再双击启动");
    }
    process.exit(code ?? 0);
  });
}
