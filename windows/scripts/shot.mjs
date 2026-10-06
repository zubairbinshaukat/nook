// Captures the screenshot stage (dev/claude-preview.html) to a PNG with a locally
// installed Chrome or Edge in headless mode, once the page says `window.__shotReady`.
// No dependency, no network but the local dev server (`npm run dev`, port 1420).
//
//   node scripts/shot.mjs "scene=browser&home=4" --size 1920x1080 --out shots/browser.png
//   node scripts/shot.mjs "http://127.0.0.1:1420/dev/claude-preview.html?home=4&dock=left"
//   node scripts/shot.mjs --set                 every shot of SET below, into shots/
//   node scripts/shot.mjs --set hero,approval   only those
//
// The first argument is a full URL or just the query ("scene=desktop&theme=light"):
// `shot=1` is added (unless the query says shot=), and so are `w` and `h` to match --size. Options:
//   --size WxH     window and stage size (default 1920x1080)
//   --out FILE     the PNG (default shots/shot.png); with --set, a folder (default shots/)
//   --dpr N        device pixel ratio of the PNG, 2 for a sharp 3840x2160 (default 1)
//   --cli          the plain headless CLI with a virtual-time budget instead of DevTools (less exact; needs no Node 22)
//   --budget MS    with --cli: the virtual time given to the page to settle (default 8000)
//   --base URL     the dev server (default http://127.0.0.1:1420, or $NOOK_DEV)
//   --transparent  keep the page transparent (with scene=none&bg=transparent)
//   --browser EXE  chrome.exe or msedge.exe, if not in the usual places
//   --list         print SET and quit

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The README / guides set. Each entry is a query; the stage's defaults are dark, desktop, top dock. */
const SET = {
  "hero-dark": "home=3&tools=claude,claude,cursor&names=web,api,docs&scale=1.25&theme=dark",
  "hero-light": "home=3&tools=claude,claude,cursor&names=web,api,docs&scale=1.25&theme=light",
  "dock-bottom": "home=4&dock=bottom&theme=light",
  "dock-left": "home=4&dock=left&theme=dark",
  "dock-right": "home=4&dock=right&theme=dark",
  "over-browser-tabs": "home=4&scene=browser&theme=light",
  "over-editor": "view=approval&scene=editor&theme=dark",
  "over-terminal": "view=session&scene=terminal&theme=dark",
  approval: "view=approval&theme=dark",
  "approval-diff": "view=approval&diff=1&theme=light",
  question: "view=question&theme=dark",
  session: "view=session&theme=dark",
  home: "home=4&decision=1&theme=dark",
  shelf: "home=4&tab=shelf&theme=dark",
  "folded-metrics": "home=4&fold=1&theme=dark",
  "folded-metrics-light": "home=4&fold=1&theme=light",
  agents: "view=session&subagents=1&ask=none&theme=dark",
};

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "";
  args.splice(i, v === "" ? 1 : 2);
  return v;
};
const fail = (msg) => {
  console.error(`shot: ${msg}`);
  process.exit(1);
};

if (flag("--list") !== null) {
  for (const [name, q] of Object.entries(SET)) console.log(`${name.padEnd(22)} ${q}`);
  process.exit(0);
}

const size = (flag("--size") ?? "1920x1080").match(/^(\d+)x(\d+)$/i);
if (!size) fail("--size is WIDTHxHEIGHT, e.g. 1920x1080");
const [W, H] = [Number(size[1]), Number(size[2])];
const out = flag("--out");
const dpr = Number(flag("--dpr") ?? 1) || 1;
const budget = Number(flag("--budget") ?? 8000) || 8000;
const base = (flag("--base") ?? process.env.NOOK_DEV ?? "http://127.0.0.1:1420").replace(/\/$/, "");
const transparent = flag("--transparent") !== null;
const cli = flag("--cli") !== null;
const browserArg = flag("--browser");
const set = flag("--set");
const target = args.find((a) => !a.startsWith("--")) ?? null;
if (set === null && target === null) fail("give a URL or a query (scene=browser&home=4), or --set. See the top of scripts/shot.mjs.");

const candidates = [
  browserArg,
  process.env.CHROME_PATH,
  ...["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].flatMap((v) => {
    const root = process.env[v];
    return root
      ? [join(root, "Google/Chrome/Application/chrome.exe"), join(root, "Microsoft/Edge/Application/msedge.exe")]
      : [];
  }),
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const browser = candidates.find((p) => existsSync(p));
if (!browser) fail(`no Chrome or Edge found. Tried:\n  ${candidates.join("\n  ")}\nPass --browser PATH or set CHROME_PATH.`);

