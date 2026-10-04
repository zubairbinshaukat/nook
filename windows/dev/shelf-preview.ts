// Dev harness: the planned Shelf (plans/tabs-plan.md) on fake data, to review
// by eye before any of it goes into the app. Two tabs, swipe detection, the
// row of small working widgets and its reorder, each widget's expanded view
// and the morph between the two sizes, an agent alert over a widget, reduced
// motion. Not part of the app bundle and nothing in src/ knows about it. From
// windows/: `npx vite --port 1437`, then /dev/shelf-preview.html.
//
// What is real: the island's styles (src/style.css), its spring (core/anim.ts),
// its sizes (core/layout.ts) and the bots (bot/engine.ts, bot/minibots.ts).
// What is fake: every piece of data, and the buttons that would launch
// something. The camera is the browser's own, behind "Turn camera on".

import { wipe } from "../src/core/canvas";
import { Spring, Tracked, closeCurve, clamp } from "../src/core/anim";
import {
  EXPANDED_W, PANEL_H, PANEL_W, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, washRGBA,
  type BotStateName,
} from "../src/core/layout";
import { BotEngine } from "../src/bot/engine";
import { createFreeBot, tickMiniBots } from "../src/bot/minibots";
import { h, svg, clear, dot } from "../src/views/dom";
import { ICONS } from "../src/views/icons";

import {
  WIDGETS, launch, loadHidden, loadOrder, mediaToggle, onChange, resetOrder, saveHidden, saveOrder,
  timer, timerStart, timerToggle, todo, toggleTodo,
  type WidgetId,
} from "./preview-c/model";
import { SwipeDetector } from "./preview-c/swipe";
import { TAP_SLOP, enableGestures } from "./preview-c/gestures";
import { camera, liveTracks, startCamera, stopCamera } from "./preview-c/camera";
import { CONTROL, buildWidgets, mirrorVideo } from "./preview-c/widgets";

// ── Sizes ─────────────────────────────────────────────────────────────────────

/** The native window: as wide as today's, tall enough for Mirror and the glow under it. */
const WINDOW_W = PANEL_W;
const WINDOW_H = WIDGETS.mirror.h + 40;

type Tab = "home" | "shelf";
type AlertKind = "permission" | "question";
type ViewKey = Tab | "focus" | "alert";

const TAB_SIZE: Record<Tab, { w: number; h: number }> = {
  home: { w: EXPANDED_W, h: VIEW_LAYOUTS.overview.height },
  // 44 px taller than Home: a small card holds three lines and a field under its header.
  shelf: { w: EXPANDED_W, h: 204 },
};
/** A small card's width (shelf.css has the same number) and the gap between two. */
const CARD_W = 180;
const CARD_GAP = 8;
const ALL = Object.keys(WIDGETS) as WidgetId[];
const ALERT_SIZE: Record<AlertKind, { w: number; h: number }> = {
  // The app's approval card is 160; with a "Back to …" action beside Deny / Allow the
  // lines need the 16 px more that the Shelf's row has.
  permission: { w: EXPANDED_W, h: VIEW_LAYOUTS.approval.height + 16 },
  question: { w: EXPANDED_W, h: VIEW_LAYOUTS.question.height },
};

const LONG_PRESS_MS = 350;
const DPR = Math.min(2, window.devicePixelRatio || 1);
/** Room above a bot's body for what flies out of it (island.ts has 40; the cards here are low). */
const OVERHANG = 24;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const root = document.documentElement;

// ── State ─────────────────────────────────────────────────────────────────────

let tab: Tab = "shelf";
let focus: WidgetId | null = null;
let alert: AlertKind | null = null;
let order = loadOrder();
const hidden = loadHidden();

let forceReduced = false;
let forceFallback = false;
const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const reducedMotion = () => forceReduced || reducedQuery.matches;

const viewKey = (): ViewKey => (alert ? "alert" : focus ? "focus" : tab);
const targetSize = () => (alert ? ALERT_SIZE[alert] : focus ? WIDGETS[focus] : TAB_SIZE[tab]);

// ── The island's spring, as a CSS easing ──────────────────────────────────────
// The shared-element transition is drawn by the browser, which wants an easing
// function, not a spring. The spring of core/anim.ts (response 0.5, damping
// 0.72) is run once here from 0 to 1 and written out as a `linear()` easing,
// so the island grows into a widget exactly as it grows between views today.

const springCurve = (() => {
  const spring = new Spring(0);
  spring.target = 1;
  const step = 1 / 120;
  const samples = [0];
  let t = 0;
  while (t < 1.5) {
    spring.step(step);
    t += step;
    samples.push(spring.value);
    if (Math.abs(1 - spring.value) < 0.0015 && Math.abs(spring.velocity) < 0.02) break;
  }
  samples[samples.length - 1] = 1;
  const ease = (p: number) => {
    const at = clamp(p, 0, 1) * (samples.length - 1);
    const i = Math.floor(at);
    const next = samples[Math.min(samples.length - 1, i + 1)];
    return samples[i] + (next - samples[i]) * (at - i);
  };
  return { ms: Math.round(t * 1000), css: `linear(${samples.map((v) => v.toFixed(4)).join(", ")})`, ease };
})();
root.style.setProperty("--vt-spring", springCurve.css);
root.style.setProperty("--vt-spring-ms", `${springCurve.ms}ms`);
const BACK_MS = 340; // Tracked.curveTowards' own duration

