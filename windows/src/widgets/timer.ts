// Timer: a countdown. Small: the time left and Start / Pause. Expanded: a dial,
// presets (5, 15, 25, 45 minutes), a time of one's own, and Reset.
//
// The end is a wall-clock time (`endsAt`), so what is left is right whenever it
// is looked at — after the island was hidden, after the machine slept. While the
// timer runs there is exactly one timer of the page's: a `setTimeout` to that
// moment. Nothing ticks for it: the countdown on show is repainted once a second
// by the Shelf, and only while the Shelf is on show.
//
// When it reaches zero it plays a sound (the island's own "finish") and opens the
// island on the Timer. Kept in shelf.json, so a restart keeps a running timer.

import { Sound } from "../core/sound";
import { h } from "../views/dom";
import { loadWidget, notifyShelf, saveWidget, ShelfHooks } from "./core";
import { widgetOn } from "./defs";
import { frame, mini, shared, takesKeys, type Widget, type WidgetContext } from "./ui";

const MIN = 60_000;
export const MAX_MINUTES = 599;
const PRESETS = [5, 15, 25, 45];

export const timer = {
  durationMs: 15 * MIN,
  /** What is left, while it does not run. */
  remainingMs: 15 * MIN,
  /** When it reaches zero (Unix ms), while it runs. */
  endsAt: 0,
  running: false,
  done: false,
};

/** The one `setTimeout` to the end, while it runs. */
let deadline = 0;

const save = () => saveWidget("timer", { ...timer });

export const timerLeft = (now = Date.now()) => (timer.running ? Math.max(0, timer.endsAt - now) : timer.remainingMs);

/** "05:00", "00:07", and past an hour "75:00". */
export function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** What the file said, held to what is valid. */
export function readTimer(raw: unknown): typeof timer {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ms = (v: unknown, fallback: number, max = MAX_MINUTES * MIN) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : fallback;
  const durationMs = Math.max(1000, ms(o.durationMs, 15 * MIN));
  return {
    durationMs,
    remainingMs: ms(o.remainingMs, durationMs),
    endsAt: ms(o.endsAt, 0, Number.MAX_SAFE_INTEGER),
    running: o.running === true,
    done: o.done === true,
  };
}

function clearDeadline() {
  if (deadline) window.clearTimeout(deadline);
  deadline = 0;
}

/** Arms the one timer to the end — or none: not running, or the widget is switched off (a widget that is off never runs). */
function arm() {
  clearDeadline();
  if (!timer.running || !widgetOn("timer")) return;
  deadline = window.setTimeout(() => {
    deadline = 0;
    finish(true);
  }, Math.min(Math.max(0, timer.endsAt - Date.now()), 2_000_000_000));
}

/** It reached zero. `loud`: it did so while Nook was running (a sound, the island); otherwise it is only said. */
function finish(loud: boolean) {
  timer.running = false;
  timer.remainingMs = 0;
  timer.done = true;
  save();
  notifyShelf();
  if (!loud) return;
  Sound.play("finish");
  ShelfHooks.alert("timer");
}

/** At start: a timer that was running goes on; one that ran out while Nook was not running is only shown as finished. */
export async function startTimer() {
  Object.assign(timer, readTimer(await loadWidget("timer")));
  if (timer.running && timer.endsAt <= Date.now()) finish(false);
  else arm();
  notifyShelf();
}

/** Settings → Shelf changed: switched off, nothing is armed; switched on again, the end is looked at afresh. */
export function rearmTimer() {
  if (timer.running && timer.endsAt <= Date.now() && widgetOn("timer")) finish(false);
  else arm();
}

export function timerStart() {
  if (timer.running) return;
  if (timer.remainingMs <= 0) timer.remainingMs = timer.durationMs;
  timer.done = false;
  timer.running = true;
  timer.endsAt = Date.now() + timer.remainingMs;
  arm();
  save();
  notifyShelf();
}

export function timerPause() {
  if (!timer.running) return;
  timer.remainingMs = timerLeft();
  timer.running = false;
  clearDeadline();
  save();
  notifyShelf();
}

export const timerToggle = () => (timer.running ? timerPause() : timerStart());

export function timerReset() {
  clearDeadline();
  timer.running = false;
  timer.done = false;
  timer.remainingMs = timer.durationMs;
  save();
  notifyShelf();
}

