// Dev harness: the real BotEngine on a plain dark page, at the sizes the island
// draws it — large, the open island's, the folded island's, and the two minis —
// with a button for every state, every emote and every body theme. To compare by eye with
// design/prototype/nook-buddy.html. Not part of the app bundle. `npm run dev`,
// then /dev/bot-preview.html.
//
// The frame loop below never stops: it is this page's, not the island's. The
// line under the buttons says what the island's loop would do in its place.
// `preview.run(seconds)` draws frames without it, for a tab in the background.

import { wipe } from "../src/core/canvas";
import { botGlowColor, botGlowOpacity, type BotEmoteName, type BotStateName } from "../src/core/layout";
import { BOT_STATES, BOT_THEMES, BotEngine, EMOTES, hexToRGB, type BotTheme, type RGB } from "../src/bot/engine";
import { createFreeBot, tickMiniBots } from "../src/bot/minibots";

/** As in island.ts: room above the body for what flies out of it. */
const OVERHANG = 40;
const DPR = Math.min(2, window.devicePixelRatio || 1);

const STATES = Object.keys(BOT_STATES) as BotStateName[];
const EMOTE_NAMES = Object.keys(EMOTES) as BotEmoteName[];
const THEMES = Object.keys(BOT_THEMES) as BotTheme[];

const $ = (id: string) => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

// ── The bots ──────────────────────────────────────────────────────────────────

interface Big {
  engine: BotEngine;
  canvas: HTMLCanvasElement;
  slot: HTMLElement;
  glow: HTMLElement;
  /** Canvas width in CSS pixels: the island's `diameter / 0.6`. */
  size: number;
}

const bigs: Big[] = [];
const engines: BotEngine[] = [];
/** The minis, each with the pill colour it is dyed in. */
const minions: { engine: BotEngine; color: RGB }[] = [];
let state: BotStateName = "idle";

