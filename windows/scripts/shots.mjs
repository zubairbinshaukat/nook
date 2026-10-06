// The screenshot pipeline for the website guides and the README: reads scripts/shots.json, captures every
// AUTO shot from the dev stage / the Settings fake page with a local Chrome or Edge (DevTools, Node's built-in
// WebSocket), encodes small WebP files through the browser itself and writes them to site/assets/img/shots/.
// No dependency, no network but the local dev server (reused when it answers, else started and stopped here).
//
//   npm run shots                           everything, dark and light
//   npm run shots -- --only hero,dock-left  some shots
//   npm run shots -- --theme light          one theme
//   npm run shots -- --125 --only hero      at Windows' 125 % scaling (files get a -125 suffix); --150, --200 too
//   npm run shots:check                     which files are there; MANUAL shots missing are listed with how to take them
//   npm run shots:list
//
// Flags: --list --only a,b --theme dark|light --size WxH --scale N (or --NNN) --out DIR --budget KB --quality N
//        --check --base-url URL --keep-server --browser EXE. See docs/screenshots.md.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const windowsDir = resolve(here, "..");
const repoRoot = resolve(windowsDir, "..");
const MANIFEST = join(here, "shots.json");
const appVersion = JSON.parse(readFileSync(join(windowsDir, "package.json"), "utf8")).version;
const DEFAULT_OUT = join(repoRoot, "site", "assets", "img", "shots");
const SHOT_TIMEOUT = 30_000;
const QUALITY_FLOOR = 70;
const QUALITY_STEP = 5;
const THEMES = ["dark", "light"];
const PAGES = { stage: "/dev/claude-preview.html", settings: "/dev/settings-frame.html", agents: "/agents.html" };