/** A preset or a custom time: the countdown is set to it, stopped. */
export function timerSet(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  timer.durationMs = Math.round(Math.min(minutes, MAX_MINUTES) * MIN);
  timerReset();
}

// ── The widget ────────────────────────────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function buildTimer(ctx: WidgetContext): Widget {
  // Small: the countdown and start / pause.
  const sTime = shared(h("div", { class: "timer-time" }), "timer-time");
  const sSub = shared(h("div", { class: "timer-sub" }), "timer-sub", "text");
  const sGo = shared(h("button", { class: "btn primary wmini-btn", onclick: timerToggle }), "timer-go");
  const small = mini("timer", h("div", { class: "wbody-timer" }, h("div", {}, sTime, sSub), sGo));

  // Expanded: the dial, the presets, a time of one's own.
  const R = 62;
  const LENGTH = 2 * Math.PI * R;
  const dial = svgEl("svg", { viewBox: "0 0 150 150", width: 150, height: 150, class: "timer-dial", "aria-hidden": "true" });
  const ring = svgEl("circle", {
    cx: 75, cy: 75, r: R, fill: "none", stroke: "currentColor", "stroke-width": 7,
    "stroke-linecap": "round", "stroke-dasharray": LENGTH, transform: "rotate(-90 75 75)", class: "timer-ring",
  });
  dial.append(svgEl("circle", { cx: 75, cy: 75, r: R, fill: "none", stroke: "rgba(255,255,255,0.08)", "stroke-width": 7 }), ring);
  const time = shared(h("div", { class: "timer-time" }), "timer-time");
  const sub = shared(h("div", { class: "timer-sub" }), "timer-sub", "text");

  const presets = h("div", { class: "seg timer-presets", role: "group", "aria-label": "Presets" });
  for (const m of PRESETS) {
    const btn = h("button", { text: `${m} min`, onclick: () => timerSet(m) });
    btn.dataset.min = String(m);
    presets.append(btn);
  }
  const custom = takesKeys(ctx, h("input", {
    class: "island-field timer-custom", type: "number", min: 1, max: MAX_MINUTES, step: 1, placeholder: "min",
    title: "A time of your own, in minutes", "aria-label": "Custom time in minutes",
  }));
  const setCustom = () => {
    const value = Number(custom.value);
    if (!custom.value || !Number.isFinite(value) || value <= 0) return;
    timerSet(value);
    custom.value = "";
  };
  custom.addEventListener("keydown", (e) => {
    if (e.key === "Enter") setCustom();
  });
  const go = shared(h("button", { class: "btn primary", onclick: timerToggle }), "timer-go");

  const body = h("div", { class: "timer" },
    h("div", { class: "timer-face" }, dial as unknown as Node, h("div", { class: "timer-read" }, time, sub)),
    h("div", { class: "timer-set" },
      presets,
      h("div", { class: "timer-own" }, custom, h("button", { class: "chip-btn", text: "Set", onclick: setCustom }))),
    h("div", { class: "actions" }, go, h("button", { class: "btn secondary", text: "Reset", onclick: timerReset })));

  function paint() {
    const left = timerLeft();
    const read = clock(left);
    const of = timer.done ? "Time's up" : `of ${clock(timer.durationMs)}`;
    const label = timer.running ? "Pause" : timer.done ? "Restart" : "Start";
    for (const el of [sTime, time]) if (el.textContent !== read) el.textContent = read;
    time.classList.toggle("long", read.length > 5);
    sub.textContent = of;
    sSub.textContent = timer.done ? of : timer.running ? `${of} · running` : `${of} · paused`;
    for (const el of [sGo, go]) if (el.textContent !== label) el.textContent = label;
    ring.setAttribute("stroke-dashoffset", String(LENGTH * (1 - left / timer.durationMs)));
    body.classList.toggle("done", timer.done);
    small.classList.toggle("done", timer.done);
    for (const btn of presets.children) {
      btn.classList.toggle("on", Number((btn as HTMLElement).dataset.min) * MIN === timer.durationMs);
    }
  }

  // Once a second while the Shelf is on show, and only while it runs.
  return { id: "timer", small, card: frame("timer", body, ctx.back), paint, tick: () => timer.running && paint() };
}
