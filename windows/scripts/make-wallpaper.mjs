// Renders Nook's stage wallpapers (dev/stage/wallpaper-gen/) to JPEG with a locally installed
// Chrome or Edge in headless mode, over DevTools. No dependency, no network, no dev server: the
// generator page is opened straight from disk and drawn by the browser's software WebGL
// (SwiftShader), so the pixels do not depend on the GPU.
//
//   node scripts/make-wallpaper.mjs                       both themes into dev/stage/wallpapers/
//   node scripts/make-wallpaper.mjs --theme light --size 1920x1200 --out shots/wp.jpg
//
// Options: --theme dark|light (default both), --seed N (default 1), --size WxH (default 3840x2400),
// --quality 0..1 (default 0.9), --out FILE (one theme only), --browser EXE.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page = resolve(here, "../dev/stage/wallpaper-gen/index.html");
const outDir = resolve(here, "../dev/stage/wallpapers");

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? "" : null;
};
const fail = (msg) => {
  console.error(`make-wallpaper: ${msg}`);
  process.exit(1);
};

const themes = opt("--theme") ? [opt("--theme")] : ["dark", "light"];
if (themes.some((t) => t !== "dark" && t !== "light")) fail("--theme is dark or light");
const seed = Math.trunc(Number(opt("--seed") ?? 1)) || 1;
const size = (opt("--size") ?? "3840x2400").match(/^(\d+)x(\d+)$/i);
if (!size) fail("--size is WIDTHxHEIGHT");
const [W, H] = [Number(size[1]), Number(size[2])];
const quality = Number(opt("--quality") ?? 0.9);
const out = opt("--out");
if (out && themes.length > 1) fail("--out needs --theme");
if (typeof WebSocket !== "function") fail("needs Node 22 or newer (WebSocket)");

const candidates = [
  opt("--browser"),
  process.env.CHROME_PATH,
  ...["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].flatMap((v) => {
    const root = process.env[v];
    return root ? [join(root, "Google/Chrome/Application/chrome.exe"), join(root, "Microsoft/Edge/Application/msedge.exe")] : [];
  }),
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const browser = candidates.find((p) => existsSync(p));
if (!browser) fail("no Chrome or Edge found; pass --browser PATH or set CHROME_PATH");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function render(theme, file) {
  const profile = mkdtempSync(join(tmpdir(), "nook-wall-"));
  const child = spawn(browser, [
    "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    "--allow-file-access-from-files", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `--user-data-dir=${profile}`,
    "--remote-debugging-port=0", "about:blank",
  ], { stdio: "ignore" });
  try {
    let port = null;
    for (let i = 0; i < 150 && !port; i++) {
      await sleep(100);
      try {
        port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]) || null;
      } catch { /* not written yet */ }
    }
    if (!port) throw new Error("the browser did not start");
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("DevTools connection failed")); });
    let id = 0;
    const waiting = new Map();
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.id && waiting.has(m.id)) {
        const [ok, no] = waiting.get(m.id);
        waiting.delete(m.id);
        m.error ? no(new Error(m.error.message)) : ok(m.result);
      }
    };
    const send = (method, params = {}) => new Promise((ok, no) => { waiting.set(++id, [ok, no]); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

    const url = `${pathToFileURL(page).href}?theme=${theme}&seed=${seed}&w=${W}&h=${H}`;
    await send("Page.enable");
    await send("Page.navigate", { url });
    let state = null;
    for (let i = 0; i < 3000; i++) {
      await sleep(100);
      try {
        state = await evaluate("window.__wallpaper && { done: window.__wallpaper.done, error: window.__wallpaper.error }");
      } catch { /* mid-navigation */ }
      if (state?.done) break;
    }
    if (!state?.done) throw new Error("the page never finished drawing (5 min)");
    if (state.error) throw new Error(`the page failed: ${state.error}`);
    const data = await evaluate(`window.__wallpaper.jpeg(${quality})`);
    if (typeof data !== "string" || !data.startsWith("data:image/jpeg;base64,")) throw new Error("no JPEG came back");
    mkdirSync(dirname(file), { recursive: true });
    const bytes = Buffer.from(data.slice(data.indexOf(",") + 1), "base64");
    writeFileSync(file, bytes);
    console.log(`${file}  (${W}x${H}, ${(bytes.length / 1024).toFixed(0)} KB)`);
    ws.close();
  } finally {
    child.kill();
    await sleep(500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

for (const theme of themes) {
  await render(theme, resolve(out ?? join(outDir, `nook-${theme}.jpg`)));
}