// ── Elements ──────────────────────────────────────────────────────────────────

const windowEl = $("window");
const wrap = $("island-wrap");
const island = $("island");
const content = $("content");
const header = $("header");
const views = $("views");

windowEl.style.width = `${WINDOW_W}px`;
windowEl.style.height = `${WINDOW_H}px`;
$("window-label").textContent =
  `native window · ${WINDOW_W} × ${WINDOW_H} · never resized (today's is ${PANEL_W} × ${PANEL_H})`;

// The top bar
const SHELF_ICON = "M4 4.5h7v6.5H4zM13 4.5h7v6.5h-7zM4 13h7v6.5H4zM13 13h7v6.5h-7z";
const EXPAND_ICON = "M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7";

const tabButtons: Record<Tab, HTMLElement> = {
  home: h("button", { class: "tab named", title: "Home (agents)", onclick: () => setTab("home") },
    svg(ICONS.house, 13), "Home"),
  shelf: h("button", { class: "tab named", title: "Shelf (widgets)", onclick: () => setTab("shelf") },
    svg(SHELF_ICON, 13), "Shelf"),
};
header.append(
  h("div", { class: "tabs" },
    tabButtons.home, tabButtons.shelf,
    h("span", { class: "tab-slot", title: "Reserved slot" })),
  h("div", { class: "header-actions" },
    h("button", { title: "Expand (inert in this preview)" }, svg(EXPAND_ICON, 14, { stroke: 2.2 })),
    h("button", { title: "Settings (inert in this preview)" }, svg(ICONS.gear, 15))),
);

// ── Bots (the real engine) ────────────────────────────────────────────────────

interface Big {
  engine: BotEngine;
  canvas: HTMLCanvasElement;
  slot: HTMLElement;
  glow: HTMLElement;
  size: number;
}