try {
  const res = await fetch(`${base}/dev/claude-preview.html`);
  if (!res.ok) throw new Error(String(res.status));
} catch {
  fail(`the dev server does not answer at ${base}. Start it (npm run dev, from windows/), or pass --base.`);
}

function urlFor(spec) {
  const u = /^https?:\/\//.test(spec)
    ? new URL(spec)
    : new URL(`${base}/dev/claude-preview.html?${spec.replace(/^\?/, "")}`);
  if (!u.searchParams.has("shot")) u.searchParams.set("shot", "1");
  if (!u.searchParams.has("w")) u.searchParams.set("w", String(W));
  if (!u.searchParams.has("h")) u.searchParams.set("h", String(H));
  return u.href;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const baseFlags = (profile) => [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `--user-data-dir=${profile}`,
];

/** The plain CLI: a virtual-time budget, then a screenshot. Less exact (the island's springs run on frames), so it is the fallback. */
function captureCli(url, file) {
  const profile = mkdtempSync(join(tmpdir(), "nook-shot-"));
  const flags = [
    ...baseFlags(profile), `--window-size=${W},${H}`, `--force-device-scale-factor=${dpr}`,
    `--virtual-time-budget=${budget}`, `--screenshot=${file}`,
    ...(transparent ? ["--default-background-color=00000000"] : []),
    url,
  ];
  const run = spawnSync(browser, flags, { encoding: "utf8", timeout: 90_000 });
  rmSync(profile, { recursive: true, force: true });
  if (!existsSync(file) || statSync(file).size === 0) {
    fail(`the browser wrote no screenshot for ${url}\n${(run.stderr || "").split("\n").slice(-6).join("\n")}`);
  }
}

/** The DevTools protocol over the WebSocket Node ships (22+): waits for the page's `__shotReady`, then captures. */
async function captureCdp(url, file) {
  const profile = mkdtempSync(join(tmpdir(), "nook-shot-"));
  const child = spawn(browser, [...baseFlags(profile), "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  const done = () => {
    child.kill();
    setTimeout(() => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 500).unref();
  };
  try {
    let port = null;
    for (let i = 0; i < 150 && !port; i++) {
      await sleep(100);
      try {
        port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]) || null;
      } catch { /* not written yet */ }
    }
    if (!port) throw new Error("the browser did not start");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("the browser has no page");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("DevTools connection failed")); });
    let id = 0;
    const waiting = new Map();
    const problems = [];
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.id && waiting.has(m.id)) {
        const [ok, no] = waiting.get(m.id);
        waiting.delete(m.id);
        m.error ? no(new Error(m.error.message)) : ok(m.result);
      } else if (m.method === "Runtime.exceptionThrown") {
        problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        problems.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    };
    const send = (method, params = {}) => new Promise((ok, no) => { waiting.set(++id, [ok, no]); ws.send(JSON.stringify({ id, method, params })); });

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: dpr, mobile: false });
    if (transparent) await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    await send("Page.navigate", { url });

    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      await sleep(100);
      try {
        ready = (await send("Runtime.evaluate", { expression: "window.__shotReady === true", returnByValue: true })).result.value === true;
      } catch { /* mid-navigation */ }
    }
    if (!ready) console.error(`shot: ${url} never said it was ready (20 s); captured anyway.`);
    await sleep(250);
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(file, Buffer.from(data, "base64"));
    for (const p of problems) console.error(`shot: page error: ${p}`);
    ws.close();
  } finally {
    done();
  }
}

async function capture(url, file) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) rmSync(file);
  if (cli || typeof WebSocket !== "function") captureCli(url, file);
  else await captureCdp(url, file);
  console.log(`${file}  (${W}x${H}${dpr !== 1 ? ` @${dpr}x` : ""})`);
}
if (set !== null) {
  const dir = resolve(out ?? "shots");
  const names = set ? set.split(",") : Object.keys(SET);
  for (const name of names) {
    if (!(name in SET)) fail(`unknown shot "${name}". Known: ${Object.keys(SET).join(", ")}`);
    await capture(urlFor(SET[name]), join(dir, `${name}.png`));
  }
} else {
  await capture(urlFor(target), resolve(out ?? "shots/shot.png"));
}
