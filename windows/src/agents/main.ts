// The agents list's page: a header (a title, the two usage limits, a ×) and one
// row per project, drawn from the snapshot the island sends (model.ts). Rows are
// kept and patched in place, never rebuilt, so nothing flickers or jumps as the
// numbers change; the clock ticks once a second, and only while the window is
// on show. A click on a row goes to that project's window (`Bridge.focusSession`);
// the window itself never takes the keyboard (Rust makes it non-activating).

import "../style.css";
import "./agents.css";
import { Bridge, IS_TAURI, onEvent } from "../core/bridge";
import { DEFAULT_SETTINGS, FADE_MAX, FADE_MIN, usageLevel, usageShown, type Settings, type Usage } from "../core/state";
import { h } from "../views/dom";
import { toolMark } from "../views/tool";
import { fadeOf } from "./fade";
import { formatElapsed, formatTokens, readSnapshot, shownStatus, type AgentRow, type AgentStatus } from "./model";

const WORDS: Record<AgentStatus, string> = { wait: "WAIT", work: "WORK", done: "DONE", idle: "IDLE" };
/** A row that could not be gone to stays dimmed this long. */
const NOGO_MS = 1400;

const root = document.getElementById("agents-root")!;
const page = document.documentElement;

let settings: Settings = { ...DEFAULT_SETTINGS };
let rows: AgentRow[] = [];
let usage: Usage | null = null;
/** Whether Rust has the window on show; and the page's own word for it. */
let shown = false;
const on = () => shown && !document.hidden;

// ── Motion ────────────────────────────────────────────────────────────────────

const systemStill = window.matchMedia("(prefers-reduced-motion: reduce)");
function applyAppearance() {
  const still = settings.reduceMotion === "system" ? systemStill.matches : settings.reduceMotion === "on";
  page.dataset.motion = still ? "reduce" : "full";
}

// ── The window ────────────────────────────────────────────────────────────────

const title = h("span", { class: "ag-title", text: "Agents", "data-tauri-drag-region": true });
const pill5 = pill("5-hour limit");
const pill7 = pill("7-day limit");
const close = h("button", { class: "ag-x", type: "button", title: "Hide", "aria-label": "Hide the agents list", text: "×" });
close.addEventListener("click", () => void Bridge.agentsHide());
const head = h("header", { class: "ag-head", "data-tauri-drag-region": true }, title, pill5.el, pill7.el, close);
const list = h("ul", { class: "ag-list", role: "list", "aria-label": "Agents, one row per project" });
const empty = h("p", { class: "ag-empty", role: "status", text: "No agents running" });
const panel = h("div", { id: "ag-panel" }, head, list, empty);
type Grip = "left" | "right" | "bottom" | "bottom-left" | "bottom-right";
const GRIPS: Grip[] = ["left", "right", "bottom", "bottom-left", "bottom-right"];
const grips = GRIPS.map((side) => h("div", { class: `ag-grip ag-grip-${side}`, "aria-hidden": "true" }));
root.append(panel, ...grips);

// ── The size: the edges and the bottom corners ────────────────────────────────
// Pressed, an edge captures the pointer and Rust takes the width, or — from the
// bottom — the most the window may be tall, from where the cursor is (agents.rs:
// it reads the cursor itself, in physical pixels). The page only says when it
// begins, moves and ends, at most once a frame.

function grabEdge(el: HTMLElement, side: Grip) {
  let held = false;
  let frame = 0;
  const end = () => {
    if (!held) return;
    held = false;
    window.cancelAnimationFrame(frame);
    frame = 0;
    // The last place of the pointer, which a frame may not have carried yet.
    void Bridge.agentsResizeMove();
    void Bridge.agentsResizeEnd();
    hold(false);
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || held) return;
    e.preventDefault();
    held = true;
    hold(true);
    el.setPointerCapture(e.pointerId);
    void Bridge.agentsResizeBegin(side);
  });
  el.addEventListener("pointermove", () => {
    if (!held || frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (held) void Bridge.agentsResizeMove();
    });
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(type, end);
}
GRIPS.forEach((side, at) => grabEdge(grips[at], side));

// A double click on the header (not on the ×): back to the default width and
// height. On the second press, not on `dblclick`: the first press starts the
// system's move loop (a drag region), which eats the release a `click` is made of.
head.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || (e.target as HTMLElement).closest(".ag-x")) return;
  // Taking hold of the header is a look at the list: it stays clear.
  pointerIn();
  if (e.detail === 2) void Bridge.agentsResizeReset();
});

function pill(name: string) {
  const label = h("b");
  const value = h("span");
  const el = h("span", { class: "ag-pill", "data-tauri-drag-region": true }, label, value);
  el.hidden = true;
  return { el, label, value, name };
}