/** A bot drawn the way island.ts draws its own: a slot of `diameter`, a canvas of `diameter / 0.6`. */
function makeBot(diameter: number, className: string): Big {
  const size = Math.round(diameter / 0.6);
  const slot = h("div", { class: className, style: `width:${size}px;height:${size}px` });
  const glow = h("div", { class: "bot-glow" });
  glow.style.width = glow.style.height = `${diameter * 2.2}px`;
  glow.style.left = glow.style.top = `${size / 2 - diameter * 1.1}px`;
  const canvas = h("canvas");
  canvas.width = Math.round(size * DPR);
  canvas.height = Math.round((size + OVERHANG) * DPR);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size + OVERHANG}px`;
  canvas.style.left = "0";
  canvas.style.top = `${-OVERHANG}px`;
  slot.append(glow, canvas);
  const engine = new BotEngine();
  engine.particleOverhang = OVERHANG;
  return { engine, canvas, slot, glow, size };
}

function setBotState(bot: Big, state: BotStateName) {
  bot.engine.setState(state);
  bot.glow.style.background = `radial-gradient(circle, ${botGlowColor(state)} 0%, transparent 62%)`;
  bot.glow.style.opacity = String(botGlowOpacity(state));
}

function drawBot(bot: Big, dt: number) {
  bot.engine.update(dt);
  const ctx = bot.canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  wipe(ctx);
  bot.engine.draw(ctx, bot.size, bot.size + OVERHANG);
}

// ── Home: a simplified stand-in for plans/design-plan.md §1 ───────────────────

const homeBot = makeBot(VIEW_LAYOUTS.settings.botDiameter, "home-bot");
setBotState(homeBot, "working");

function buildHome(): HTMLElement {
  const groups: [string, [BotStateName, string][]][] = [
    ["Needs you", [["approval", "nook — wants to run a command"], ["question", "korus — asks which test runner"]]],
    ["Working", [["working", "nook ·2 — editing shelf.css"], ["thinking", "sbe-hub — thinking"], ["working", "morning-ai-brief — running tests"]]],
    ["Done", [["finished", "korus ·2 — finished 1 min ago"], ["sleeping", "ig-post — finished 4 min ago"]]],
  ];
  const mid = h("div", { class: "card home-mid" });
  for (const [label, bots] of groups) {
    const row = h("div", { class: "home-minis" });
    for (const [state, what] of bots) {
      // The body stays cream: the colour is the state's, on the eyes and the antenna.
      const mini = createFreeBot("#ffffff", state, 24);
      mini.engine.bodyColor = null;
      mini.el.title = what;
      row.append(mini.el);
    }
    mid.append(h("div", { class: "home-group" }, h("small", { text: label }), row));
  }

  const meter = (name: string, value: string, share: number, color: string) => {
    const fill = h("i", { style: `width:${share * 100}%` });
    const row = h("div", { class: "meter" }, h("span", { text: name }), h("i", {}, fill), h("b", { text: value }));
    row.style.setProperty("--c", color);
    return row;
  };

  return h("div", { class: "view home" },
    h("div", { class: "overview" },
      h("div", { class: "card wash home-left", style: "--wash:rgba(59,158,255,0.34)" },
        homeBot.slot,
        h("div", { class: "home-now" },
          h("b", { text: "nook" }),
          h("span", { text: "Editing shelf.css" }),
          h("span", { text: "2 need you" }))),
      mid,
      h("div", { class: "card home-right" },
        meter("CPU", "31%", 0.31, "#3B9EFF"),
        meter("RAM", "11/16", 0.69, "#8B5CF6"),
        meter("5 h", "38%", 0.38, "#34D399"),
        meter("7 d", "12%", 0.12, "#34D399"),
        h("div", { class: "home-age", text: "usage updated 2 min ago" }))));
}

// ── Shelf: the row of small working widgets ───────────────────────────────────

const widgets = buildWidgets({
  onBack: () => closeWidget(),
  onExpand: (id, opts) => openWidget(id, opts.camera),
});
const row = h("div", { class: "shelf-row" });
const shelfEmpty = h("div", { class: "shelf-empty", text: "Every widget is hidden. Turn some on in Settings → Shelf." });

for (const id of ALL) {
  // A tap on the card expands it — unless it landed on a control, which then acts by
  // itself. The corner's expand button is the one control that expands. A press that
  // moved never gets this far: gestures.ts swallows its click.
  widgets[id].small.addEventListener("click", (e) => {
    // The path as it was when the click began: a control may have redrawn itself since
    // (play turns to pause), and what was clicked is then no longer inside it.
    const control = e.composedPath().find((n): n is Element => n instanceof Element && n.matches(CONTROL));
    if (control && !control.hasAttribute("data-expand")) return;
    openWidget(id);
  });
}

const visibleOrder = () => order.filter((id) => !hidden.has(id));

function renderRow() {
  const shown = visibleOrder();
  clear(row);
  for (const id of shown) row.append(widgets[id].small);
  row.style.display = shown.length ? "" : "none";
  shelfEmpty.style.display = shown.length ? "none" : "";
  row.scrollLeft = 0;
  markRowEdges();
}

function markRowEdges() {
  const max = row.scrollWidth - row.clientWidth;
  row.classList.toggle("more-left", row.scrollLeft > 2);
  row.classList.toggle("more-right", row.scrollLeft < max - 2);
}
row.addEventListener("scroll", markRowEdges, { passive: true });

/** How many small cards stand wholly inside the row, and how much of the next one shows. */
function cardsThatFit() {
  // The row as the Shelf tab has it: the island's width less its 10 px of padding on each side.
  const room = TAB_SIZE.shelf.w - 20;
  const whole = Math.max(0, Math.floor((room + CARD_GAP) / (CARD_W + CARD_GAP)));
  const peek = Math.max(0, room - whole * (CARD_W + CARD_GAP));
  return { room, whole, peek };
}

let dragging = false;
let gestureNote = "none yet";
enableGestures({
  row,
  card: ".wmini",
  control: CONTROL,
  longPressMs: LONG_PRESS_MS,
  onState: (on) => {
    dragging = on;
    renderReadout();
  },
  onReorder: (ids) => {
    // The visible cards in their new order, the hidden ones where they were.
    const moved = ids.filter((id): id is WidgetId => id in WIDGETS);
    let next = 0;
    order = order.map((id) => (hidden.has(id) ? id : moved[next++] ?? id));
    saveOrder(order);
    markRowEdges();
    renderReadout();
  },
  onScrollStart: () => {
    window.clearTimeout(freeTimer);
    window.clearTimeout(settleTimer);
    row.classList.add("free");
  },
  onScrollEnd: () => settleRow(),
  onVerdict: (text) => {
    gestureNote = text;
    renderReadout();
  },
});

// ── Expanded views and the alert card ─────────────────────────────────────────

const focusView = h("div", { class: "view focus" });
for (const id of ALL) focusView.append(widgets[id].card);

const alertBot = makeBot(VIEW_LAYOUTS.approval.botDiameter, "alert-bot");
const alertView = h("div", { class: "view alert" });
let lastAnswer = "none yet";

function buildAlert(kind: AlertKind) {
  const where = focus ? WIDGETS[focus].name : tab === "home" ? "Home" : "Shelf";
  const answer = (what: string) => () => {
    lastAnswer = `${what} (inert) → back to ${where}`;
    dismissAlert();
  };
  const back = h("button", { class: "link-btn alert-back", text: `Back to ${where}`, onclick: answer("left unanswered") });

  let stack: HTMLElement;
  if (kind === "permission") {
    setBotState(alertBot, "approval");
    stack = h("div", { class: "stack alert-stack" },
      h("div", { class: "who-row" }, dot("#F5A524"), h("span", { class: "n", text: "nook" }), h("span", { text: "· Bash" })),
      h("div", { class: "title", text: "Claude wants to run a command" }),
      h("div", { class: "code", text: "npm run build" }),
      h("div", { class: "actions", style: "margin-top:3px" },
        h("button", { class: "btn secondary", text: "Deny", onclick: answer("Denied") }),
        h("button", { class: "btn primary", text: "Allow", onclick: answer("Allowed") }),
        back));
  } else {
    setBotState(alertBot, "question");
    const options = ["Vitest", "Jest", "Node's own runner"].map((name) =>
      h("button", { class: "btn secondary q-opt", onclick: answer(`Answered "${name}"`) }, h("span", { text: name })));
    stack = h("div", { class: "stack alert-stack", style: "gap:8px" },
      h("div", { class: "who-row" }, dot("#22D3EE"), h("span", { class: "n", text: "korus" }), h("span", { class: "q-chip", text: "Testing" })),
      h("div", { class: "title q-title", text: "Which test runner should I set up for the new package?" }),
      h("div", { class: "actions q-options" }, ...options),
      h("div", { class: "q-foot" },
        h("span", { class: "q-hint", text: "Pick one to let the session go on." }),
        h("span", { class: "grow" }),
        back));
  }
  clear(alertView);
  alertView.append(h("div", { class: "card wash", style: `--wash:${washRGBA(kind === "permission" ? "amber" : "cyan")}` },
    alertBot.slot, stack));
}

const homeView = buildHome();
const shelfView = h("div", { class: "view shelf" }, row, shelfEmpty);
const viewEls: Record<ViewKey, HTMLElement> = { home: homeView, shelf: shelfView, focus: focusView, alert: alertView };
views.append(homeView, shelfView, focusView, alertView);

// ── The island's size: its spring, inside the fixed window ────────────────────

const W = new Tracked(targetSize().w);
const H = new Tracked(targetSize().h);

function layoutIsland() {
  const w = W.value;
  wrap.style.width = `${w}px`;
  wrap.style.height = `${Math.max(0, H.value)}px`;
  // Centred on a whole pixel, as island.ts does.
  wrap.style.left = `${Math.round((WINDOW_W - w) / 2)}px`;
}

/** A shared-element transition in flight: the browser is drawing the island's change of size. */
interface Shared {
  transition: { skipTransition(): void };
  apply: () => void;
  from: { w: number; h: number };
  to: { w: number; h: number };
  /** When its animations began; 0 until they have. */
  start: number;
  ms: number;
  ease: (p: number) => number;
}
let shared: Shared | null = null;

interface ViewTransitionLike {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition(): void;
}
const startViewTransition = (document as unknown as {
  startViewTransition?: (update: () => void) => ViewTransitionLike;
}).startViewTransition;
const canShare = () => typeof startViewTransition === "function" && !forceFallback;

// The morph. Every element that is the same thing in the small card and in the
// expanded view carries `data-vt` (widgets.ts). For the length of one transition
// the ones on show get `view-transition-name: w-<that name>`: first in the size
// being left, then — once the page has changed — in the size being entered. A
// name on both sides moves; a name on one side only fades. Names are unique at
// each capture because only one widget, in one size, wears them at a time.

const named = new Set<HTMLElement>();
/** What the last morph did, for the read-out. */
let morphNote = "none yet";

/** Laid out, and not scrolled out of the list or the row that holds it. */
function onShow(el: HTMLElement): boolean {
  const box = el.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return false;
  const holder = el.parentElement?.closest<HTMLElement>(".gh-list, .shelf-row");
  if (!holder) return true;
  const clip = holder.getBoundingClientRect();
  return box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1 && box.left >= clip.left - 1 && box.right <= clip.right + 1;
}

function nameShared(scope: HTMLElement): string[] {
  const names: string[] = [];
  for (const el of [scope, ...scope.querySelectorAll<HTMLElement>("[data-vt]")]) {
    const name = el.dataset.vt;
    if (!name || names.includes(name) || !onShow(el)) continue;
    el.style.setProperty("view-transition-name", `w-${name}`);
    if (el.dataset.vtc) el.style.setProperty("view-transition-class", `w-${el.dataset.vtc}`);
    named.add(el);
    names.push(name);
  }
  return names;
}

function unnameAll() {
  for (const el of named) {
    el.style.removeProperty("view-transition-name");
    el.style.removeProperty("view-transition-class");
  }
  named.clear();
}

function endShared() {
  const s = shared;
  if (!s) return;
  shared = null;
  s.apply(); // if the browser had not got to it yet
  s.transition.skipTransition();
  finishShared();
}

function finishShared() {
  unnameAll();
  island.classList.remove("no-anim");
  root.classList.remove("vt-open", "vt-back");
}

/**
 * The island's rectangle inside the window, now — what `set_island_rect` would
 * be told for click-through. During a shared-element transition the page is
 * already in its final state and the browser draws the in-between: the
 * rectangle is read from what it draws (and worked out from the same curve if
 * the browser will not say).
 */
function islandRect(now = performance.now()) {
  let w = W.value;
  let hh = H.value;
  let by = W.animating || H.animating ? "island spring (anim.ts)" : "at rest";
  if (shared) {
    by = "view transition (shared element)";
    const s = shared;
    const style = s.start ? getComputedStyle(root, "::view-transition-group(island)") : null;
    const cw = style ? parseFloat(style.width) : NaN;
    const ch = style ? parseFloat(style.height) : NaN;
    // The spring overshoots a little; anything further out is not the island's box.
    const within = (v: number, a: number, b: number) => v >= Math.min(a, b) - 60 && v <= Math.max(a, b) + 60;
    if (within(cw, s.from.w, s.to.w) && within(ch, s.from.h, s.to.h)) {
      w = cw;
      hh = ch;
    } else {
      const p = s.start ? s.ease(clamp((now - s.start) / s.ms, 0, 1)) : 0;
      w = s.from.w + (s.to.w - s.from.w) * p;
      hh = s.from.h + (s.to.h - s.from.h) * p;
      by += ", computed";
    }
  }
  return { x: Math.round((WINDOW_W - w) / 2), y: 0, w, h: hh, by };
}

// ── Moving between states ─────────────────────────────────────────────────────

/** Makes the page match the state: which view is on, the bar, the glow, what runs. */
function render() {
  const key = viewKey();
  for (const name of Object.keys(viewEls) as ViewKey[]) {
    const on = name === key;
    viewEls[name].classList.toggle("on", on);
    viewEls[name].inert = !on;
  }
  content.classList.toggle("bare", key === "focus");
  tabButtons.home.classList.toggle("on", tab === "home");
  tabButtons.shelf.classList.toggle("on", tab === "shelf");
  for (const id of ALL) widgets[id].card.classList.toggle("on", id === focus);
  // What has just come on show is painted before anyone looks at it (or names its parts).
  if (key === "shelf") paintShelf(false);
  else if (key === "focus" && focus) widgets[focus].paint();
  const accent =
    key === "focus" && focus ? WIDGETS[focus].accent
    : alert === "permission" ? "#F5A524"
    : alert === "question" ? "#22D3EE"
    : "rgba(0,0,0,0)";
  wrap.style.setProperty("--accent", accent);
  syncEffects();
  renderReadout();
}

/**
 * Changes the state and takes the island there. `share` names the widget whose
 * small card and expanded view are one thing across the change (expanding it,
 * or going back from it): its shared elements morph. Without it the island's
 * own spring and the views' cross-fade do the work, as between any two views
 * of the app today.
 */
function go(change: () => void, share?: { id: WidgetId; open: boolean }) {
  endShared();
  const from = { w: W.value, h: H.value };
  const reduced = reducedMotion();
  if (share) {
    morphNote = reduced
      ? `${WIDGETS[share.id].name}: no morph (reduced motion): the two sizes cross-fade in 120 ms`
      : `${WIDGETS[share.id].name}: no morph (fallback): the island's spring and a cross-fade`;
  }

  if (share && !reduced && canShare() && startViewTransition) {
    const small = widgets[share.id].small;
    const card = widgets[share.id].card;
    root.classList.toggle("vt-open", share.open);
    root.classList.toggle("vt-back", !share.open);
    unnameAll();
    if (share.open) revealCard(small);
    const before = nameShared(share.open ? small : card);

    let applied = false;
    const apply = () => {
      if (applied) return;
      applied = true;
      island.classList.add("no-anim");
      change();
      render();
      const to = targetSize();
      W.jump(to.w);
      H.jump(to.h);
      layoutIsland();
      unnameAll();
      const target = share.open ? card : small;
      // Going back: the card it shrinks into stands wholly in the row.
      if (!share.open && small.isConnected) revealCard(small);
      const after = target.isConnected ? nameShared(target) : [];
      const moved = before.filter((n) => after.includes(n));
      const gone = before.filter((n) => !after.includes(n));
      const fresh = after.filter((n) => !before.includes(n));
      morphNote = `${WIDGETS[share.id].name} ${share.open ? "small → expanded" : "expanded → small"}: `
        + `${moved.length} moved (${moved.join(", ")})`
        + (gone.length ? `; faded out: ${gone.join(", ")}` : "")
        + (fresh.length ? `; faded in: ${fresh.join(", ")}` : "");
      if (shared && shared.apply === apply) shared.to = { w: to.w, h: to.h };
    };
    const transition = startViewTransition.call(document, apply);
    const mine: Shared = {
      transition, apply, from, to: from, start: 0,
      ms: share.open ? springCurve.ms : BACK_MS,
      ease: share.open ? springCurve.ease : closeCurve,
    };
    shared = mine;
    transition.ready.then(() => (mine.start = performance.now())).catch(() => {});
    transition.finished.catch(() => {}).then(() => {
      if (shared !== mine) return;
      shared = null;
      finishShared();
      renderReadout();
    });
    ensureLoop();
    return;
  }

  change();
  render();
  const to = targetSize();
  if (reduced) {
    W.jump(to.w);
    H.jump(to.h);
    layoutIsland();
    renderReadout();
    return;
  }
  // As IslandContainer does: the spring to grow, the 340 ms curve to shrink.
  if (to.w >= from.w) W.springTo(to.w);
  else W.curveTowards(to.w);
  if (to.h >= from.h) H.springTo(to.h);
  else H.curveTowards(to.h);
  ensureLoop();
}

