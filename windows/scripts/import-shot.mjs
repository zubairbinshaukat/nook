// Imports a MANUAL screenshot (taken by hand) into the website: converts a PNG/JPEG/WebP to a small WebP with the
// local Edge or Chrome (DevTools, Node's built-in WebSocket; no dependency, no network), writes it to
// site/assets/img/shots/, updates that folder's shots.json and the manifest's recorded size.
//
//   npm run shots:import -- <image.png|jpg|webp> --id <manifest id> [--variant dark|light] [--width N]
//                           [--quality 90] [--budget KB] [--crop x,y,w,h] [--blur x,y,w,h]... [--force] [--browser EXE] [--out DIR]
//
// The aspect ratio is always kept; the manifest size is only a hint. A source wider than twice the manifest width
// is scaled down to that 2x width (high-quality smoothing), a smaller one keeps its native size; --width N sets the
// width by hand. --crop x,y,w,h cuts that rectangle (source pixels) out first, e.g. to leave out desktop around a\n// dialog; the width rules then apply to the cropped size.
// --blur x,y,w,h (repeatable) hides a private detail (a user name) under an irreversible 8 px mosaic; the numbers are SOURCE pixels, the
// same grid as --crop (blur is applied to the full source first, then the crop is cut). Quality starts at 90 and steps down by 5 to 70 until the file is under the budget (the manifest's
// budgetKB, 150 by default). Metadata is not carried over (the browser draws pixels only). See docs/screenshots.md.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const MANIFEST = join(here, "shots.json");
const QUALITY_FLOOR = 70;
const QUALITY_STEP = 5;
const THEMES = ["dark", "light"];

const fail = (msg) => {
  console.error(`shots:import: ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── Flags ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const valued = new Set(["--id", "--variant", "--width", "--quality", "--budget", "--crop", "--blur", "--browser", "--out"]);
const switches = new Set(["--force", "--help"]);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (valued.has(a)) {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) fail(`${a} needs a value`);
    if (a === "--blur") (flags.blurs ??= []).push(v);
    else flags[a] = v;
  } else if (switches.has(a)) flags[a] = true;
  else if (a.startsWith("--")) fail(`unknown flag ${a}. Known: ${[...valued, ...switches].join(" ")}`);
  else positional.push(a);
}
if (flags["--help"]) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 12).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}
if (positional.length !== 1) fail("give exactly one image file. Usage: npm run shots:import -- <image.png|jpg|webp> --id <manifest id> [--variant dark|light] [--width N] [--quality 90] [--budget KB] [--force]");
if (!flags["--id"]) fail("--id <manifest id> is required (see: npm run shots:list)");
const num = (name, min, max) => {
  if (flags[name] === undefined) return null;
  const n = Number(flags[name]);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${name} must be a number from ${min} to ${max} (got "${flags[name]}")`);
  return n;
};
const widthFlag = num("--width", 16, 8000);
const qualityStart = Math.min(100, Math.max(QUALITY_FLOOR, num("--quality", 1, 100) ?? 90));
const budgetFlag = num("--budget", 1, 100000);
const crop = flags["--crop"] === undefined ? null : flags["--crop"].split(",").map(Number);
if (crop && (crop.length !== 4 || crop.some((n) => !Number.isInteger(n) || n < 0) || crop[2] < 1 || crop[3] < 1)) fail(`--crop needs four whole numbers x,y,w,h (got "${flags["--crop"]}")`);
const blurs = (flags.blurs ?? []).map((s) => s.split(",").map(Number));
for (const [i, b] of blurs.entries()) if (b.length !== 4 || b.some((n) => !Number.isInteger(n) || n < 0) || b[2] < 1 || b[3] < 1) fail(`--blur needs four whole numbers x,y,w,h (got "${flags.blurs[i]}")`);
const outDir = resolve(flags["--out"] ?? join(repoRoot, "site", "assets", "img", "shots"));

// ── The manifest entry ───────────────────────────────────────────────────────

const manifestText = readFileSync(MANIFEST, "utf8");
let manifest;
try {
  manifest = JSON.parse(manifestText);
} catch (e) {
  fail(`cannot read ${MANIFEST}: ${e.message}`);
}
const shots = (manifest.shots ?? []).map((s) => ({ ...(manifest.defaults ?? {}), ...s }));
const entry = shots.find((s) => s.id === flags["--id"]);
if (!entry) {
  const manual = shots.filter((s) => s.kind === "manual").map((s) => s.id);
  fail(`unknown id "${flags["--id"]}". Manual shots: ${manual.join(", ")}`);
}
if (entry.kind !== "manual" && !flags["--force"]) fail(`"${entry.id}" is an AUTO shot: npm run shots -- --only ${entry.id} makes it. Use --force to import a file over it anyway.`);
const variants = entry.variants ?? [];
let variant = null;
if (variants.length) {
  variant = flags["--variant"];
  if (!variant) fail(`"${entry.id}" has one file per theme: add --variant ${variants.join("|")}`);
  if (!variants.includes(variant)) fail(`--variant must be one of ${variants.join(", ")} for "${entry.id}" (got "${variant}")`);
} else if (flags["--variant"]) {
  if (!THEMES.includes(flags["--variant"])) fail("--variant is dark or light");
  fail(`"${entry.id}" has a single file (variants: []), so --variant does not apply. Leave it out.`);
}
const fileName = `${entry.out}${variant ? `-${variant}` : ""}.webp`;
const budget = (budgetFlag ?? entry.budgetKB ?? 150) * 1024;
const [nomW] = String(entry.size).toLowerCase().split("x").map(Number);