const fail = (msg) => {
  console.error(`shots: ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── Flags ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const val = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`${name} needs a value`);
  return v;
};
const known = new Set(["--list", "--only", "--theme", "--size", "--scale", "--out", "--budget", "--quality", "--check", "--base-url", "--keep-server", "--browser", "--help"]);
let scalePct = 100;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) {
    if (argv[i - 1] && known.has(argv[i - 1]) && !["--list", "--check", "--keep-server", "--help"].includes(argv[i - 1])) continue;
    fail(`unexpected argument "${a}"`);
  }
  if (/^--\d+$/.test(a)) scalePct = Number(a.slice(2));
  else if (!known.has(a)) fail(`unknown flag ${a}. Known: ${[...known].join(" ")} and --NNN (a Windows scaling in percent: --125)`);
}
if (has("--help")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 17).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}
if (val("--scale") !== null) scalePct = Number(val("--scale"));
if (!Number.isFinite(scalePct) || scalePct < 100 || scalePct > 300) fail(`the scaling must be 100..300 percent (got ${scalePct}); Windows offers up to 500 % but the stage stops at 300 %`);
if (scalePct > 200) console.warn(`shots: warning: ${scalePct} % makes very large files; the budget will push the quality down.`);
const scale = scalePct / 100;
const onlyIds = val("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const themeFlag = val("--theme");
if (themeFlag && !THEMES.includes(themeFlag)) fail(`--theme is dark or light (got "${themeFlag}")`);
const sizeFlag = val("--size");
if (sizeFlag && !/^\d{3,4}x\d{3,4}$/i.test(sizeFlag)) fail(`--size is WIDTHxHEIGHT, e.g. 1920x1080 (got "${sizeFlag}")`);
const outDir = resolve(val("--out") ?? DEFAULT_OUT);
const budgetFlag = val("--budget") === null ? null : Number(val("--budget"));
if (budgetFlag !== null && !(budgetFlag > 0)) fail("--budget is a number of KB");
const startQuality = Math.min(100, Math.max(QUALITY_FLOOR, Number(val("--quality") ?? 90) || 90));
const keepServer = has("--keep-server");
const baseFlag = (val("--base-url") ?? process.env.NOOK_DEV ?? "").replace(/\/$/, "");

// ── The manifest ─────────────────────────────────────────────────────────────

const SAFE = /^[a-z0-9][a-z0-9-]*$/;
const intOk = (n) => Number.isFinite(n) && n >= 0;

/** Reads and validates the manifest; every complaint names the entry. */
function loadManifest() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (e) {
    fail(`cannot read ${MANIFEST}: ${e.message}`);
  }
  const d = { size: "1920x1080", scale: 100, wallpaper: "nook", variants: THEMES, budgetKB: 150, ...(raw.defaults ?? {}) };
  const problems = [];
  const seen = new Set();
  const files = new Set();
  const shots = [];
  (raw.shots ?? []).forEach((s, n) => {
    const where = `shots[${n}]${s.id ? ` "${s.id}"` : ""}`;
    const bad = (m) => problems.push(`${where}: ${m}`);
    const e = { ...d, ...s };
    if (typeof e.id !== "string" || !SAFE.test(e.id)) bad(`id must be lowercase letters, digits and dashes (got ${JSON.stringify(e.id)})`);
    if (seen.has(e.id)) bad("id is not unique");
    seen.add(e.id);
    if (!["auto", "manual"].includes(e.kind)) bad(`kind must be "auto" or "manual" (got ${JSON.stringify(e.kind)})`);
    if (typeof e.out !== "string" || !SAFE.test(e.out)) bad(`out must be a safe file base name (got ${JSON.stringify(e.out)})`);
    if (!Array.isArray(e["used-in"]) || !e["used-in"].length || e["used-in"].some((u) => typeof u !== "string")) bad('"used-in" must be a non-empty list of pages');
    if (typeof e.alt !== "string" || e.alt.length < 8) bad("alt text is missing or too short");
    if (!/^\d{3,4}x\d{3,4}$/i.test(String(e.size))) bad(`size must be WxH (got ${JSON.stringify(e.size)})`);
    if (!Array.isArray(e.variants) || e.variants.some((v) => !THEMES.includes(v))) bad('variants must be a list of "dark"/"light" (or empty for a single file)');
    if (e.kind === "auto") {
      if (!(e.page in PAGES)) bad(`page must be one of ${Object.keys(PAGES).join(", ")} (got ${JSON.stringify(e.page)})`);
      if (!e.variants.length) bad("an auto shot needs at least one variant");
      if (!["nook", "bloom"].includes(e.wallpaper)) bad(`wallpaper must be nook or bloom (got ${JSON.stringify(e.wallpaper)})`);
      if (typeof e.params !== "string" && (typeof e.params !== "object" || e.params === null || Array.isArray(e.params))) bad("params must be an object or a query string");
      if (!(Number(e.scale) >= 100 && Number(e.scale) <= 300)) bad("scale is a percent, 100..300");
      const c = e.crop;
      if (c != null) {
        const okSel = typeof c.selector === "string" && c.selector && (c.pad === undefined || intOk(c.pad));
        const okBox = ["x", "y", "w", "h"].every((k) => intOk(c[k])) && c.w > 0 && c.h > 0;
        if (!okSel && !okBox) bad("crop is {selector, pad}, {x,y,w,h} or null");
      }
      if (!(e.budgetKB > 0)) bad("budgetKB must be a number");
      e.params = Object.fromEntries(new URLSearchParams(typeof e.params === "string" ? e.params.replace(/^\?/, "") : Object.entries(e.params).map(([k, v]) => [k, String(v)])));
    }
    for (const f of fileNames(e, 100)) {
      if (files.has(f)) bad(`output file ${f} collides with another entry`);
      files.add(f);
    }
    shots.push(e);
  });
  if (problems.length) fail(`${MANIFEST} has ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  return shots;
}

/** The files a shot makes: out-dark.webp, out-light.webp (a -125 suffix at 125 %), or out.webp without variants. */
function fileNames(e, pct) {
  const suffix = pct === 100 ? "" : `-${pct}`;
  return e.variants.length ? e.variants.map((v) => `${e.out}-${v}${suffix}.webp`) : [`${e.out}${suffix}.webp`];
}

const parseSize = (s) => String(s).toLowerCase().split("x").map(Number);

// ── Commands that need no browser ────────────────────────────────────────────

const all = loadManifest();
if (onlyIds) {
  const unknown = onlyIds.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length) fail(`unknown shot id(s): ${unknown.join(", ")}. Known: ${all.map((s) => s.id).join(", ")}`);
}
const selected = all.filter((s) => !onlyIds || onlyIds.includes(s.id));

