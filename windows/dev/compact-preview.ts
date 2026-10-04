// Dev harness: the planned compact island (plans/design-plan.md §2, decision 5)
// in several variants at once, over made-up sessions, with the real bot at the
// folded size. Each island's width is measured and held against the cap.
// Not part of the app bundle. `npx vite`, then /dev/compact-preview.html.

import "../src/style.css";
import "./preview/preview.css";
import { NOTCH_H, ROUNDED_CORNER, botPosition } from "../src/core/layout";
import { clear, h, svg } from "../src/views/dom";
import { ICONS } from "../src/views/icons";
import { wear } from "../src/views/palette";
import { mountBot, startBots, type BigBot } from "./preview/bots";
import { EAR_COMPACT, Notch, earsShown, onStageChange, shapeControls, stageZoom } from "./preview/notch";
import {
  MAX_VISIBLE, allNeedAttention, byUrgency, colorOf, fakeSessions, isResting, labelText, nineSessions,
  rank, shownState, stateWords,
  type FakeSession,
} from "./preview/fake";

// ── The proposed geometry: every cell has a fixed width, in logical pixels ────

/** Never wider than this… */
const COMPACT_MAX_W = 420;
/** The strip of screen each island hangs from, on this page. */
const STAGE_W = 620;
/** …nor than this share of the display's logical width, whichever is smaller. */
const SCREEN_SHARE = 0.4;

const PAD = 12;
const SLOT_GAP = 10;
const BOT_SLOT = 34;
const BOT_D = botPosition("compact", "overview", NOTCH_H).diameter;
const DOT = 9;
const DOT_GAP = 6;
const MORE_W = 24;
const METRIC_GAP = 8;

type MetricKind = "cpu" | "ram" | "usage5" | "usage7" | "waiting";

/** Wide enough for the worst each can say: "100%", "16.0 GB", "99". */
const METRIC: Record<MetricKind, { width: number; name: string; icon: string; stroke: boolean }> = {
  cpu: { width: 50, name: "CPU", stroke: true, icon: "M7 7h10v10H7zM10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5" },
  ram: { width: 66, name: "RAM", stroke: true, icon: "M3 8h18v8H3zM7 16v3M12 16v3M17 16v3M8 11v2M12 11v2M16 11v2" },
  usage5: { width: 50, name: "5-hour usage", stroke: false, icon: ICONS.timer },
  usage7: { width: 50, name: "7-day usage", stroke: true, icon: "M4 6.5h16v13H4zM4 10.5h16M8.5 4v4M15.5 4v4" },
  waiting: { width: 36, name: "Sessions waiting for you", stroke: true, icon: ICONS.bell },
};

interface Metric { kind: MetricKind; text: string }

const capFor = (screenW: number) => Math.min(COMPACT_MAX_W, Math.floor(screenW * SCREEN_SHARE));

function dotsWidth(sessions: number, dots: number): number {
  if (sessions === 0) return 0;
  const more = sessions > dots ? MORE_W : 0;
  const cells = dots + (more ? 1 : 0);
  return dots * DOT + more + Math.max(0, cells - 1) * DOT_GAP;
}

function metricsWidth(metrics: Metric[]): number {
  return metrics.reduce((w, m) => w + METRIC[m.kind].width, 0) + Math.max(0, metrics.length - 1) * METRIC_GAP;
}

/** What the island's body is wide for: its slots, each collapsing with its gap when empty. */
function bodyWidth(sessions: number, dots: number, metrics: Metric[]): number {
  const d = dotsWidth(sessions, dots);
  const m = metricsWidth(metrics);
  return PAD + BOT_SLOT + (d ? SLOT_GAP + d : 0) + (m ? SLOT_GAP + m : 0) + PAD;
}

/** The ears are part of the island: the cap is on the body and both of them. */
const earsWidth = () => (earsShown() ? 2 * EAR_COMPACT : 0);

function islandWidth(sessions: number, dots: number, metrics: Metric[]): number {
  return bodyWidth(sessions, dots, metrics) + earsWidth();
}

/**
 * What fits under the cap. The last metric goes first, then dots fold into
 * "+N": the bot and a way to the sessions always stay.
 */
function fit(sessions: number, metrics: Metric[], cap: number): { dots: number; metrics: Metric[] } {
  let dots = Math.min(MAX_VISIBLE, sessions);
  let kept = metrics;
  while (kept.length && islandWidth(sessions, dots, kept) > cap) kept = kept.slice(0, -1);
  while (dots > 0 && islandWidth(sessions, dots, kept) > cap) dots--;
  return { dots, metrics: kept };
}

// ── The variants ──────────────────────────────────────────────────────────────

interface Variant { title: string; about: string; sessions: FakeSession[]; metrics: Metric[] }