// ── The source file ──────────────────────────────────────────────────────────

const src = resolve(positional[0]);
if (!existsSync(src) || !statSync(src).isFile()) fail(`file not found: ${src}`);
const bytesIn = readFileSync(src);
const kind = bytesIn.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png"
  : bytesIn[0] === 0xff && bytesIn[1] === 0xd8 && bytesIn[2] === 0xff ? "image/jpeg"
  : bytesIn.toString("ascii", 0, 4) === "RIFF" && bytesIn.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : null;
if (!kind) fail(`${basename(src)} is not a PNG, JPEG or WebP image (checked the file header, not the name)`);

// ── Browser ──────────────────────────────────────────────────────────────────

function findBrowser() {
  const roots = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].map((v) => process.env[v]).filter(Boolean);
  const candidates = [
    flags["--browser"], process.env.CHROME_PATH,
    ...roots.flatMap((r) => [join(r, "Microsoft/Edge/Application/msedge.exe"), join(r, "Google/Chrome/Application/chrome.exe")]),
    "/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) fail(`no Edge or Chrome found. Tried:\n  ${candidates.join("\n  ")}\nPass --browser PATH or set CHROME_PATH.`);
  return found;
}

async function startBrowser(exe) {
  const profile = mkdtempSync(join(tmpdir(), "nook-import-"));
  const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--force-color-profile=srgb", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"];
  const child = spawn(exe, args, { stdio: "ignore" });
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

