// Draws the installer artwork of the NSIS package (header and sidebar bitmaps) with a locally
// installed Chrome or Edge in headless mode, over DevTools, then writes them as 24-bit
// uncompressed Windows BMPs (the only format NSIS reads). Dev-only: the BMPs are committed, CI does
// not run this. No dependency, no network.
//
//   node scripts/make-installer-art.mjs        writes src-tauri/nsis/header.bmp and sidebar.bmp
//   node scripts/make-installer-art.mjs --png  also writes header.png and sidebar.png next to them (to look at)
//
// header.bmp  150x57   right of the white header band of every wizard page, installer and uninstaller
// sidebar.bmp 164x314  left edge of the Welcome / Finish pages (and the uninstaller's)
// Sizes are fixed by NSIS; do not change them.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../src-tauri/nsis");
const icon = readFileSync(resolve(here, "../src-tauri/icons/128x128@2x.png")).toString("base64");
const wantPng = process.argv.includes("--png");
if (typeof WebSocket !== "function") throw new Error("needs Node 22 or newer (WebSocket)");

const candidates = [
  process.env.CHROME_PATH,
  ...["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].flatMap((v) => {
    const root = process.env[v];
    return root ? [join(root, "Google/Chrome/Application/chrome.exe"), join(root, "Microsoft/Edge/Application/msedge.exe")] : [];
  }),
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge",
];
const browser = candidates.find((p) => p && existsSync(p));
if (!browser) throw new Error("no Chrome or Edge found; set CHROME_PATH");

// Runs in the browser. Returns { header, sidebar } as base64 RGBA, plus PNG data URLs.
const drawing = `(async () => {
  const img = new Image();
  img.src = "data:image/png;base64,${icon}";
  await img.decode();
  const FONT = '700 34px "Bricolage Grotesque", "Segoe UI Variable Display", "Segoe UI", sans-serif';
  const make = (w, h, paint) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    paint(g, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    let bin = "";
    for (let i = 0; i < px.length; i += 8192) bin += String.fromCharCode(...px.subarray(i, i + 8192));
    return { rgba: btoa(bin), png: c.toDataURL("image/png") };
  };
  const header = make(150, 57, (g, w, h) => {
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h);
    // Soft mint glow behind the character, then the character on white.
    const glow = g.createRadialGradient(w / 2, h / 2 + 2, 2, w / 2, h / 2 + 2, 30);
    glow.addColorStop(0, "rgba(61,220,151,0.18)"); glow.addColorStop(1, "rgba(61,220,151,0)");
    g.fillStyle = glow; g.fillRect(0, 0, w, h);
    const s = 49;
    g.drawImage(img, (w - s) / 2, (h - s) / 2 + 1, s, s);
  });
  const sidebar = make(164, 314, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#10141a"); bg.addColorStop(1, "#0b0d10");
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    const glow = (x, y, r, rgb, a) => {
      const q = g.createRadialGradient(x, y, 0, x, y, r);
      q.addColorStop(0, "rgba(" + rgb + "," + a + ")"); q.addColorStop(1, "rgba(" + rgb + ",0)");
      g.fillStyle = q; g.fillRect(0, 0, w, h);
    };
    glow(w * 0.2, 70, 150, "90,169,255", 0.22);
    glow(w * 0.9, 150, 150, "169,139,250", 0.2);
    glow(w * 0.5, h, 170, "61,220,151", 0.22);
    // The island pill the app lives in, the character under it.
    g.fillStyle = "#000"; g.strokeStyle = "rgba(255,255,255,0.12)"; g.lineWidth = 1;
    g.beginPath(); g.roundRect(w / 2 - 38, 22, 76, 14, 7); g.fill(); g.stroke();
    g.fillStyle = "#3ddc97"; g.beginPath(); g.arc(w / 2 - 28, 29, 2.5, 0, 7); g.fill();
    g.fillStyle = "#5aa9ff"; g.beginPath(); g.arc(w / 2 - 20, 29, 2.5, 0, 7); g.fill();
    g.fillStyle = "#a98bfa"; g.beginPath(); g.arc(w / 2 - 12, 29, 2.5, 0, 7); g.fill();
    g.drawImage(img, w / 2 - 55, 62, 110, 110);
    g.fillStyle = "#ffffff"; g.font = FONT; g.textAlign = "center"; g.textBaseline = "alphabetic";
    g.fillText("Nook", w / 2, 218);
    g.fillStyle = "rgba(255,255,255,0.62)"; g.font = '400 11px "Segoe UI Variable Text", "Segoe UI", sans-serif';
    g.fillText("Claude Code sessions,", w / 2, 242);
    g.fillText("at the top of your screen", w / 2, 257);
    const bar = g.createLinearGradient(w / 2 - 24, 0, w / 2 + 24, 0);
    bar.addColorStop(0, "#3ddc97"); bar.addColorStop(0.5, "#5aa9ff"); bar.addColorStop(1, "#a98bfa");
    g.fillStyle = bar; g.fillRect(w / 2 - 24, 276, 48, 3);
  });
  await document.fonts.ready;
  return { header, sidebar };
})()`;

/** 24-bit uncompressed BMP (BITMAPINFOHEADER), bottom-up rows padded to 4 bytes, BGR. Alpha is flattened onto white. */
function bmp(w, h, rgba) {
  const stride = (w * 3 + 3) & ~3;
  const out = Buffer.alloc(54 + stride * h);
  out.write("BM", 0);
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(stride * h, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3] / 255;
      for (const c of [2, 1, 0]) out[o++] = Math.round(rgba[i + c] * a + 255 * (1 - a));
    }
  }
  return out;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const profile = mkdtempSync(join(tmpdir(), "nook-art-"));
const child = spawn(browser, [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
], { stdio: "ignore" });
try {
  let port = null;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(100);
    try { port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]) || null; } catch { /* not yet */ }
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
  const r = await send("Runtime.evaluate", { expression: drawing, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "the drawing failed");
  const { header, sidebar } = r.result.value;
  for (const [name, w, h, art] of [["header", 150, 57, header], ["sidebar", 164, 314, sidebar]]) {
    const file = join(outDir, `${name}.bmp`);
    writeFileSync(file, bmp(w, h, Buffer.from(art.rgba, "base64")));
    console.log(`${file}  (${w}x${h})`);
    if (wantPng) writeFileSync(join(outDir, `${name}.png`), Buffer.from(art.png.split(",")[1], "base64"));
  }
  ws.close();
} finally {
  child.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