if (has("--list")) {
  const row = (a) => a.map((c, i) => String(c).padEnd([24, 7, 9, 10, 10, 8][i] ?? 0)).join(" ");
  console.log(row(["id", "kind", "page", "size", "variants", "budget"]) + " used in");
  for (const s of selected) console.log(row([s.id, s.kind, s.page ?? "-", s.size, s.variants.join("+") || "-", s.kind === "auto" ? `${budgetFlag ?? s.budgetKB} KB` : "manual"]) + " " + s["used-in"].join(", "));
  const n = (k) => selected.filter((s) => s.kind === k).length;
  console.log(`\n${selected.length} shots: ${n("auto")} auto, ${n("manual")} manual`);
  process.exit(0);
}

if (has("--check")) {
  let missing = 0;
  for (const s of selected) {
    const gone = fileNames(s, s.kind === "auto" ? scalePct : 100).filter((f) => !existsSync(join(outDir, f)));
    if (!gone.length) continue;
    missing += gone.length;
    if (s.kind === "auto") {
      console.log(`MISSING (auto)   ${gone.join(", ")}   run: npm run shots -- --only ${s.id}`);
    } else {
      console.log(`MISSING (manual) ${gone.join(", ")}`);
      console.log(`    size:    ${s.size}${s.variants.length ? "  (one file per theme: " + s.variants.join(", ") + ")" : ""}`);
      console.log(`    capture: ${s.notes ?? s.alt}`);
      console.log(`    used in: ${s["used-in"].join(", ")}`);
    }
  }
  const total = selected.reduce((n, s) => n + fileNames(s, s.kind === "auto" ? scalePct : 100).length, 0);
  console.log(`\n${total - missing} of ${total} files present in ${relative(repoRoot, outDir) || outDir}${missing ? `, ${missing} missing` : ""}.`);
  process.exit(missing ? 1 : 0);
}

const toCapture = selected.filter((s) => s.kind === "auto");
if (!toCapture.length) fail("nothing to capture (the selection has only manual shots; see --check)");

// Microsoft's artwork may only be used for pictures that stay on this machine.
const inRepo = !relative(repoRoot, outDir).startsWith("..");
const bloom = toCapture.filter((s) => s.wallpaper === "bloom");
if (bloom.length && inRepo) fail(`${bloom.map((s) => s.id).join(", ")} use wallpaper "bloom" (Microsoft artwork, local only), but the output folder is inside the repo. Use wallpaper "nook", or --out a folder outside the repo.`);

// ── Browser and dev server ───────────────────────────────────────────────────

function findBrowser() {
  const roots = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].map((v) => process.env[v]).filter(Boolean);
  const candidates = [
    val("--browser"), process.env.CHROME_PATH,
    ...roots.flatMap((r) => [join(r, "Microsoft/Edge/Application/msedge.exe"), join(r, "Google/Chrome/Application/chrome.exe")]),
    "/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) fail(`no Edge or Chrome found. Tried:\n  ${candidates.join("\n  ")}\nPass --browser PATH or set CHROME_PATH.`);
  return found;
}

const freePort = () => new Promise((ok, no) => {
  const s = createServer();
  s.once("error", no);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
});