/** Runs one async expression in a blank tab and returns its value. */
async function evalInTab(port, expression) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("DevTools connection failed")); });
  const timer = setTimeout(() => ws.close(), 60_000);
  try {
    return await new Promise((ok, no) => {
      ws.onclose = () => no(new Error("the tab closed before answering (timeout?)"));
      ws.onmessage = ({ data }) => {
        const m = JSON.parse(data);
        if (m.id !== 1) return;
        if (m.error) return no(new Error(m.error.message));
        if (m.result.exceptionDetails) return no(new Error(m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text));
        ok(m.result.result.value);
      };
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    clearTimeout(timer);
    try { ws.close(); } catch { /* closed */ }
    try { await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`); } catch { /* browser gone */ }
  }
}

/** webp width and height from the file's header (lossy, lossless and extended). */
function webpSize(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") throw new Error("the browser did not return a WebP");
  const k = buf.toString("ascii", 12, 16);
  if (k === "VP8X") return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (k === "VP8 ") return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (k === "VP8L") { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; }
  throw new Error(`unknown WebP chunk ${k}`);
}

// ── Convert ──────────────────────────────────────────────────────────────────

const exe = findBrowser();
const { port, stop } = await startBrowser(exe);
let out;
try {
  const expr = `(async () => {
    const bmp = await createImageBitmap(await (await fetch("data:${kind};base64,${bytesIn.toString("base64")}")).blob());
    const crop = ${JSON.stringify(crop)};
    if (crop && (crop[0] + crop[2] > bmp.width || crop[1] + crop[3] > bmp.height)) throw new Error("--crop is outside the image (" + bmp.width + "x" + bmp.height + ")");
    const blurs = ${JSON.stringify(blurs)};
    let source = bmp;
    if (blurs.length) {
      for (const b of blurs) if (b[0] + b[2] > bmp.width || b[1] + b[3] > bmp.height) throw new Error("--blur " + b.join(",") + " is outside the image (" + bmp.width + "x" + bmp.height + ")");
      const full = new OffscreenCanvas(bmp.width, bmp.height), fc = full.getContext("2d");
      fc.drawImage(bmp, 0, 0);
      const BLOCK = 8;
      for (const [bx, by, bw, bh] of blurs) {
        const tiny = new OffscreenCanvas(Math.ceil(bw / BLOCK), Math.ceil(bh / BLOCK)), tc = tiny.getContext("2d");
        tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = "high";
        tc.drawImage(full, bx, by, bw, bh, 0, 0, tiny.width, tiny.height);
        fc.save(); fc.beginPath(); fc.rect(bx, by, bw, bh); fc.clip();
        fc.imageSmoothingEnabled = false;
        fc.drawImage(tiny, 0, 0, tiny.width, tiny.height, bx, by, tiny.width * BLOCK, tiny.height * BLOCK);
        fc.restore();
      }
      source = full;
    }
    const [sx, sy] = crop ?? [0, 0];
    const nativeW = crop ? crop[2] : bmp.width, nativeH = crop ? crop[3] : bmp.height;
    const want = ${widthFlag ?? "null"} ?? (nativeW > ${nomW * 2} ? ${nomW * 2} : nativeW);
    const w = Math.max(1, Math.round(want)), h = Math.max(1, Math.round(nativeH * w / nativeW));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, sx, sy, nativeW, nativeH, 0, 0, w, h);
    const toB64 = (blob) => blob.arrayBuffer().then((ab) => { let s = ""; const u = new Uint8Array(ab); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); });
    let best = null; const tried = [];
    for (let q = ${qualityStart}; q >= ${QUALITY_FLOOR}; q -= ${QUALITY_STEP}) {
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: q / 100 });
      best = { q, size: blob.size, blob };
      tried.push(q + ":" + Math.round(blob.size / 1024) + "K");
      if (blob.size <= ${budget}) break;
    }
    return { nativeW, nativeH, w, h, q: best.q, tried, data: await toB64(best.blob) };
  })()`;
  out = await evalInTab(port, expr);
} catch (e) {
  fail(`the browser could not convert ${basename(src)}: ${e.message}`);
} finally {
  stop();
}

const bytes = Buffer.from(out.data, "base64");
const [width, height] = webpSize(bytes);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, fileName), bytes);

// ── shots.json next to the images (merged, sorted like shots.mjs does) ───────

const indexPath = join(outDir, "shots.json");
let list = [];
try { list = JSON.parse(readFileSync(indexPath, "utf8")); } catch { /* none yet */ }
list = list.filter((o) => o.file !== fileName);
list.push({ id: entry.id, variant, file: fileName, width, height, bytes: bytes.length, alt: entry.alt });
list.sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(indexPath, JSON.stringify(list, null, 2) + "\n");

// ── The manifest's recorded size: only the size field of this entry ──────────

const newSize = `${width}x${height}`;
let sizeNote = `manifest size already ${entry.size}`;
if (String(entry.size).toLowerCase() !== newSize) {
  const start = manifestText.indexOf(`"id": ${JSON.stringify(entry.id)}`);
  const re = /("size":\s*")[^"]*(")/g;
  re.lastIndex = start;
  const m = re.exec(manifestText);
  const next = manifestText.indexOf('"id":', start + 1);
  if (start < 0 || !m || (next > 0 && m.index > next)) {
    sizeNote = `manifest size NOT updated (the entry has no own "size" field; it inherits ${entry.size}). Add "size": "${newSize}" to it by hand.`;
  } else {
    writeFileSync(MANIFEST, manifestText.slice(0, m.index) + `${m[1]}${newSize}${m[2]}` + manifestText.slice(m.index + m[0].length));
    sizeNote = `manifest size ${entry.size} -> ${newSize}`;
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

const kb = (n) => (n / 1024).toFixed(1);
console.log(`${basename(src)}  ${out.nativeW}x${out.nativeH}  ${kb(bytesIn.length)} KB  ->  ${relative(repoRoot, join(outDir, fileName))}  ${width}x${height}  ${kb(bytes.length)} KB  (WebP q${out.q}; tried ${out.tried.join(" ")})`);
if (out.w !== out.nativeW) console.log(`scaled from ${out.nativeW} to ${out.w} px wide, aspect ratio kept`);
if (bytes.length > budget) console.warn(`\n!!! ${fileName} is ${kb(bytes.length)} KB, over its ${budget / 1024} KB budget even at quality ${out.q}. Crop it tighter or pass --budget.`);
console.log(sizeNote);

// Does every guide named in "used-in" already show the file?
const pages = [...new Set((entry["used-in"] ?? []).map((u) => u.split("#")[0]).filter((u) => u.startsWith("guides/")))];
const missing = pages.filter((p) => {
  const page = join(repoRoot, "site", p, "index.html");
  return !existsSync(page) || !readFileSync(page, "utf8").includes(`/assets/img/shots/${fileName}`);
});
if (missing.length) {
  const alt = entry.alt.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  console.log(`\nNot in ${missing.map((p) => `site/${p}/index.html`).join(", ")} yet. Replace the TODO comment or the "Screenshot coming" box there with:\n`);
  console.log(`<figure class="shot" data-shot="${entry.id}"><img class="shot-img" src="/assets/img/shots/${fileName}" width="${width}" height="${height}" alt="${alt}" loading="lazy" decoding="async"><figcaption>Say what the picture shows.</figcaption></figure>`);
  if (variants.length) console.log("\n(One file per theme: put both in a <div class=\"shot-pair\"> as .shot-dark and .shot-light images, like the Settings figures in guides/first-run.)");
}