function setTab(next: Tab) {
  if (alert || focus || next === tab) return;
  go(() => (tab = next));
}

/**
 * Expands a widget. Mirror opens with its camera off unless it was opened by
 * "Turn camera on": then the camera starts there, as soon as the view is up.
 */
function openWidget(id: WidgetId, withCamera = false) {
  if (alert || focus) return;
  if (id === "mirror") camera.consented = withCamera;
  go(() => (focus = id), { id, open: true });
}

function closeWidget() {
  if (alert || !focus) return;
  const id = focus;
  // Leaving Mirror is turning the camera off: it does not come back on by itself.
  if (id === "mirror") camera.consented = false;
  go(() => (focus = null), { id, open: false });
}

/** The preview's own shortcut: straight to the shelf, to Home, or to a widget's expanded view. */
function jump(target: "home" | "shelf" | WidgetId) {
  const onRow = !alert && !focus && tab === "shelf";
  const from = alert ? null : focus;
  if (focus === "mirror" && target !== "mirror") camera.consented = false;
  if (target === "home" || target === "shelf") {
    if (!alert && !focus && tab === target) return;
    go(() => {
      alert = null;
      focus = null;
      tab = target;
    }, from && target === "shelf" ? { id: from, open: false } : undefined);
    return;
  }
  if (!alert && focus === target) return;
  if (hidden.has(target)) {
    hidden.delete(target);
    saveHidden(hidden);
    buildCardToggles();
    renderRow();
  }
  if (target === "mirror" && focus !== "mirror") camera.consented = false;
  go(() => {
    alert = null;
    tab = "shelf";
    focus = target;
  }, onRow ? { id: target, open: true } : undefined);
}