async function answers(base) {
  try {
    const res = await fetch(`${base}/dev/claude-preview.html`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

let server = null;
async function ensureServer() {
  const candidates = baseFlag ? [baseFlag] : ["http://127.0.0.1:1420"];
  for (const b of candidates) if (await answers(b)) { console.log(`dev server: reusing ${b}`); return b; }
  if (baseFlag) fail(`nothing answers at ${baseFlag}/dev/claude-preview.html (--base-url). Start the dev server there, or leave --base-url out and the script starts its own.`);
  const vite = join(windowsDir, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(vite)) fail(`vite is not installed (${vite}). Run "npm ci" in windows/ first.`);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`dev server: starting vite on ${base}`);
  let log = "";
  server = spawn(process.execPath, [vite, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: windowsDir, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (b) => { log += b; });
  server.stderr.on("data", (b) => { log += b; });
  let exited = false;
  server.on("exit", () => { exited = true; });
  for (let i = 0; i < 150; i++) {
    if (exited) fail(`vite exited early:\n${log.split("\n").slice(-8).join("\n")}`);
    if (await answers(base)) return base;
    await sleep(200);
  }
  fail(`vite did not answer on ${base} in 30 s:\n${log.split("\n").slice(-8).join("\n")}`);
}
function stopServer() {
  if (server && !keepServer) { try { server.kill(); } catch { /* gone */ } }
  else if (server) console.log(`dev server left running (--keep-server) on pid ${server.pid}`);
}

// ── DevTools ─────────────────────────────────────────────────────────────────

class Tab {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map(); this.problems = [];
    ws.onclose = () => { for (const [, [, no]] of this.waiting) no(new Error('the tab was closed (timeout?)')); this.waiting.clear(); };
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.id && this.waiting.has(m.id)) {
        const [ok, no] = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? no(new Error(m.error.message)) : ok(m.result);
      } else if (m.method === "Runtime.exceptionThrown") {
        const x = m.params.exceptionDetails;
        this.problems.push(x.exception?.description ?? x.text);
      } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        this.problems.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    };
  }
  send(method, params = {}) {
    return new Promise((ok, no) => { this.waiting.set(++this.id, [ok, no]); this.ws.send(JSON.stringify({ id: this.id, method, params })); });
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

async function startBrowser(exe) {
  const profile = mkdtempSync(join(tmpdir(), "nook-shots-"));
  const flags = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--force-color-profile=srgb", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"];
  const child = spawn(exe, flags, { stdio: "ignore" });
  let port = null;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(100);
    try { port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]) || null; } catch { /* not yet */ }
  }
  const stop = () => {
    child.kill();
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp: harmless */ }
  };
  if (!port) { stop(); fail(`the browser did not start (${exe})`); }
  return { port, stop };
}