/** One of the usage pills, from the usage Claude Code last reported; hidden while it is not known. */
function paintPill(p: ReturnType<typeof pill>, short: string, win: Usage["fiveHour"], updatedAt: number) {
  const shownUsage = usageShown(win, updatedAt, Date.now());
  p.el.hidden = shownUsage == null;
  if (!shownUsage) return;
  p.label.textContent = short;
  p.value.textContent = `${shownUsage.percent}%`;
  p.el.dataset.level = usageLevel(shownUsage.percent);
  p.el.dataset.state = shownUsage.state;
  p.el.title = [p.name, shownUsage.countdown].filter(Boolean).join(" · ");
}

function paintUsage() {
  paintPill(pill5, "5h", usage?.fiveHour ?? null, usage?.updatedAt ?? 0);
  paintPill(pill7, "7d", usage?.sevenDay ?? null, usage?.updatedAt ?? 0);
}

// ── The rows ──────────────────────────────────────────────────────────────────

interface RowEl {
  li: HTMLLIElement;
  marks: HTMLElement;
  name: HTMLElement;
  count: HTMLElement;
  badge: HTMLElement;
  elapsed: HTMLElement;
  tokens: HTMLElement;
  message: HTMLElement;
  row: AgentRow;
  busy: boolean;
  nogo: number;
}

const els = new Map<string, RowEl>();

/** Sets a text only when it changed: an unchanged line is not touched. */
function say(node: HTMLElement, text: string) {
  if (node.textContent !== text) node.textContent = text;
}

function makeRow(row: AgentRow): RowEl {
  const marks = h("span", { class: "ag-marks" });
  const name = h("span", { class: "ag-name" });
  const count = h("span", { class: "ag-count" });
  const badge = h("span", { class: "ag-badge" });
  const elapsed = h("span", { class: "ag-elapsed" });
  const tokens = h("span", { class: "ag-tokens" });
  const message = h("span", { class: "ag-message" });
  const hit = h("button", { class: "ag-hit", type: "button" },
    h("span", { class: "ag-line" }, marks, name, count, badge, elapsed, tokens), message);
  const li = h("li", { class: "ag-row" }, hit);
  const el: RowEl = { li, marks, name, count, badge, elapsed, tokens, message, row, busy: false, nogo: 0 };
  hit.addEventListener("click", () => void go(el));
  return el;
}

/** A click: to the window of the project's best session. One that cannot be found is dimmed for a moment. */
async function go(el: RowEl) {
  if (el.busy) return;
  el.busy = true;
  const went = await Bridge.focusSession(el.row.sessionId);
  el.busy = false;
  if (went === true) return;
  el.li.classList.add("nogo");
  el.li.title = "Window not found";
  window.clearTimeout(el.nogo);
  el.nogo = window.setTimeout(() => {
    el.li.classList.remove("nogo");
    el.li.title = tip(el.row);
  }, NOGO_MS);
}

const tip = (row: AgentRow) =>
  `${row.project}${row.count > 1 ? `: ${row.count} sessions` : ""} — click to go to its window`;

/** What changes with the clock: the status a done row has aged into, and the time it has lasted. */
function paintClock(el: RowEl, now: number) {
  const status = shownStatus(el.row, now);
  if (el.li.dataset.status !== status) {
    el.li.dataset.status = status;
    say(el.badge, WORDS[status]);
  }
  say(el.elapsed, formatElapsed(el.row.since, now));
}

/** A row's own words and numbers, patched into the element it has. */
function paintRow(el: RowEl, row: AgentRow, now: number) {
  el.row = row;
  // The tools' marks are rebuilt only when the tools change: Nook's own marks, as in the sidebar.
  const tools = row.agents.join(",");
  if (el.marks.dataset.tools !== tools) {
    el.marks.dataset.tools = tools;
    el.marks.replaceChildren(...row.agents.map((tool) => toolMark(tool, 13)));
  }
  el.marks.hidden = row.agents.length === 0;
  say(el.name, row.project);
  el.name.title = row.project;
  say(el.count, row.count >= 2 ? `×${row.count}` : "");
  el.count.hidden = row.count < 2;
  say(el.tokens, formatTokens(row.tokens));
  if (row.level && row.tokens != null) {
    el.tokens.dataset.level = row.level;
    el.tokens.title = `Context ${row.percent}%`;
  } else {
    delete el.tokens.dataset.level;
    el.tokens.removeAttribute("title");
  }
  say(el.message, row.message ?? "");
  el.message.hidden = !row.message;
  if (!el.li.classList.contains("nogo")) el.li.title = tip(row);
  el.li.setAttribute("aria-label", `${row.project}, ${row.count} ${row.count === 1 ? "session" : "sessions"}, ${WORDS[shownStatus(row, now)].toLowerCase()}`);
  paintClock(el, now);
}

/** Puts the rows in order, in place: an element moves only if it is not where it belongs. */
function render() {
  const now = Date.now();
  const keep = new Set(rows.map((row) => row.key));
  for (const [key, el] of els) {
    if (keep.has(key)) continue;
    window.clearTimeout(el.nogo);
    el.li.remove();
    els.delete(key);
  }
  rows.forEach((row, at) => {
    let el = els.get(row.key);
    if (!el) {
      el = makeRow(row);
      els.set(row.key, el);
    }
    paintRow(el, row, now);
    if (list.children[at] !== el.li) list.insertBefore(el.li, list.children[at] ?? null);
  });
  empty.hidden = rows.length > 0;
  list.hidden = rows.length === 0;
  paintUsage();
  // The rows are what the window is as tall as, and a capped window's panel does not grow with them.
  fit();
}