function raiseAlert(kind: AlertKind) {
  go(() => {
    alert = kind;
    buildAlert(kind);
  });
}

function dismissAlert() {
  if (!alert) return;
  go(() => (alert = null));
}

// ── What runs, and only while it is on show ───────────────────────────────────

let tickTimer = 0;
let ticks = 0;

/** The small cards on the shelf, repainted from the model. */
function paintShelf(counted = true) {
  if (counted) ticks++;
  for (const id of visibleOrder()) widgets[id].paint();
}

/** One repaint a second of what is on show: the small cards, or the one expanded view. */
function tick() {
  const key = viewKey();
  if (key === "shelf") paintShelf();
  else if (key === "focus" && focus) {
    ticks++;
    widgets[focus].paint();
  }
}

function syncEffects() {
  const key = viewKey();
  const visible = !document.hidden;

  // A countdown, a track's position: once a second, and only while a widget is what is on show.
  const live = (key === "shelf" || key === "focus") && visible;
  if (live && !tickTimer) {
    tickTimer = window.setInterval(tick, 1000);
  } else if (!live && tickTimer) {
    window.clearInterval(tickTimer);
    tickTimer = 0;
  }

  // The camera: only while Mirror is the view on show. Anything else stops every track, now.
  const mirrorOpen = key === "focus" && focus === "mirror" && visible;
  if (!mirrorOpen) {
    const why = !visible ? "the page was hidden"
      : alert ? "an alert took over"
      : focus !== "mirror" ? "Mirror closed"
      : "the tab changed";
    stopCamera(mirrorVideo, why);
  } else if (camera.consented && camera.state === "off") {
    void startCamera(mirrorVideo);
  }

  if (botsOnShow()) ensureLoop();
}

