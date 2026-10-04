// Dev playground for Gullu's reaction layer (src/bot/reactions.ts): one large
// Gullu the real mouse drives, the same controller at the island's real sizes
// beside it, a button for every reaction, the status selector, the switches, a
// live read-out with a cost meter, a benchmark and film strips. Not part of the
// app bundle: `npx vite --port 1449`, then /dev/gullu-playground.html.
//
// The page is also the reference HOST of the controller: its frame loop stops
// when no controller is busy and one timer wakes it for the next thing due —
// the contract the island will follow (see the top of reactions.ts).
//
// Time here is the page's own (`setBotClock`): slowed by the speed control, and
// stepped by hand by `playground.run(seconds)`, `film()` and `bench()`, which
// draw their frames synchronously — a tab in the background gets none.

import { wipe } from "../src/core/canvas";
import { botGlowColor, botGlowOpacity, type BotStateName } from "../src/core/layout";
import { BOT_THEMES, BotEngine, setBotClock, type BotTheme } from "../src/bot/engine";
import { GulluReactions, REACTIONS, type ReactionName } from "../src/bot/reactions";

// ── The page's clock ──────────────────────────────────────────────────────────

let speed = 1;
/** Set while frames are stepped by hand: time is then exactly this. */
let manual: number | null = null;
let vBase = performance.now();
let rBase = performance.now();
const virtual = () => manual ?? vBase + (performance.now() - rBase) * speed;
function rebase(v = virtual()) {
  vBase = v;
  rBase = performance.now();
}
setBotClock(virtual);