/** One tab per shot: opened, driven, closed. */
async function withTab(port, fn) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("DevTools connection failed")); });
  const tab = new Tab(ws);
  try {
    await tab.send("Runtime.enable");
    await tab.send("Page.enable");
    return await fn(tab);
  } finally {
    try { ws.close(); } catch { /* closed */ }
    try { await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`); } catch { /* browser gone */ }
  }
}

/** webp width and height from the file's header (lossy, lossless and extended). */
function webpSize(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") throw new Error("the browser did not return a WebP");
  const kind = buf.toString("ascii", 12, 16);
  if (kind === "VP8X") return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (kind === "VP8 ") return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (kind === "VP8L") { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; }
  throw new Error(`unknown WebP chunk ${kind}`);
}

function urlFor(base, s, variant) {
  const p = new URLSearchParams();
  const [w, h] = parseSize(sizeFlag ?? s.size);
  const set = (k, v) => p.set(k, String(v));
  for (const [k, v] of Object.entries(s.params)) set(k, v);
  set("theme", variant);
  let viewport;
  if (s.page === "stage") {
    set("shot", 1); set("w", w); set("h", h); set("wallpaper", s.wallpaper);
    if (!p.has("time")) set("time", "10:09");
    if (!p.has("date")) set("date", "10/6/2026");
    if (!p.has("seed")) set("seed", 1);
    if (!p.has("motion")) set("motion", "reduce");
    if (scale !== 1) set("scale", scale);
    viewport = [w, h];
  } else if (s.page === "settings") {
    // The window is w x h; the frame adds a 32 px title bar and 56 px of shadow room all round.
    p.set("fake", "");
    set("size", `${w}x${h}`);
    set("version", appVersion); // the frame shows it as the fake About version
    if (s.frame === false) set("frame", 0);
    viewport = [w + 112 + 8, h + 32 + 112 + 8];
  } else {
    p.set("fake", "");
    viewport = [w, h];
  }
  return { url: `${base}${PAGES[s.page]}?${p.toString().replace(/fake=(&|$)/, "fake$1")}`, viewport };
}

/** True when two WebP files are the same size and differ by under 8/255 in all but a few pixels (compared in the page). */
async function looksSame(tab, a, b) {
  const expr = `(async () => {
    const load = async (b64) => { const bmp = await createImageBitmap(await (await fetch("data:image/webp;base64," + b64)).blob()); const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext("2d"); x.drawImage(bmp, 0, 0); return x.getImageData(0, 0, bmp.width, bmp.height); };
    const [p, q] = [await load(${JSON.stringify(a.toString("base64"))}), await load(${JSON.stringify(b.toString("base64"))})];
    if (p.width !== q.width || p.height !== q.height) return false;
    let bad = 0;
    for (let i = 0; i < p.data.length; i += 4) if (Math.abs(p.data[i] - q.data[i]) > 8 || Math.abs(p.data[i + 1] - q.data[i + 1]) > 8 || Math.abs(p.data[i + 2] - q.data[i + 2]) > 8 || Math.abs(p.data[i + 3] - q.data[i + 3]) > 8) bad++;
    return bad / (p.data.length / 4) < 0.0005;
  })()`;
  try { return (await tab.eval(expr, true)) === true; } catch { return false; }
}

/** Captures one shot variant to WebP bytes, searching the quality down to the budget. */
async function captureShot(port, base, s, variant, previous) {
  const { url, viewport } = urlFor(base, s, variant);
  const budget = (budgetFlag ?? s.budgetKB) * 1024;
  const transparent = s.page !== "stage" && s.frame !== false || s.transparent === true;
  return withTab(port, async (tab) => {
    const timer = setTimeout(() => tab.ws.close(), SHOT_TIMEOUT);
    try {
      await tab.send("Emulation.setDeviceMetricsOverride", { width: viewport[0], height: viewport[1], deviceScaleFactor: scale, mobile: false });
      if (transparent) await tab.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
      await tab.send("Page.navigate", { url });
      const t0 = Date.now();
      let ready = false;
      while (!ready) {
        if (Date.now() - t0 > SHOT_TIMEOUT - 2000) throw new Error(`the page never set window.__shotReady within ${SHOT_TIMEOUT / 1000} s: ${url}`);
        await sleep(100);
        try { ready = (await tab.eval("window.__shotReady === true")) === true; } catch { /* mid-navigation */ }
      }
      await tab.eval("document.fonts.ready.then(() => true)", true);
      // Still pictures: finite animations jump to their end, endless ones (breathing, glows) to their resting style.
      await tab.eval(`(() => { for (const a of document.getAnimations()) { try { a.effect.getComputedTiming().iterations === Infinity ? a.cancel() : a.finish(); } catch (e) {} } return true; })()`);
      await sleep(300);

      // The crop, in CSS px, clamped to the viewport.
      let clip = { x: 0, y: 0, width: viewport[0], height: viewport[1] };
      let crop = s.crop;
      if (!crop && s.page === "settings" && s.frame !== false) crop = { selector: "#frame", pad: 56 };
      if (crop) {
        let r;
        if (crop.selector) {
          r = await tab.eval(`(() => { const e = document.querySelector(${JSON.stringify(crop.selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
          if (!r) throw new Error(`crop selector "${crop.selector}" matches nothing on the page (shot "${s.id}", ${url})`);
          const pad = crop.pad ?? 0;
          r = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
        } else r = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
        const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
        const x1 = Math.min(viewport[0], Math.ceil(r.x + r.w)), y1 = Math.min(viewport[1], Math.ceil(r.y + r.h));
        if (x1 <= x0 || y1 <= y0) throw new Error(`crop of "${s.id}" lies outside the ${viewport.join("x")} viewport`);
        clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      }

      let best = null;
      const tried = [];
      for (let q = startQuality; q >= QUALITY_FLOOR; q -= QUALITY_STEP) {
        const { data } = await tab.send("Page.captureScreenshot", { format: "webp", quality: q, clip: { ...clip, scale: 1 }, captureBeyondViewport: false });
        best = { bytes: Buffer.from(data, "base64"), quality: q };
        tried.push(`${q}:${Math.round(best.bytes.length / 1024)}K`);
        if (best.bytes.length <= budget) break;
      }
      if (best.bytes.length > budget) console.warn(`\n!!! shots: ${s.id} (${variant}) is ${(best.bytes.length / 1024).toFixed(0)} KB, over its ${budget / 1024} KB budget even at quality ${best.quality} (${tried.join(" ")}). Crop it tighter or raise budgetKB.`);
      if (tab.problems.length) throw new Error(`page error(s) in ${s.id} (${variant}):\n    ${tab.problems.join("\n    ")}`);
      // An earlier file that looks the same (idle animations make the bytes differ run to run) is kept: stable git diffs.
      if (previous && !previous.equals(best.bytes) && (await looksSame(tab, previous, best.bytes))) best = { ...best, bytes: previous, kept: true };
      return best;
    } finally {
      clearTimeout(timer);
    }
  });
}

// ── Run ──────────────────────────────────────────────────────────────────────

const exe = findBrowser();
const base = await ensureServer();
const { port, stop } = await startBrowser(exe);
const results = [];
const errors = [];
let exitCode = 0;
try {
  mkdirSync(outDir, { recursive: true });
  const table = [];
  for (const s of toCapture) {
    for (const variant of s.variants) {
      if (themeFlag && variant !== themeFlag) continue;
      const file = fileNames({ ...s, variants: [variant] }, scalePct)[0];
      try {
        const path = join(outDir, file);
        const { bytes, quality } = await captureShot(port, base, s, variant, existsSync(path) ? readFileSync(path) : null);
        const [width, height] = webpSize(bytes);
        const same = existsSync(path) && readFileSync(path).equals(bytes);
        if (!same) writeFileSync(path, bytes);
        table.push([s.id, variant + (scalePct !== 100 ? `@${scalePct}` : ""), `${width}x${height}`, (bytes.length / 1024).toFixed(1), quality, same ? "same" : "written"]);
        results.push({ id: s.id, variant: variant || null, file, width, height, bytes: bytes.length, alt: s.alt, scale: scalePct });
      } catch (e) {
        errors.push(`${s.id} (${variant}): ${e.message}`);
        table.push([s.id, variant, "-", "-", "-", "FAILED"]);
        exitCode = 1;
      }
    }
  }
  const head = ["id", "variant", "WxH", "KB", "q", "file"];
  const rows = [head, ...table];
  const widths = head.map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  console.log("\n" + rows.map((r) => r.map((c, i) => (i >= 2 && i <= 4 ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join("  ")).join("\n"));
  const total = results.reduce((n, r) => n + r.bytes, 0);
  console.log(`\n${results.length} image(s), ${(total / 1024).toFixed(0)} KB (${(total / 1048576).toFixed(2)} MB) written to ${relative(repoRoot, outDir) || outDir}`);

  // shots.json next to the images: what the pages need for width/height/alt. Merged, so --only keeps the rest.
  const indexPath = join(outDir, "shots.json");
  let old = [];
  try { old = JSON.parse(readFileSync(indexPath, "utf8")); } catch { /* none yet */ }
  const ids = new Set(all.map((s) => s.id));
  const byFile = new Map(old.filter((o) => ids.has(o.id) && existsSync(join(outDir, o.file))).map((o) => [o.file, o]));
  for (const r of results) byFile.set(r.file, r);
  const merged = [...byFile.values()].map(({ scale: _s, ...o }) => o).sort((a, b) => a.file.localeCompare(b.file));
  const text = JSON.stringify(merged, null, 2) + "\n";
  if (!existsSync(indexPath) || readFileSync(indexPath, "utf8") !== text) writeFileSync(indexPath, text);
  if (errors.length) console.error(`\nshots: ${errors.length} failure(s):\n  ${errors.join("\n  ")}`);
} catch (e) {
  console.error(`shots: ${e.message}`);
  exitCode = 1;
} finally {
  stop();
  stopServer();
}
process.exit(exitCode);