const usual: Metric[] = [
  { kind: "cpu", text: "31%" }, { kind: "ram", text: "11.2 GB" }, { kind: "usage5", text: "38%" },
];

const urgentBehind = (): FakeSession[] => {
  const all = allNeedAttention();
  const working = fakeSessions(1)[0];
  return [...all.slice(0, 7), working];
};

const VARIANTS: Variant[] = [
  {
    title: "(a) 3 metrics at their worst, 6 sessions",
    about: "100%, 16.0 GB and 100% must fit their cells.",
    sessions: fakeSessions(6),
    metrics: [{ kind: "cpu", text: "100%" }, { kind: "ram", text: "16.0 GB" }, { kind: "usage5", text: "100%" }],
  },
  { title: "(b) 0 metrics", about: "The metrics slot collapses: the island is narrower.", sessions: fakeSessions(4), metrics: [] },
  { title: "(c) 0 sessions", about: "The dots slot collapses; the bot is at rest.", sessions: [], metrics: usual },
  {
    title: "(d) 9 sessions",
    about: "Six dots, most urgent first, then \"+3\". It hides only finished ones: green, as one result is unseen.",
    sessions: nineSessions(),
    metrics: [{ kind: "cpu", text: "31%" }, { kind: "ram", text: "11.2 GB" }, { kind: "usage7", text: "12%" }],
  },
  {
    title: "(e) needs you, with an urgent one behind \"+N\"",
    about: "Seven sessions ask and one works: \"+2\" takes the colour of the most urgent it hides.",
    sessions: urgentBehind(),
    metrics: [{ kind: "cpu", text: "31%" }, { kind: "waiting", text: "7" }, { kind: "usage5", text: "38%" }],
  },
  {
    title: "(f) CPU before its first sample",
    about: "\"—\" in the same fixed cell: nothing moves when the number arrives.",
    sessions: fakeSessions(4),
    metrics: [{ kind: "cpu", text: "—" }, { kind: "ram", text: "11.2 GB" }, { kind: "usage5", text: "38%" }],
  },
];

// ── One island ────────────────────────────────────────────────────────────────

interface Built {
  variant: Variant;
  island: HTMLElement;
  bot: BigBot;
  dots: HTMLElement;
  metrics: HTMLElement;
  width: HTMLElement;
  dropped: HTMLElement;
  capGuide: HTMLElement;
  notch: Notch;
}

function build(variant: Variant): Built {
  const bot = mountBot(BOT_D, false);
  const order = byUrgency(variant.sessions);
  bot.setState(order.length ? shownState(order[0]) : "idle");

  const dots = h("div", { class: "ci-dots" });
  const metrics = h("div", { class: "ci-metrics", style: `gap:${METRIC_GAP}px` });
  const island = h(
    "div",
    {
      class: "pv-island ci",
      style: `height:${NOTCH_H}px;padding:0 ${PAD}px;gap:${SLOT_GAP}px`,
    },
    h("div", { class: "ci-bot", style: `width:${BOT_SLOT}px` }, bot.el),
    dots,
    metrics,
  );

  const width = h("b", { class: "pv-width" });
  const dropped = h("span", { class: "pv-dropped" });
  const capGuide = h("div", { class: "pv-guide cap" }, h("small"));
  const notch = new Notch(island, { w: 0, h: NOTCH_H, ear: EAR_COMPACT, corner: ROUNDED_CORNER });
  return { variant, island, bot, dots, metrics, width, dropped, capGuide, notch };
}