// The model changed (a control was used, in either size, or the timer ran out):
// whatever is on show is repainted at once. Small and expanded read the same state.
onChange(() => {
  const key = viewKey();
  if (key === "focus" && focus) widgets[focus].paint();
  if (key === "shelf") paintShelf(false);
  renderReadout();
});

camera.onChange = () => {
  widgets.mirror.paint();
  renderReadout();
};

document.addEventListener("visibilitychange", () => {
  syncEffects();
  renderReadout();
});
window.addEventListener("pagehide", () => stopCamera(mirrorVideo, "the page was closed"));

// ── Frame loop: only while something moves ────────────────────────────────────

const botsOnShow = () => !document.hidden && (viewKey() === "home" || viewKey() === "alert");

let raf = 0;
let last = 0;
function frame(nowMs: number) {
  const dt = Math.min(0.05, (nowMs - last) / 1000);
  last = nowMs;
  if (W.animating || H.animating) {
    W.step(dt, nowMs);
    H.step(dt, nowMs);
    layoutIsland();
  }
  if (botsOnShow()) {
    if (viewKey() === "home") {
      drawBot(homeBot, dt);
      tickMiniBots(dt);
    } else {
      drawBot(alertBot, dt);
    }
  }
  if (W.animating || H.animating || shared || botsOnShow()) {
    raf = requestAnimationFrame(frame);
  } else {
    raf = 0;
  }
  renderReadout();
}

function ensureLoop() {
  if (raf) return;
  last = performance.now();
  raf = requestAnimationFrame(frame);
}

// ── Swipe: wheel events over the island ───────────────────────────────────────

const swipe = new SwipeDetector();
let wheelNote = "none yet";
let lastWheelAt = -1e9;
let settleTimer = 0;
let freeTimer = 0;
let liveTimer = 0;

const cardPitch = () => {
  const all = row.querySelectorAll<HTMLElement>(".wmini");
  return all.length > 1 ? all[1].offsetLeft - all[0].offsetLeft : CARD_W + CARD_GAP;
};

/** Brings a card wholly into the row's view, at once: what is cut by the row's edge would grow from outside the island. */
function revealCard(card: HTMLElement) {
  const left = card.offsetLeft - row.offsetLeft;
  const right = left + card.offsetWidth;
  if (left >= row.scrollLeft && right <= row.scrollLeft + row.clientWidth) return;
  // Set by hand, so not while the row snaps by itself.
  window.clearTimeout(freeTimer);
  window.clearTimeout(settleTimer);
  row.classList.add("free");
  row.scrollLeft = left < row.scrollLeft ? left : right - row.clientWidth;
  freeTimer = window.setTimeout(() => row.classList.remove("free"), 800);
}

/** The row takes a horizontal delta if it can still move that way. */
function scrollRow(dx: number): boolean {
  const max = row.scrollWidth - row.clientWidth;
  if (max <= 1) return false;
  if (dx > 0 && row.scrollLeft >= max - 1) return false;
  if (dx < 0 && row.scrollLeft <= 1) return false;
  window.clearTimeout(freeTimer);
  row.classList.add("free");
  row.scrollLeft += dx;
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(settleRow, 140);
  return true;
}

/** The swipe is over: the row comes to rest on a card, then snaps by itself again. */
function settleRow() {
  const pitch = cardPitch();
  const max = row.scrollWidth - row.clientWidth;
  let target = Math.round(row.scrollLeft / pitch) * pitch;
  if (target > max || max - row.scrollLeft < pitch / 2) target = max;
  row.scrollTo({ left: target, behavior: reducedMotion() ? "auto" : "smooth" });
  freeTimer = window.setTimeout(() => row.classList.remove("free"), 360);
}