/** The same dice for every bot, so that the same click gets the same answer at every size. */
function dice(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DPR = Math.min(2, window.devicePixelRatio || 1);
const STATES: BotStateName[] = [
  "idle", "working", "thinking", "question", "approval", "finished", "error", "ratelimit", "sleeping",
];
const THEMES = Object.keys(BOT_THEMES) as BotTheme[];

const $ = (id: string) => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

// ── The bots ──────────────────────────────────────────────────────────────────

interface Rig {
  /** The slot's diameter: what the island calls the bot's size. */
  d: number;
  /** The canvas, in CSS pixels: `d / 0.6` wide, and `overhang` taller. */
  size: number;
  overhang: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  slot: HTMLElement | null;
  glow: HTMLElement | null;
  engine: BotEngine;
  ctl: GulluReactions;
  dpr: number;
  cx: number;
  cy: number;
}

function rig(d: number, overhang: number, mini: boolean, dpr = DPR, seed = 7): Rig {
  // island.ts rounds its canvas to whole pixels; minibots.ts does not.
  const size = mini ? d / 0.6 : Math.round(d / 0.6);
  const canvas = el("canvas");
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round((size + overhang) * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size + overhang}px`;
  const engine = new BotEngine();
  engine.particleOverhang = overhang;
  // A mini here is one at rest, as a finished session's is in the app (see
  // restMiniBot): drawn small, but not `isMini`, which would breathe and wander
  // for ever and keep this page's loop from ever stopping.
  const ctl = new GulluReactions(engine);
  ctl.random = dice(seed);
  return { d, size, overhang, canvas, ctx: canvas.getContext("2d")!, slot: null, glow: null, engine, ctl, dpr, cx: 0, cy: 0 };
}

/** One frame of one bot: what the island's drawBot will do. Returns the script time it took, in ms. */
function paint(r: Rig, dt: number): number {
  const t0 = performance.now();
  r.ctl.update(dt);
  r.engine.update(dt);
  r.ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
  wipe(r.ctx);
  r.engine.draw(r.ctx, r.size, r.size + r.overhang);
  return performance.now() - t0;
}

const rigs: Rig[] = [];

function mount(parent: HTMLElement, d: number, overhang: number, mini: boolean, caption: string, glow: boolean, big = false): Rig {
  const r = rig(d, overhang, mini);
  const slot = el("div", "slot");
  slot.style.width = slot.style.height = `${r.size}px`;
  r.canvas.style.top = `${-overhang}px`;
  if (glow) {
    r.glow = el("div", "glow");
    r.glow.style.width = r.glow.style.height = `${d * 2.2}px`;
    r.glow.style.left = r.glow.style.top = `${r.size / 2 - d * 1.1}px`;
    slot.append(r.glow);
  }
  slot.append(r.canvas);
  r.slot = slot;
  const stage = el("div", big ? "stage big" : "stage");
  stage.style.paddingTop = `${overhang + 8}px`;
  stage.append(slot, el("small", "", caption));
  parent.append(stage);
  rigs.push(r);
  return r;
}

const big = mount($("stages"), 160, 120, false, "large · 160 px", true, true);
const reals = el("div");
reals.id = "reals";
$("stages").append(reals);
const row1 = el("div", "row");
const row2 = el("div", "row");
reals.append(row1, row2);
mount(row1, 58, 40, false, "island, open · 58 px", true);
mount(row1, 26, 40, false, "island, folded · 26 px", false);
mount(row2, 24, 0, true, "mini, pill · 24 px", false);
mount(row2, 13, 0, true, "mini, grid · 13 px", false);

function layout() {
  for (const r of rigs) {
    const b = r.slot!.getBoundingClientRect();
    r.cx = b.left + b.width / 2;
    r.cy = b.top + b.height / 2;
    r.ctl.place(r.cx, r.cy, r.d);
  }
}

// ── The host: a loop that stops, and one timer ────────────────────────────────

let running = false;
let last = 0;
let timer: number | null = null;
let framesDrawn = 0;
/** Script time of the last frames, for the large bot and the 58 px one. */
const costs: [number[], number[]] = [[], []];

const anyBusy = () => rigs.some((r) => r.ctl.busy);

function ensureRunning() {
  if (running || manual != null) return;
  running = true;
  last = performance.now();
  requestAnimationFrame(frame);
}

function arm() {
  if (timer != null) window.clearTimeout(timer);
  timer = null;
  let due = Number.POSITIVE_INFINITY;
  for (const r of rigs) due = Math.min(due, r.ctl.nextDue() ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(due)) return;
  timer = window.setTimeout(() => {
    timer = null;
    ensureRunning();
  }, Math.max(0, (due - virtual()) / speed) + 4);
}

function wake() {
  if (anyBusy()) ensureRunning();
  arm();
}

function step(dt: number) {
  rigs.forEach((r, i) => {
    const ms = paint(r, dt);
    if (i < 2) {
      costs[i].push(ms);
      if (costs[i].length > 90) costs[i].shift();
    }
  });
  framesDrawn += 1;
}

function frame(nowMs: number) {
  const dt = Math.min(0.05, (nowMs - last) / 1000) * speed;
  last = nowMs;
  step(dt);
  if (anyBusy()) requestAnimationFrame(frame);
  else {
    running = false;
    arm();
  }
}

// ── The pointer ───────────────────────────────────────────────────────────────

let mirror = true;
const mouse = { x: -1, y: -1, known: false };

/** Where the pointer is for a bot: itself — or, mirrored, where it is for the big one, at that bot's scale. */
function pointFor(r: Rig, x: number, y: number): [number, number] {
  if (!mirror || r === big) return [x, y];
  const k = r.d / big.d;
  return [r.cx + (x - big.cx) * k, r.cy + (y - big.cy) * k];
}

function pointer(x: number, y: number) {
  mouse.x = x;
  mouse.y = y;
  mouse.known = true;
  for (const r of rigs) {
    r.ctl.place(r.cx, r.cy, r.d);
    r.ctl.pointerMove(...pointFor(r, x, y));
  }
}

function pointerGone() {
  mouse.known = false;
  for (const r of rigs) r.ctl.pointerLeave();
}

function click(x: number, y: number) {
  for (const r of rigs) {
    const [px, py] = pointFor(r, x, y);
    if (r.ctl.hit(px, py)) r.ctl.click(px, py);
  }
}

window.addEventListener("mousemove", (e) => pointer(e.clientX, e.clientY));
document.addEventListener("mouseout", (e) => {
  if (e.relatedTarget == null) pointerGone();
});
window.addEventListener("mousedown", (e) => {
  if ((e.target as HTMLElement).closest("button")) return;
  click(e.clientX, e.clientY);
});
window.addEventListener("resize", layout);
window.addEventListener("scroll", layout, { passive: true });
document.addEventListener("visibilitychange", () => {
  // Hidden, nothing runs at all.
  for (const r of rigs) r.ctl.setVisible(!document.hidden);
});

// ── Buttons ───────────────────────────────────────────────────────────────────

let status: BotStateName = "idle";
let lastResult = "";
const cues: string[] = [];

function setStatus(next: BotStateName) {
  status = next;
  for (const r of rigs) {
    r.ctl.setStatus(next);
    if (r.glow) {
      r.glow.style.background = `radial-gradient(circle, ${botGlowColor(next)} 0%, transparent 62%)`;
      r.glow.style.opacity = String(botGlowOpacity(next));
    }
  }
  for (const btn of $("states").children) btn.classList.toggle("on", (btn as HTMLElement).dataset.state === next);
  wake();
}

function play(name: ReactionName): string {
  let res = "";
  for (const r of rigs) {
    const out = r.ctl.play(name);
    if (r === big) res = out;
  }
  lastResult = `${name}: ${res}`;
  wake();
  readout();
  return res;
}

for (const name of STATES) {
  const btn = el("button", "", name === "approval" ? "approval (needs you)" : name);
  btn.dataset.state = name;
  const swatch = el("i");
  swatch.style.setProperty("--c", botGlowColor(name));
  btn.prepend(swatch);
  btn.addEventListener("click", () => setStatus(name));
  $("states").append(btn);
}

const GROUPS: [string, [ReactionName, string][]][] = [
  ["g-mouse", [
    ["perk", "Cursor approaches · perk"], ["hoverHappy", "Hover 1.5 s · happy"], ["hearts", "Hover longer · hearts"],
    ["dizzy", "Circled fast · dizzy"], ["sigh", "Cursor leaves · look after + sigh"],
  ]],
  ["g-click", [
    ["surprised", "Surprised"], ["naughty", "Naughty"], ["ticklish", "Ticklish"], ["boop", "Boop"],
    ["annoyed", "3 fast clicks · annoyed"], ["dizzy", "5+ clicks · dizzy"],
    ["spin", "Rare · spin"], ["raspberry", "Rare · raspberry"],
  ]],
  ["g-idle", [
    ["lookAround", "Look around"], ["doubleBlink", "Double blink"], ["yawn", "Yawn"], ["sproutSway", "Sprout sway"],
    ["glance", "Glance at the cursor"], ["fallAsleep", "Fall asleep"], ["sleepBreath", "Breath, asleep"], ["wake", "Wake up"],
  ]],
];
for (const [id, list] of GROUPS) {
  for (const [name, label] of list) {
    const btn = el("button", name === "spin" || name === "raspberry" ? "rare" : "", label);
    btn.addEventListener("click", () => play(name));
    $(id).append(btn);
  }
}

function toggle(label: string, on: boolean, change: (on: boolean) => void): HTMLButtonElement {
  const btn = el("button", on ? "on" : "", label);
  btn.addEventListener("click", () => {
    change(btn.classList.toggle("on"));
    wake();
    readout();
  });
  $("switches").append(btn);
  return btn;
}

const playfulBtn = toggle("Playful reactions", true, (on) => { for (const r of rigs) r.ctl.playful = on; });
const reducedBtn = toggle("Reduced motion", false, (on) => { for (const r of rigs) r.ctl.reduceMotion = on ? true : null; });
toggle("Small ones mirror the pointer", true, (on) => { mirror = on; if (mouse.known) pointer(mouse.x, mouse.y); });
const slowBtn = toggle("Speed 0.25×", false, (on) => setSpeed(on ? 0.25 : 1));
toggle("Nap after 20 s (not 3 min)", false, (on) => { for (const r of rigs) r.ctl.napAfter = on ? 20 : 180; });
toggle("Idle every 3–5 s (not 10–20)", false, (on) => {
  for (const r of rigs) {
    r.ctl.idleEvery = on ? [3, 5] : [10, 20];
    r.ctl.setVisible(false); // …and back: the next one is drawn again from the new range
    r.ctl.setVisible(true);
  }
});

function setSpeed(next: number) {
  rebase();
  speed = next;
  slowBtn.classList.toggle("on", next !== 1);
}

function setTheme(next: BotTheme) {
  for (const r of rigs) r.engine.theme = next;
  for (const btn of $("themes").querySelectorAll<HTMLElement>("[data-theme]")) btn.classList.toggle("on", btn.dataset.theme === next);
  if (manual == null) {
    step(0);
    wake();
  }
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

// ── Read-out ──────────────────────────────────────────────────────────────────

let fpsFrames = 0;
let fpsAt = performance.now();
let fps = 0;

const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const row = (dt: string, dd: string, cls = "") => `<dt>${dt}</dt><dd class="${cls}">${dd}</dd>`;

function readout() {
  const nowR = performance.now();
  if (nowR - fpsAt >= 500) {
    fps = ((framesDrawn - fpsFrames) * 1000) / (nowR - fpsAt);
    fpsFrames = framesDrawn;
    fpsAt = nowR;
  }
  const c = big.ctl;
  const due = c.nextDue();
  const cool = Object.entries(c.cooldowns()).map(([k, s]) => `${k} ${s.toFixed(1)} s`).join(" · ") || "none";
  const busy = anyBusy();
  $("live").innerHTML =
    row("reaction", `<b>${c.reaction ?? "—"}</b>${c.napping ? " (asleep)" : ""}`) +
    row("status", `${status} · tier <b>${c.tier}</b>`) +
    row("cursor", mouse.known ? `zone <b>${c.zone}</b>` : "not on the page") +
    row("cooldowns", cool) +
    row("busy", busy ? "yes — the loop runs" : "no — the loop is stopped", busy ? "yes" : "no") +
    row("next due", due == null ? "nothing scheduled" : `in ${Math.max(0, (due - virtual()) / 1000).toFixed(1)} s (idle behaviour, hover or nap)`) +
    row("last button", lastResult || "—") +
    row("sound cues", cues.length ? cues.slice(-8).join(" · ") : "none yet");
  const m0 = mean(costs[0]);
  const m1 = mean(costs[1]);
  $("cost").innerHTML =
    row("frames drawn", `<b>${fps.toFixed(0)}</b> per second${running ? "" : " (loop stopped)"}`) +
    row("large, 160", `${m0.toFixed(3)} ms per frame`) +
    row("island, 58", `${m1.toFixed(3)} ms per frame`) +
    row("58 at 60 fps", `≈ ${((m1 * 60) / 10).toFixed(2)} % of one core (script only)`) +
    row("note", `update + draw of the last ${costs[1].length} frames; display scale ${DPR}`);
}

big.ctl.onCue = (cue) => {
  cues.push(cue);
  if (cues.length > 24) cues.shift();
};
for (const r of rigs) r.ctl.onChange = wake;
window.setInterval(readout, 200);

// ── Frames by hand ────────────────────────────────────────────────────────────

/**
 * Draws `seconds` of frames now, at `fps`, on a clock stepped by hand: what is
 * on the canvases afterwards is what a screenshot sees. For a tab in the
 * background, which gets no frame of its own.
 */
function run(seconds: number, fpsWanted = 60) {
  manual = virtual();
  const dt = 1 / fpsWanted;
  const n = Math.max(1, Math.round(seconds * fpsWanted));
  for (let i = 0; i < n; i++) {
    manual += dt * 1000;
    step(dt);
  }
  rebase(manual);
  manual = null;
  readout();
  wake();
  return info();
}

function info() {
  return {
    reaction: big.ctl.reaction, napping: big.ctl.napping, zone: big.ctl.zone, tier: big.ctl.tier,
    busy: rigs.map((r) => r.ctl.busy), engineBusy: rigs.map((r) => r.engine.busy),
    nextDueIn: big.ctl.nextDue() == null ? null : (big.ctl.nextDue()! - virtual()) / 1000,
    cooldowns: big.ctl.cooldowns(), cues: cues.slice(-10), lastResult, loopRunning: running,
  };
}

/** The resting pose's numbers, to check that a reaction comes back to it exactly. */
function pose(r: Rig = big) {
  const e = r.engine;
  return {
    oy: e.oy, ox: e.ox, sx: e.sx, sy: e.sy, tilt: e.tilt, es: e.es, blush: e.blush, lean: e.lean,
    spin: e.spin, tongue: e.tongue, poke: e.poke, sproutPerk: e.sproutPerk, sproutDroop: e.sproutDroop,
    sproutSwing: e.sproutSwing, sproutWiggle: e.sproutWiggle, sproutSpin: e.sproutSpin,
    lx: e.lx, ly: e.ly, eye: e.eyeOverride, mouth: e.mouthOverride, busy: r.ctl.busy,
  };
}

// ── Film strips ───────────────────────────────────────────────────────────────

const FILM_TIMES: Partial<Record<ReactionName, number[]>> = {
  perk: [0.06, 0.14, 0.3, 0.5, 1.4],
  hoverHappy: [0.15, 0.5, 1.2, 1.8, 2.9],
  hearts: [0.15, 0.5, 1.2, 2.0, 3.2],
  dizzy: [0.15, 0.8, 1.6, 2.5, 3.6],
  sigh: [0.3, 0.65, 0.98, 1.3, 2.4],
  surprised: [0.06, 0.14, 0.32, 0.6, 1.7],
  naughty: [0.1, 0.3, 0.45, 0.9, 2.0],
  ticklish: [0.08, 0.2, 0.42, 0.8, 2.0],
  boop: [0.06, 0.16, 0.3, 0.62, 1.7],
  annoyed: [0.07, 0.2, 0.45, 0.8, 1.9],
  spin: [0.16, 0.3, 0.44, 0.9, 2.1],
  raspberry: [0.15, 0.5, 0.9, 1.25, 2.3],
  lookAround: [0.5, 1.3, 1.95, 2.25, 3.2],
  doubleBlink: [0.06, 0.18, 0.32, 0.5, 1.5],
  yawn: [0.3, 0.6, 1.2, 1.6, 2.8],
  sproutSway: [0.35, 0.9, 1.5, 2.3, 3.5],
  glance: [0.2, 0.6, 1.0, 1.3, 2.4],
  fallAsleep: [0.5, 1.4, 2.8, 5, 8],
  sleepBreath: [0.3, 1.2, 1.8, 2.4, 3.4],
  wake: [0.12, 0.4, 0.7, 1.0, 2.2],
};

/**
 * A strip per reaction: five moments (start, peak, …, long after it is over)
 * at 80, 58 and 26 px, each drawn by a bot of its own on the stepped clock.
 */
function film(names: readonly ReactionName[] = REACTIONS, under: BotStateName = "idle", reduced = false, theme: BotTheme = big.engine.theme) {
  manual = virtual();
  const made: string[] = [];
  for (const name of names) {
    const times = FILM_TIMES[name] ?? [0.1, 0.3, 0.6, 1, 2];
    const sizes: [number, number][] = [[80, 60], [58, 40], [26, 40]];
    const actors = sizes.map(([d, overhang]) => rig(d, overhang, false));
    const tick = (seconds: number, each?: () => void) => {
      const n = Math.round(seconds * 60);
      for (let i = 0; i < n; i++) {
        manual! += 1000 / 60;
        for (const a of actors) paint(a, 1 / 60);
        each?.();
      }
    };
    let result = "";
    for (const a of actors) {
      a.engine.theme = theme;
      a.ctl.reduceMotion = reduced ? true : false;
      a.ctl.place(0, 0, a.d);
      a.ctl.setStatus(under);
    }
    tick(2.2);
    if (name === "glance") for (const a of actors) a.ctl.pointerMove(-900, -420);
    if (name === "sigh") for (const a of actors) a.ctl.pointerMove(-900, -200);
    if (name === "wake" || name === "sleepBreath") {
      for (const a of actors) a.ctl.play("fallAsleep");
      tick(8);
    }
    for (const a of [...actors].reverse()) result = a.ctl.play(name, a.d * 0.5, a.d * 0.05);

    const strip = el("div", "strip");
    const h = el("h3", "", name);
    h.append(el("span", "", `  · status ${under}${reduced ? " · reduced motion" : ""} · ${result}`));
    const cells = el("div", "cells");
    strip.append(h, cells);
    let at = 0;
    for (const t of times) {
      tick(t - at);
      at = t;
      const cell = el("div", "cell");
      const pair = el("div", "pair");
      actors.forEach((a, i) => {
        const shot = el("canvas");
        shot.width = a.canvas.width;
        shot.height = a.canvas.height;
        shot.style.width = a.canvas.style.width;
        shot.style.height = a.canvas.style.height;
        shot.getContext("2d")!.drawImage(a.canvas, 0, 0);
        if (i === 0) cell.append(shot);
        else pair.append(shot);
      });
      cell.append(pair, el("small", "", `${t.toFixed(2)} s${actors[0].ctl.busy ? "" : " · at rest"}`));
      cells.append(cell);
    }
    $("film").append(strip);
    made.push(`${name}: ${result}`);
  }
  rebase(manual);
  manual = null;
  wake();
  return made;
}

function clearFilm() {
  $("film").replaceChildren();
}

{
  const all = el("button", "", "Film every reaction (idle)");
  all.addEventListener("click", () => { clearFilm(); film(); });
  const alert = el("button", "", "…under needs-you");
  alert.addEventListener("click", () => { clearFilm(); film(REACTIONS, "approval"); });
  const err = el("button", "", "…under error");
  err.addEventListener("click", () => { clearFilm(); film(REACTIONS, "error"); });
  const calm = el("button", "", "…with reduced motion");
  calm.addEventListener("click", () => { clearFilm(); film(REACTIONS, "idle", true); });
  const clear = el("button", "", "Clear");
  clear.addEventListener("click", clearFilm);
  $("filmbtns").append(all, alert, err, calm, clear);
}

// ── Benchmark ─────────────────────────────────────────────────────────────────

interface BenchRow {
  what: string;
  /** Mean and worst script time of one frame (update + draw), in ms: [58 @1, 58 @1.25, 26 @1, 26 @1.25]. */
  mean: number[];
  worst: number[];
  /** Frames measured, per configuration (a reaction a small bot does not do is over at once). */
  frames: number[];
}

/**
 * Every reaction, `reps` times, off screen, at 58 and 26 px and at a display
 * scale of 1 and 1.25: the mean and the worst script time of a frame. With
 * `flush`, a pixel is read back after each frame, which makes the browser
 * rasterise it there and then instead of whenever it likes — an upper bound.
 */
function bench(reps = 3, flush = false) {
  const configs: [number, number][] = [[58, 1], [58, 1.25], [26, 1], [26, 1.25]];
  const cases: (ReactionName | "eyes + lean following" | "status working (looping)")[] = [
    ...REACTIONS, "eyes + lean following", "status working (looping)",
  ];
  const rows: BenchRow[] = [];
  manual = virtual();
  const tick = (a: Rig) => {
    manual! += 1000 / 60;
    const ms = paint(a, 1 / 60);
    if (flush) a.ctx.getImageData(0, 0, 1, 1);
    return ms;
  };
  for (const what of cases) {
    const res: BenchRow = { what, mean: [], worst: [], frames: [] };
    for (const [d, dpr] of configs) {
      let frames = 0;
      let total = 0;
      let worst = 0;
      for (let rep = 0; rep < reps; rep++) {
        const a = rig(d, 40, false, dpr, 7 + rep);
        a.ctl.reduceMotion = false;
        a.ctl.place(0, 0, d);
        a.ctl.setStatus(what === "status working (looping)" ? "working" : "idle");
        for (let i = 0; i < 100; i++) tick(a);
        let cap = 150;
        if (what === "eyes + lean following" || what === "status working (looping)") {
          /* measured as they are, for 150 frames */
        } else {
          if (what === "wake" || what === "sleepBreath") {
            a.ctl.play("fallAsleep");
            for (let i = 0; i < 480; i++) tick(a);
          }
          if (what === "glance" || what === "sigh") a.ctl.pointerMove(-900, -300);
          a.ctl.play(what, d * 0.5, 0);
          cap = 600;
        }
        const t0 = performance.now();
        let n = 0;
        while (n < cap) {
          if (what === "eyes + lean following") {
            const ang = n * 0.05;
            a.ctl.pointerMove(Math.cos(ang) * d * 2.4, Math.sin(ang) * d * 2.4);
          } else if (what !== "status working (looping)" && !a.ctl.reaction && n > 0) break;
          const s0 = performance.now();
          tick(a);
          worst = Math.max(worst, performance.now() - s0);
          n += 1;
        }
        total += performance.now() - t0;
        frames += n;
      }
      res.mean.push(total / Math.max(1, frames));
      res.worst.push(worst);
      res.frames.push(frames);
    }
    rows.push(res);
  }
  rebase(manual);
  manual = null;

  const all = (i: number) => rows.reduce((s, r) => s + r.mean[i] * r.frames[i], 0) / rows.reduce((s, r) => s + r.frames[i], 0);
  const summary = configs.map(([d, dpr], i) => {
    const m = all(i);
    const w = Math.max(...rows.map((r) => r.worst[i]));
    const heaviest = rows.filter((r) => r.frames[i] > 30).reduce((a, b) => (b.mean[i] > a.mean[i] ? b : a));
    return {
      size: d, dpr, meanMs: +m.toFixed(4), worstFrameMs: +w.toFixed(3),
      heaviest: heaviest.what, heaviestMeanMs: +heaviest.mean[i].toFixed(4),
      cpuAt30fps: +((m * 30) / 10).toFixed(2), cpuAt60fps: +((m * 60) / 10).toFixed(2),
      heaviestCpuAt60fps: +((heaviest.mean[i] * 60) / 10).toFixed(2),
    };
  });

  const head = `<tr><th>${flush ? "with read-back" : "script only"} · mean / worst ms</th>${configs.map(([d, dpr]) => `<th>${d} px @${dpr}</th>`).join("")}<th>% core at 60 fps (58 @1)</th></tr>`;
  const body = rows.map((r) =>
    `<tr><td>${r.what}</td>${r.mean.map((m, i) => `<td>${m.toFixed(3)} / ${r.worst[i].toFixed(2)}</td>`).join("")}<td>${((r.mean[0] * 60) / 10).toFixed(2)}</td></tr>`).join("");
  const foot = `<tr><td><b>all reactions</b></td>${summary.map((s) => `<td><b>${s.meanMs.toFixed(3)} / ${s.worstFrameMs.toFixed(2)}</b></td>`).join("")}<td><b>${summary[0].cpuAt60fps.toFixed(2)}</b></td></tr>`;
  $("bench").innerHTML = `<table>${head}${body}${foot}</table>
    <div id="benchnote">CPU share = ms per frame × fps ÷ 10, in % of one core: at 58 px @1, ${summary[0].cpuAt30fps} % at 30 fps and ${summary[0].cpuAt60fps} % at 60 fps while a reaction plays, and nothing at rest.
    This is the script's cost only (update + draw). Compositing the island's transparent window is extra, and can only be measured in the real app.
    The browser's clock has a resolution of about 0.1 ms: the means are of whole runs and are sound; a "worst" frame is to the nearest 0.1 ms.</div>`;
  wake();
  return { flush, reps, summary, rows: rows.map((r) => ({ what: r.what, frames: r.frames, mean: r.mean.map((v) => +v.toFixed(4)), worst: r.worst.map((v) => +v.toFixed(3)) })) };
}

$("runbench").addEventListener("click", () => bench());

// ── For a console, or a script driving the page ───────────────────────────────

Object.assign(window, {
  playground: {
    run, bench, film, clearFilm, info, pose, play, rigs,
    status: setStatus,
    theme: setTheme,
    speed: setSpeed,
    /** The pointer, `dx`,`dy` pixels from the middle of the big Gullu. */
    point: (dx: number, dy: number) => { layout(); pointer(big.cx + dx, big.cy + dy); },
    leave: pointerGone,
    click: (dx = 0, dy = 0) => { layout(); click(big.cx + dx, big.cy + dy); wake(); },
    playful: (on: boolean) => { for (const r of rigs) r.ctl.playful = on; playfulBtn.classList.toggle("on", on); wake(); },
    reduced: (on: boolean) => { for (const r of rigs) r.ctl.reduceMotion = on ? true : null; reducedBtn.classList.toggle("on", on); wake(); },
    napAfter: (s: number) => { for (const r of rigs) r.ctl.napAfter = s; wake(); },
  },
});

layout();
setStatus("idle");
setTheme("cream");
readout();
ensureRunning();