/** A bot drawn the way island.ts draws its own: a slot of `diameter`, a canvas of `diameter / 0.6`. */
function big(diameter: number, caption: string) {
  const size = Math.round(diameter / 0.6);
  const height = size + OVERHANG;
  const slot = el("div", "slot");
  slot.style.width = `${size}px`;
  slot.style.height = `${size}px`;

  const glow = el("div", "glow");
  glow.style.width = glow.style.height = `${diameter * 2.2}px`;
  glow.style.left = glow.style.top = `${size / 2 - diameter * 1.1}px`;

  const canvas = el("canvas");
  canvas.width = Math.round(size * DPR);
  canvas.height = Math.round(height * DPR);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${height}px`;
  canvas.style.left = "0";
  canvas.style.top = `${-OVERHANG}px`;
  slot.append(glow, canvas);

  const engine = new BotEngine();
  engine.particleOverhang = OVERHANG;
  engine.onDizzy = dizzy;
  slot.addEventListener("mousedown", () => engine.slap());

  const stage = el("div", "stage");
  stage.style.paddingTop = `${OVERHANG}px`;
  stage.append(slot, el("small", "", `${caption} · ${diameter} px slot, ${size} px canvas`));
  $("stages").append(stage);
  bigs.push({ engine, canvas, slot, glow, size });
  engines.push(engine);
}

/** The minis as minibots.ts mounts them, ticked by its own tickMiniBots. */
function minis(bodySize: number, caption: string) {
  const row = el("div", "minis");
  for (const color of ["#E86A6A", "#3E86E0", "#EFAE5A", "#8C73F2"]) {
    const bot = createFreeBot(color, state, bodySize);
    row.append(bot.el);
    engines.push(bot.engine);
    minions.push({ engine: bot.engine, color: hexToRGB(color) });
  }
  const stage = el("div", "stage");
  stage.append(row, el("small", "", `${caption} · ${bodySize} px slot, ${(bodySize / 0.6).toFixed(1)} px canvas`));
  $("stages").append(stage);
}

big(120, "large");
big(58, "island, open");
big(20, "island, folded");
minis(24, "mini, pill");
minis(13, "mini, grid");

// ── Buttons ───────────────────────────────────────────────────────────────────

function setState(next: BotStateName) {
  state = next;
  for (const engine of engines) engine.setState(next);
  for (const b of bigs) {
    b.glow.style.background = `radial-gradient(circle, ${botGlowColor(next)} 0%, transparent 62%)`;
    b.glow.style.opacity = String(botGlowOpacity(next));
  }
  for (const btn of $("states").children) btn.classList.toggle("on", (btn as HTMLElement).dataset.state === next);
}

for (const name of STATES) {
  const btn = el("button", "", name);
  btn.dataset.state = name;
  const swatch = el("i");
  swatch.style.setProperty("--c", botGlowColor(name));
  btn.prepend(swatch);
  btn.addEventListener("click", () => setState(name));
  $("states").append(btn);
}

for (const name of EMOTE_NAMES) {
  const face = EMOTES[name];
  const btn = el("button", "", `${name} · ${face.eye}, ${face.mouth}${face.brow ? `, ${face.brow}` : ""}`);
  btn.addEventListener("click", () => {
    for (const engine of engines) engine.triggerEmote(name);
  });
  $("emotes").append(btn);
}

// The body's theme — the preview's only: the app has no setting for it.
function setTheme(next: BotTheme) {
  for (const engine of engines) engine.theme = next;
  for (const btn of $("themes").querySelectorAll<HTMLElement>("[data-theme]")) btn.classList.toggle("on", btn.dataset.theme === next);
}

for (const name of THEMES) {
  const theme = BOT_THEMES[name];
  const btn = el("button", "", theme.label);
  btn.dataset.theme = name;
  const swatch = el("i");
  swatch.style.background = `linear-gradient(135deg, ${theme.a}, ${theme.b})`;
  btn.prepend(swatch);
  btn.addEventListener("click", () => setTheme(name));
  $("themes").append(btn);
}

/** The minis in their pills' colours, as the island has them, or in the theme's plush. */
const dyed = el("button", "on", "minis in their pills' colours");
dyed.addEventListener("click", () => {
  const on = dyed.classList.toggle("on");
  for (const m of minions) m.engine.bodyColor = on ? m.color : null;
});
$("themes").append(dyed);

/** Three slaps, as Island.handleDizzy has it: dizzy for 3.3 s, then back, happy. */
let recovery: number | null = null;
function dizzy() {
  const before = state === "dizzy" ? "idle" : state;
  setState("dizzy");
  if (recovery != null) window.clearTimeout(recovery);
  recovery = window.setTimeout(() => {
    recovery = null;
    setState(before);
    for (const b of bigs) b.engine.triggerEmote("happy");
  }, 3300);
}

// ── Frame loop (this page's only) ─────────────────────────────────────────────

const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
window.addEventListener("mousemove", (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
});

let last = performance.now();
function frame(nowMs: number) {
  step(Math.min(0.05, (nowMs - last) / 1000));
  last = nowMs;
  requestAnimationFrame(frame);
}

/**
 * A tab in the background gets no frames. `preview.run(1.5)` from the console
 * (or a script driving the page) draws them itself for that long, without
 * waiting for any: what is on the canvases afterwards is what a screenshot sees.
 */
function run(seconds: number) {
  const end = performance.now() + seconds * 1000;
  let at = performance.now();
  while (at < end) {
    const nowMs = performance.now();
    if (nowMs - at < 16) continue;
    step(Math.min(0.05, (nowMs - at) / 1000));
    at = nowMs;
  }
  return $("loop").textContent;
}
Object.assign(window, { preview: { run } });

function step(dt: number) {

  for (const b of bigs) {
    const r = b.slot.getBoundingClientRect();
    // island.ts lookX / lookY
    b.engine.lookX = Math.tanh((mouse.x - (r.left + r.width / 2)) / 260);
    b.engine.lookY = -Math.tanh((mouse.y - (r.top + r.height / 2)) / 200);
    b.engine.update(dt);
    const ctx = b.canvas.getContext("2d");
    if (!ctx) continue;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    wipe(ctx);
    b.engine.draw(ctx, b.size, b.size + OVERHANG);
  }
  tickMiniBots(dt);

  const verdict = `State <b>${state}</b> — the island's frame loop would ${
    bigs[0].engine.busy ? "<b>keep running</b> (engine.busy)" : "<b>stop</b> here: nothing moves until something happens"
  }.`;
  if (verdict !== shown) {
    shown = verdict;
    $("loop").innerHTML = verdict;
  }
}
let shown = "";

setState("idle");
setTheme("cream");
requestAnimationFrame(frame);