// ── The clock ─────────────────────────────────────────────────────────────────

let clock = 0;
/** Ticks once a second while the window is on show; stops the moment it is not. */
function syncClock() {
  if (on() && !clock) {
    tick();
    clock = window.setInterval(tick, 1000);
  } else if (!on() && clock) {
    window.clearInterval(clock);
    clock = 0;
  }
}

function tick() {
  const now = Date.now();
  for (const el of els.values()) paintClock(el, now);
  paintUsage();
}

// ── Height: the window is as tall as what it holds, up to its cap ─────────────
// What is reported is what the rows need, not the window's own height (the list
// scrolls inside the panel when the window is shorter, CSS `max-height`): a cap
// the user drags to changes the window and not this number, so nothing is
// reported back and the two cannot chase each other.

let fitted = 0;
function fit() {
  const natural = panel.getBoundingClientRect().height - list.clientHeight + list.scrollHeight;
  const height = Math.ceil(natural);
  if (!(height > 0) || height === fitted) return;
  fitted = height;
  void Bridge.agentsFit(height);
}

// ── Fading: dim when left alone, clear whenever it is looked at or needs a look ──
// The decision is `fadeOf` (fade.ts); this keeps what it is told and one timer.
// The panel is dimmed, never the window: it stays as solid to the pointer as ever.

let inside = false;
let holding = false;
let calmSince = Date.now();
let fadeTimer = 0;

function paintFade() {
  window.clearTimeout(fadeTimer);
  fadeTimer = 0;
  const waiting = rows.some((row) => row.status === "wait");
  const { faded, recheckIn } = fadeOf({ enabled: settings.agentsListFade && on(), inside, held: holding, waiting, calmSince, now: Date.now() });
  panel.toggleAttribute("data-faded", faded);
  if (recheckIn != null) fadeTimer = window.setTimeout(paintFade, recheckIn + 20);
}

/** The pointer is over the list, or something looked at it: clear, and the wait begins again from here. */
function pointerIn() {
  inside = true;
  calmSince = Date.now();
  paintFade();
}

function pointerOut() {
  inside = false;
  calmSince = Date.now();
  paintFade();
}

/** An edge is held, or let go. */
function hold(held: boolean) {
  holding = held;
  calmSince = Date.now();
  paintFade();
}

function applyFade() {
  const percent = Math.max(FADE_MIN, Math.min(FADE_MAX, Math.round(settings.agentsListFadeOpacity) || DEFAULT_SETTINGS.agentsListFadeOpacity));
  page.style.setProperty("--ag-fade", String(percent / 100));
  paintFade();
}

// The pointer over the page (the edges are in it). Neither enter nor leave comes
// for a window shown under a pointer that is not moving: its first move says so.
page.addEventListener("mouseenter", pointerIn);
page.addEventListener("mouseleave", pointerOut);
document.addEventListener("pointermove", () => {
  if (!inside) pointerIn();
});

// ── Taking the snapshot ───────────────────────────────────────────────────────

function take(value: unknown) {
  const snapshot = readSnapshot(value);
  if (!snapshot) return;
  // A row that is new, or has changed status, is worth a look: the list is clear for a while.
  const changed = snapshot.rows.some((row) => {
    const before = els.get(row.key)?.row;
    return before?.status !== row.status;
  });
  rows = snapshot.rows;
  usage = snapshot.usage;
  render();
  if (changed) calmSince = Date.now();
  paintFade();
}

async function main() {
  const boot = await Bridge.boot();
  if (boot) settings = { ...settings, ...boot.settings };
  applyAppearance();
  applyFade();
  systemStill.addEventListener("change", applyAppearance);
  await onEvent<Settings>("settings-changed", (next) => {
    settings = { ...settings, ...next };
    applyAppearance();
    // Live: a new opacity, or the fade turned off or on, shows at once.
    calmSince = Date.now();
    applyFade();
  });

  // The rows as they come, and — for a list that loaded after the island sent them — the latest kept.
  await onEvent<unknown>("agents-snapshot", take);
  await onEvent<boolean>("agents-visible", (visible) => {
    shown = visible === true;
    syncClock();
    // Shown, it has just been put in front of the user; hidden, no pointer is over it any more.
    inside = false;
    holding = false;
    calmSince = Date.now();
    paintFade();
    // Shown again: the height is asked for again, as the window may have been given another.
    if (shown) fitted = 0;
    fit();
  });
  document.addEventListener("visibilitychange", () => {
    syncClock();
    calmSince = Date.now();
    paintFade();
  });
  new ResizeObserver(fit).observe(panel);
  render();
  take(await Bridge.agentsLast());
  // A window that was shown before this page was listening.
  shown = IS_TAURI ? (await Bridge.agentsShown()) === true : true;
  syncClock();
  calmSince = Date.now();
  paintFade();
  fit();
}

void main();