wrap.addEventListener("wheel", (e) => {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? WINDOW_W : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  const now = performance.now();
  lastWheelAt = now;
  // A horizontal swipe is the island's: never the page's scroll, never the browser's "back".
  if (Math.abs(dx) > Math.abs(dy)) e.preventDefault();

  if (alert) {
    wheelNote = "ignored: an alert is up";
  } else {
    const key = viewKey();
    const dir = swipe.feed(dx, dy, now, key === "shelf" ? scrollRow : undefined);
    wheelNote = swipe.verdict;
    if (dir && key === "focus") {
      if (dir < 0) {
        wheelNote = "fired: swipe right, back to the Shelf";
        closeWidget();
      } else {
        wheelNote = "fired: nothing that way";
      }
    } else if (dir) {
      const next: Tab = dir > 0 ? "shelf" : "home";
      if (next !== tab) {
        wheelNote = `fired: switched to ${next === "home" ? "Home" : "Shelf"}`;
        setTab(next);
      } else {
        wheelNote = "fired: no tab that way";
      }
    }
  }
  renderReadout();
  // The numbers go on changing after the last event: the cooldown runs out, the gesture ends.
  if (!liveTimer) {
    liveTimer = window.setInterval(() => {
      const t = performance.now();
      renderReadout();
      if (!swipe.cooling(t) && t - lastWheelAt > 260) {
        window.clearInterval(liveTimer);
        liveTimer = 0;
      }
    }, 50);
  }
}, { passive: false });

// ── Keys ──────────────────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (alert) return;
    if (!focus) {
      // On the shelf, Esc leaves the field of a small card.
      if (document.activeElement instanceof HTMLElement && row.contains(document.activeElement)) document.activeElement.blur();
      return;
    }
    e.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    closeWidget();
    return;
  }
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const t = e.target;
  // In a field the arrows move the caret; on a slider they move the slider.
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  if (alert || focus) return;
  e.preventDefault();
  setTab(e.key === "ArrowRight" ? "shelf" : "home");
});

// ── Preview controls ──────────────────────────────────────────────────────────

$("alert-permission").addEventListener("click", () => raiseAlert("permission"));
$("alert-question").addEventListener("click", () => raiseAlert("question"));

// Straight to a state worth looking at.
{
  const box = $("jump-btns");
  const add = (label: string, target: "home" | "shelf" | WidgetId, primary = false) =>
    box.append(h("button", { class: `btn ${primary ? "primary" : "secondary"}`, text: label, onclick: () => jump(target) }));
  add("Shelf", "shelf", true);
  add("To-do expanded", "todo", true);
  add("Media expanded", "media", true);
  add("Timer expanded", "timer");
  add("Reminders expanded", "reminders");
  add("Mirror expanded (camera off)", "mirror");
  add("Projects expanded", "projects");
  add("Home", "home");
}

// The same functions the cards' own controls call, pressed from outside: whichever
// size is on show repaints, because both read the one state.
$("ctl-todo").addEventListener("click", () => {
  const latest = todo.items[todo.items.length - 1];
  if (latest) toggleTodo(latest.id);
});
$("ctl-media").addEventListener("click", mediaToggle);
$("ctl-timer").addEventListener("click", timerToggle);

function bindSwitch(id: string, initial: boolean, set: (on: boolean) => void) {
  const btn = $(id);
  let on = initial;
  btn.classList.toggle("on", on);
  btn.addEventListener("click", () => {
    on = !on;
    btn.classList.toggle("on", on);
    set(on);
    renderReadout();
  });
}

const applyReduced = () => root.classList.toggle("rm", reducedMotion());
bindSwitch("force-reduced", false, (on) => {
  forceReduced = on;
  applyReduced();
});
bindSwitch("force-fallback", false, (on) => (forceFallback = on));
bindSwitch("show-window", true, (on) => windowEl.classList.toggle("outlined", on));
reducedQuery.addEventListener("change", () => {
  applyReduced();
  describeSystem();
  renderReadout();
});

function describeSystem() {
  $("reduced-system").textContent = `system: ${reducedQuery.matches ? "reduce" : "no preference"}`;
  $("vt-support").textContent = typeof startViewTransition === "function" ? "supported here" : "not supported here";
}

function bindSlider(id: string, unit: string, set: (v: number) => void) {
  const input = $<HTMLInputElement>(id);
  const out = $(`${id}-out`);
  const apply = () => {
    set(Number(input.value));
    out.textContent = `${input.value} ${unit}`;
    renderReadout();
  };
  input.addEventListener("input", apply);
  apply();
}

function buildCardToggles() {
  const box = $("tile-toggles");
  clear(box);
  for (const id of ALL) {
    const def = WIDGETS[id];
    const sw = h("button", { class: `switch${hidden.has(id) ? "" : " on"}`, "aria-label": `Show ${def.name}` });
    sw.addEventListener("click", () => {
      if (hidden.has(id)) hidden.delete(id);
      else hidden.add(id);
      sw.classList.toggle("on", !hidden.has(id));
      saveHidden(hidden);
      renderRow();
      paintShelf(false);
      renderReadout();
    });
    box.append(h("div", { class: "settings-row" }, sw, dot(def.accent, 8), h("b", { text: def.name })));
  }
}

$("reset-order").addEventListener("click", () => {
  order = resetOrder();
  renderRow();
  paintShelf(false);
  renderReadout();
});

// ── Read-out ──────────────────────────────────────────────────────────────────