/** Puts in the island what fits under `cap`; answers the width its body is computed to have. */
function fill(b: Built, cap: number): number {
  const order = byUrgency(b.variant.sessions);
  const plan = fit(order.length, b.variant.metrics, cap);

  clear(b.dots);
  b.dots.hidden = order.length === 0;
  b.dots.style.gap = `${DOT_GAP}px`;
  for (const s of order.slice(0, plan.dots)) {
    b.dots.append(h("i", {
      class: `ci-dot${rank(s) === 0 ? " calls" : ""}${isResting(s) ? " rest" : ""}`,
      style: `width:${DOT}px;height:${DOT}px;--c:${colorOf(s)}`,
      title: `${labelText(s, b.variant.sessions)} — ${stateWords(s)}`,
    }));
  }
  const hidden = order.slice(plan.dots);
  if (hidden.length) {
    const more = h("span", { class: `ci-more${rank(hidden[0]) === 0 ? " calls" : ""}`, style: `width:${MORE_W}px`, text: `+${hidden.length}` });
    wear(more, colorOf(hidden[0]));
    b.dots.append(more);
  }

  clear(b.metrics);
  b.metrics.hidden = plan.metrics.length === 0;
  for (const m of plan.metrics) {
    const def = METRIC[m.kind];
    b.metrics.append(h(
      "span", { class: "ci-metric", style: `width:${def.width}px`, title: def.name },
      svg(def.icon, 12, def.stroke ? { stroke: 1.8 } : {}),
      h("b", { class: m.text === "—" ? "blank" : "", text: m.text }),
    ));
  }

  const lostMetrics = b.variant.metrics.length - plan.metrics.length;
  const lostDots = Math.min(MAX_VISIBLE, order.length) - plan.dots;
  const lost = [
    lostMetrics ? `${lostMetrics} metric${lostMetrics === 1 ? "" : "s"}` : "",
    lostDots ? `${lostDots} dot${lostDots === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  b.dropped.textContent = lost.length ? `${lost.join(" and ")} folded away to fit` : "";
  return bodyWidth(order.length, plan.dots, plan.metrics);
}

// ── The page ──────────────────────────────────────────────────────────────────

const built = VARIANTS.map(build);

// The task gives 1280 → 3840; over that whole range 40 % is more than 420, so
// the share never bites. The slider starts lower to show it taking over.
const SCREEN_MIN = 800;
const slider = h("input", { type: "range", min: SCREEN_MIN, max: 3840, step: 10, value: 1920, class: "pv-slider" });
const capText = h("span", { class: "pv-cap-text" });
const verdict = h("div", { class: "pv-verdict" });

let first = true;
function measure() {
  const screenW = Number(slider.value);
  const cap = capFor(screenW);
  capText.innerHTML =
    `screen <b>${screenW} px</b> → cap = min(${COMPACT_MAX_W}, ${SCREEN_SHARE * 100} % × ${screenW} = ${Math.floor(screenW * SCREEN_SHARE)}) = <b>${cap} px</b>`;

  let over = 0;
  for (const b of built) {
    const expected = fill(b, cap);
    // What the browser really laid out (a simulated scaling taken back out), and the ears it wears.
    const body = Math.round((b.island.getBoundingClientRect().width / stageZoom()) * 10) / 10;
    const measured = body + earsWidth();
    b.notch.set({ w: body, h: NOTCH_H, ear: EAR_COMPACT, corner: ROUNDED_CORNER }, !first);
    // Centred on a whole pixel, as the window places the island: half a pixel would soften its edges.
    b.island.style.left = `${Math.round((STAGE_W - body) / 2)}px`;
    const fits = measured <= cap;
    // The rule of decision 5, checked on what the browser really laid out.
    console.assert(fits, `${b.variant.title}: ${measured} px exceeds the cap of ${cap} px`);
    console.assert(Math.abs(body - expected) < 0.5, `${b.variant.title}: body laid out at ${body} px, computed ${expected} px — something pushed a slot wider`);
    if (!fits) over++;
    b.width.textContent = earsWidth() ? `${measured} px (${body} + 2 × ${EAR_COMPACT} ears)` : `${measured} px`;
    b.width.classList.toggle("over", !fits);
    b.width.title = fits ? `within the cap of ${cap} px` : `exceeds the cap of ${cap} px`;
    b.capGuide.style.width = `${cap}px`;
    b.capGuide.hidden = cap >= COMPACT_MAX_W;
    b.capGuide.querySelector("small")!.textContent = `${cap}`;
  }
  verdict.textContent = over
    ? `${over} of ${built.length} variants exceed the cap of ${cap} px`
    : `All ${built.length} variants are within the cap of ${cap} px`;
  verdict.classList.toggle("over", over > 0);
  first = false;
}

slider.addEventListener("input", measure);
onStageChange(measure);

document.getElementById("root")!.append(
  h("section", { class: "pv-controls top" },
    h("h2", { text: "Compact island — preview" }),
    h("p", { text: `Fixed slots, left to right: bot (overall state) · session dots (most urgent first, at most ${MAX_VISIBLE} then "+N") · up to 3 metrics. The faint lines mark the ${COMPACT_MAX_W} px maximum; the amber ones the cap when the screen makes it smaller.` }),
    h("div", { class: "pv-group" }, h("span", { text: "Screen width" }), slider, capText),
    shapeControls(),
    verdict),
  ...built.map((b) => h(
    "div", { class: "pv-variant" },
    h("div", { class: "pv-label" }, h("span", { class: "t", text: b.variant.title }), b.width, b.dropped),
    h("div", { class: "pv-about", text: b.variant.about }),
    h("div", { class: "pv-desk compact", style: `width:${STAGE_W}px` },
      h("div", { class: "pv-guide", style: `width:${COMPACT_MAX_W}px` }, h("small", { text: String(COMPACT_MAX_W) })),
      b.capGuide,
      b.island),
  )),
);

measure();
// Fonts arriving late could change a width: measure again once they are in.
void document.fonts.ready.then(measure);
startBots();
