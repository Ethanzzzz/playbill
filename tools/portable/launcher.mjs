// launcher.mjs — 绿色版启动器：检查端口、启动服务、自动开浏览器
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const URL = `http://localhost:${PORT}`;
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

async function alreadyRunning() {
  try {
    const r = await fetch(`${URL}/api/state`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

console.log("");
console.log("  ┌──────────────────────────────────────────┐");
console.log("  │        PSN 收藏档案 · 本地版             │");
console.log("  └──────────────────────────────────────────┘");
console.log("");

if (await alreadyRunning()) {
  console.log(`  程序已经在运行了，正在为你打开浏览器…`);
  console.log(`  地址：${URL}`);
  console.log("");
  openBrowser(URL);
  setTimeout(() => process.exit(0), 800);
} else {
  console.log(`  正在启动，请稍候…`);
  console.log(`  地址：${URL}`);
  console.log("");
  console.log("  ↓ 下面出现 http://localhost:" + PORT + " 就说明启动成功");
  console.log("  ↓ 想关闭程序：直接关掉这个窗口，或按 Ctrl + C");
  console.log("");

  const server = spawn(process.execPath, [path.join(HERE, "server", "index.mjs")], {
    stdio: "inherit",
    env: { ...process.env, PORT: String(PORT) },
  });

  setTimeout(() => openBrowser(URL), 1600);

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