const READOUT = [
  ["view", "On show"],
  ["rect", "Island rectangle"],
  ["motion", "Size driven by"],
  ["shelf", "Small cards"],
  ["press", "Last press on the row"],
  ["swipe", "Last wheel event"],
  ["morph", "Last morph"],
  ["updates", "Widget updates"],
  ["camera", "Camera"],
  ["timer", "Timer"],
  ["launch", "Last launch (fake)"],
  ["loop", "Frame loop"],
  ["order", "Card order"],
  ["answer", "Last alert answer"],
] as const;
type ReadoutKey = (typeof READOUT)[number][0];

const readoutCells = {} as Record<ReadoutKey, HTMLElement>;
function put(key: ReadoutKey, text: string, tone = "") {
  const cell = readoutCells[key];
  if (cell.textContent !== text) cell.textContent = text;
  if (cell.className !== tone) cell.className = tone;
}

const swipeMeter = $("swipe-meter");
const swipeFill = swipeMeter.firstElementChild as HTMLElement;

function renderReadout() {
  if (!readoutCells.view) return; // not built yet
  const now = performance.now();
  const key = viewKey();

  const names = { home: "Home tab", shelf: "Shelf tab (the row)" } as const;
  const under = focus ? `the ${WIDGETS[focus].name} view` : names[tab];
  put("view",
    key === "alert" ? `alert (${alert}) over ${under}`
    : key === "focus" && focus ? `${WIDGETS[focus].name} — expanded, ${WIDGETS[focus].w} × ${WIDGETS[focus].h}`
    : names[tab] + (dragging ? " — a card is being carried" : ""));

  const fit = cardsThatFit();
  put("shelf", `${CARD_W} px wide, ${CARD_GAP} px apart, in a ${fit.room} px row: ${fit.whole} whole`
    + (fit.peek > 0 ? ` and ${fit.peek} px of the next` : "")
    + `; ${visibleOrder().length} on the shelf, scroll-snap to a card's left edge`);
  put("press", `${gestureNote}   [tap ≤ ${TAP_SLOP} px · drag > ${TAP_SLOP} px · long press ${LONG_PRESS_MS} ms, not on a control]`);
  put("morph", morphNote, shared ? "hot" : "");
  put("launch", launch.text);

  const r = islandRect(now);
  put("rect", `x ${r.x.toFixed(0)}  y ${r.y}  w ${r.w.toFixed(1)}  h ${r.h.toFixed(1)}   (inside the ${WINDOW_W} × ${WINDOW_H} window)`);
  put("motion", reducedMotion() ? "reduced motion: size jumps, views cross-fade in 120 ms" : r.by,
    r.by === "at rest" || reducedMotion() ? "" : "hot");

  // Swipe
  const acc = now - lastWheelAt > 180 ? 0 : swipe.acc;
  const cooling = swipe.cooling(now);
  const share = clamp(Math.abs(acc) / swipe.threshold, 0, 1) * 50;
  swipeFill.style.width = `${share}%`;
  swipeFill.style.left = acc >= 0 ? "50%" : `${50 - share}%`;
  swipeMeter.classList.toggle("cooling", cooling);
  $("swipe-acc").textContent = `accumulated deltaX: ${acc.toFixed(0)} / ${swipe.threshold} px`;
  $("swipe-cool").textContent = cooling ? `cooldown: ACTIVE, ${Math.ceil(swipe.coolUntil - now)} ms left` : "cooldown: off";
  put("swipe", wheelNote, cooling ? "hot" : "");

  put("updates", tickTimer
    ? `running: one repaint a second of ${key === "focus" && focus ? `the ${WIDGETS[focus].name} view` : "the small cards"} (${ticks} so far)`
    : `PAUSED: ${document.hidden ? "the page is hidden" : "no widget is on show"} (${ticks} repaints, not counting up)`,
    tickTimer ? "" : "hot");

  const tracks = liveTracks();
  put("camera", camera.state === "on" || tracks > 0
    ? `ON: ${tracks} live track${tracks === 1 ? "" : "s"}`
    : `off: 0 live tracks (${camera.state === "off" ? `last stop: ${camera.lastStop}` : camera.state})`,
    camera.state === "on" || tracks > 0 ? "live" : "");

  put("timer", timer.running
    ? `running: ${timer.deadline ? "one setTimeout to the deadline" : "no deadline set"}; repainted only where it is on show`
    : timer.done ? "finished" : "paused: nothing scheduled");

  put("loop", raf
    ? `running: ${W.animating || H.animating ? "the island is changing size" : shared ? "a view transition is in flight" : "the bots on show are animating"}`
    : "stopped: nothing moves");

  put("order", `${visibleOrder().join(", ") || "none"}${hidden.size ? `   (hidden: ${[...hidden].join(", ")})` : ""}`);
  put("answer", lastAnswer);
}

// ── Start ─────────────────────────────────────────────────────────────────────

{
  const dl = $("readout");
  for (const [key, label] of READOUT) {
    const cell = h("dd");
    readoutCells[key] = cell;
    dl.append(h("dt", { text: label }), cell);
  }
}

bindSlider("swipe-threshold", "px", (v) => (swipe.threshold = v));
bindSlider("swipe-cooldown", "ms", (v) => (swipe.cooldownMs = v));
describeSystem();
applyReduced();
buildCardToggles();
renderRow();
timerStart();
for (const id of ALL) widgets[id].paint();
layoutIsland();
render();
markRowEdges();
