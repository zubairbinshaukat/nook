// Dev harness: the planned home view (plans/design-plan.md §1, plans/subagents-plan.md §7)
// drawn with the app's own surfaces and the real bot, over made-up sessions.
// Nothing here is in the app yet: it is to be looked at before it is built.
// Not part of the app bundle. `npx vite`, then /dev/home-preview.html.

import "../src/style.css";
import "./preview/preview.css";
import {
  COMPACT_W, EXPANDED_CORNER, EXPANDED_W, NOTCH_H, ROUNDED_CORNER, washRGBA, type BotStateName, type Wash,
} from "../src/core/layout";
import { clear, h, svg } from "../src/views/dom";
import { ICONS } from "../src/views/icons";
import { COLOR, wear } from "../src/views/palette";
import { mountBot, mountMini, startBots, type MiniBot } from "./preview/bots";
import { EAR_COMPACT, EAR_EXPANDED, Notch, shapeControls, stageZoom } from "./preview/notch";
import {
  FADE_AFTER_MS, MAX_CHILD_DOTS, MAX_VISIBLE, NO_USAGE_REASONS, USAGE_STALE_MS,
  allNeedAttention, applySubagents, byUrgency, clock, colorOf, fakeSessions, fakeUsage, hasFaded,
  isResting, labelOf, labelText, laneOf, longNameSession, rank, runningSubagents, shownState,
  span, stateWords, subagentColor, waited,
  type FakeSession, type FakeUsage, type Lane, type SubagentScenario,
} from "./preview/fake";

/**
 * How tall the island is for the home view. Today's overview is 160 and the
 * session panel 320 (VIEW_LAYOUTS); three columns with a bot, a row of minis
 * and five lines of resources need something between the two.
 */
const HOME_H = 248;
/** The island's entrance curve (.view.on in style.css): what moves, moves like this. */
const SPRING = "cubic-bezier(0.3, 1.2, 0.4, 1)";
/** Drawn for stroke rendering, like the panel's icons: no expand mark in icons.ts yet. */
const EXPAND = "M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6";
const MAIN_BOT = 58;
const MINI_BOT = 22;
const CPU_SAMPLE_MS = 2500;
const CPU_POINTS = 24;
const RAM_TOTAL_GB = 16;

// ── State of the preview ──────────────────────────────────────────────────────

let sessions: FakeSession[] = fakeSessions(4);
let hooksMissing = false;
let usage: FakeUsage | null = fakeUsage(2);
let noUsageReason = 0;
const cpu: number[] = [];
let hoverId: string | null = null;
let listOpen = false;
/** Where each session stood last time: nothing reshuffles in a group under the pointer. */
let lastIndex = new Map<string, number>();
let pointerInRow = false;

// ── The island ────────────────────────────────────────────────────────────────

const mainBot = mountBot(MAIN_BOT, true);
const whoName = h("b", { class: "name" });
const whoWords = h("span", { class: "words" });
const doing = h("div", { class: "hb-doing" });
const actions = h("div", { class: "hb-actions" });
const botCard = h(
  "div", { class: "card wash home-bot" },
  h("div", { class: "hb-stage" }, mainBot.el),
  h("div", { class: "hb-who" }, whoName, whoWords),
  doing,
  actions,
);

interface LaneEl { el: HTMLElement; count: HTMLElement; bots: HTMLElement }
const LANES: { key: Lane; title: string }[] = [
  { key: "needs", title: "Needs you" },
  { key: "working", title: "Working" },
  { key: "done", title: "Done" },
];
const lanes = new Map<Lane, LaneEl>();
for (const { key, title } of LANES) {
  const count = h("i");
  const bots = h("div", { class: "lane-bots" });
  lanes.set(key, { el: h("div", { class: `lane ${key}` }, h("div", { class: "lane-h" }, title, " ", count), bots), count, bots });
}
const more = h("button", { class: "more", onclick: (e: Event) => { e.stopPropagation(); toggleList(); } });
const laneRow = h("div", { class: "hs-lanes" }, ...LANES.map((l) => lanes.get(l.key)!.el), more);
const foot = h("div", { class: "hs-foot" });
const empty = h("div", { class: "hs-empty" });
const list = h("div", { class: "hs-list" });
const sessionsCard = h("div", { class: "card home-sessions" }, laneRow, empty, foot, list);

laneRow.addEventListener("pointerenter", () => { pointerInRow = true; });
laneRow.addEventListener("pointerleave", () => { pointerInRow = false; render(); });

// Resources: every line is built once and only its words change, so nothing moves.
const cpuValue = h("span", { class: "res-value cpu", text: "—" });
const cpuSpark = sparkline();
const ramValue = h("span", { class: "res-value" });
const ramFill = h("i");
const usageRows = (["5 h", "7 d"] as const).map((label) => {
  const resets = h("span", { class: "res-sub" });
  const value = h("span", { class: "res-value" });
  const fill = h("i");
  const el = h(
    "div", { class: "res-row" },
    h("div", { class: "res-head" }, h("b", { text: label }), resets, value),
    h("div", { class: "res-bar" }, fill),
  );
  return { el, resets, value, fill };
});
const noUsage = h("div", { class: "res-none" });
const usageBox = h("div", { class: "res-usage" }, usageRows[0].el, usageRows[1].el, noUsage);
const usageAge = h("div", { class: "res-age" });
const resCard = h(
  "div", { class: "card home-res" },
  h("div", { class: "res-row" }, h("div", { class: "res-head" }, h("b", { text: "CPU" }), cpuSpark.el, cpuValue)),
  h("div", { class: "res-row" },
    h("div", { class: "res-head" }, h("b", { text: "RAM" }), h("span", { class: "grow" }), ramValue),
    h("div", { class: "res-bar" }, ramFill)),
  h("div", { class: "lane-h", text: "Claude usage" }),
  usageBox,
  usageAge,
);

const header = h(
  "div", { id: "header" },
  h("div", { class: "tabs" },
    h("button", { class: "tab on", title: "Home" }, svg(ICONS.house, 13)),
    h("button", { class: "tab", title: "Shelf" }, svg(ICONS.stack, 13)),
    h("span", { class: "tab pv-reserved", title: "Reserved — to be decided" }, svg(ICONS.add, 11, { stroke: 2 }))),
  h("div", { class: "header-actions" },
    h("button", { title: "Larger" }, svg(EXPAND, 14, { stroke: 2 })),
    h("button", { title: "Settings" }, svg(ICONS.gear, 14))),
);

const content = h(
  "div", { id: "content" },
  header,
  h("div", { id: "views" }, h("div", { class: "view on" }, h("div", { class: "home" }, botCard, sessionsCard, resCard))),
);

const island = h(
  "div",
  {
    class: "pv-island",
    style: `width:${EXPANDED_W}px;height:${HOME_H}px`,
  },
  content,
);

const OPEN = { w: EXPANDED_W, h: HOME_H, ear: EAR_EXPANDED, corner: EXPANDED_CORNER };
const notch = new Notch(island, OPEN);

/** The island unfolding from its compact size: the ears and corners grow with it, on the same spring. */
function replayOpen() {
  notch.set({ w: COMPACT_W, h: NOTCH_H, ear: EAR_COMPACT, corner: ROUNDED_CORNER }, false);
  content.style.transition = "none";
  content.style.opacity = "0";
  window.setTimeout(() => {
    notch.set(OPEN);
    content.style.transition = "";
    content.style.opacity = "1";
  }, 350);
}

// ── The mini bots: one per session on show, kept from one render to the next ──

interface Cell { el: HTMLButtonElement; bot: MiniBot; kids: HTMLElement; mark: HTMLElement }
const cells = new Map<string, Cell>();

function makeCell(s: FakeSession): Cell {
  const bot = mountMini(shownState(s), MINI_BOT);
  const mark = h("i", { class: "unseen" });
  const kids = h("span", { class: "kids" });
  const el = h("button", { class: "agent" }, bot.el, mark, kids);
  el.addEventListener("pointerenter", () => { hoverId = s.id; renderFoot(); });
  el.addEventListener("pointerleave", () => { if (hoverId === s.id) hoverId = null; renderFoot(); });
  el.addEventListener("click", () => open(s.id));
  return { el, bot, kids, mark };
}

function updateCell(cell: Cell, s: FakeSession) {
  const state = shownState(s);
  cell.bot.engine.setState(state);
  cell.el.classList.toggle("rest", isResting(s));
  cell.mark.hidden = !(state === "finished" && !s.seen);

  clear(cell.kids);
  // The one asking first: it is never the one folded into "+N".
  const running = [...runningSubagents(s)].sort((a, b) => Number(b.asking) - Number(a.asking));
  for (const a of running.slice(0, MAX_CHILD_DOTS)) {
    cell.kids.append(h("i", { class: a.asking ? "asking" : "", style: `--c:${subagentColor(a)}` }));
  }
  if (running.length > MAX_CHILD_DOTS) cell.kids.append(h("small", { text: `+${running.length - MAX_CHILD_DOTS}` }));
}

/** A cell that leaves fades where it stands, out of the row's flow, while the others close up. */
function dropCell(id: string, cell: Cell) {
  cells.delete(id);
  if (!cell.el.isConnected) return;
  const r = cell.el.getBoundingClientRect();
  const base = sessionsCard.getBoundingClientRect();
  cell.el.style.position = "absolute";
  cell.el.style.left = `${(r.left - base.left) / stageZoom()}px`;
  cell.el.style.top = `${(r.top - base.top) / stageZoom()}px`;
  cell.el.style.pointerEvents = "none";
  sessionsCard.append(cell.el);
  const gone = cell.el.animate(
    [{ opacity: getComputedStyle(cell.el).opacity, transform: "none" }, { opacity: 0, transform: "scale(0.7)" }],
    { duration: 420, easing: "ease-in", fill: "forwards" },
  );
  gone.onfinish = () => {
    cell.bot.release();
    cell.el.remove();
  };
}

/** A session's panel is not in this preview; opening it is what marks a result as seen. */
function open(id: string) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  if (shownState(s) === "finished" && !s.seen) {
    s.seen = true;
    say(`Opened ${labelText(s, sessions)}: its result is seen, so it fades ${span(FADE_AFTER_MS)} after it finished.`);
  } else {
    say(`A click opens ${labelText(s, sessions)}'s session panel (not in this preview).`);
  }
  listOpen = false;
  render();
}

// ── Render ────────────────────────────────────────────────────────────────────

function showOrder(live: FakeSession[]): FakeSession[] {
  const order = byUrgency(live);
  if (pointerInRow) {
    const at = (s: FakeSession) => lastIndex.get(s.id) ?? Number.POSITIVE_INFINITY;
    order.sort((a, b) => rank(a) - rank(b) || at(a) - at(b) || a.since - b.since);
  }
  lastIndex = new Map(order.map((s, i) => [s.id, i]));
  return order;
}

function render() {
  const live = sessions.filter((s) => !hasFaded(s));
  const order = showOrder(live);
  const visible = order.slice(0, MAX_VISIBLE);
  const hidden = order.slice(MAX_VISIBLE);

  // Where everything stands now, to move it from there to where it goes.
  const before = new Map<string, DOMRect>();
  for (const [id, cell] of cells) before.set(id, cell.el.getBoundingClientRect());
  const moreBefore = more.hidden ? null : more.getBoundingClientRect();

  for (const [id, cell] of [...cells]) {
    if (!visible.some((s) => s.id === id)) dropCell(id, cell);
  }

  let first = true;
  for (const { key } of LANES) {
    const lane = lanes.get(key)!;
    const mine = visible.filter((s) => laneOf(s) === key);
    lane.el.hidden = mine.length === 0;
    lane.el.classList.toggle("sep", !first && mine.length > 0);
    if (mine.length) first = false;
    lane.count.textContent = String(mine.length);
    for (const s of mine) {
      let cell = cells.get(s.id);
      const fresh = !cell;
      if (!cell) {
        cell = makeCell(s);
        cells.set(s.id, cell);
      }
      updateCell(cell, s);
      lane.bots.append(cell.el);
      if (fresh) {
        cell.el.animate(
          [{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "none" }],
          { duration: 320, easing: SPRING },
        );
      }
    }
  }

  // "+N" wears the colour of the most urgent session it hides: a hidden request is never silent.
  more.hidden = hidden.length === 0;
  if (hidden.length) {
    more.textContent = `+${hidden.length}`;
    wear(more, colorOf(hidden[0]));
    more.classList.toggle("calls", rank(hidden[0]) === 0);
    more.title = `${hidden.length} more`;
  } else {
    listOpen = false;
  }

  for (const [id, cell] of cells) slide(cell.el, before.get(id));
  if (!more.hidden) slide(more, moreBefore ?? undefined);

  renderEmpty(live.length === 0);
  renderMain(order[0] ?? null);
  renderList(hidden);
  if (hoverId && !visible.some((s) => s.id === hoverId)) hoverId = null;
  renderFoot();
  renderStatus(live.length, visible.length);
}

/** From where it was to where it is, on the island's curve. */
function slide(el: HTMLElement, from: DOMRect | undefined) {
  if (!from) return;
  const to = el.getBoundingClientRect();
  const dx = (from.left - to.left) / stageZoom();
  const dy = (from.top - to.top) / stageZoom();
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  el.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
    { duration: 420, easing: SPRING },
  );
}

const WASH: Partial<Record<BotStateName, Wash>> = {
  approval: "amber", question: "cyan", error: "red", finished: "green",
};

function renderMain(front: FakeSession | null) {
  clear(actions);
  if (!front) {
    mainBot.setState(hooksMissing ? "sleeping" : "idle");
    botCard.style.setProperty("--wash", washRGBA("soft"));
    whoName.textContent = hooksMissing ? "Not connected" : "No sessions";
    whoName.title = "";
    whoWords.textContent = "";
    doing.textContent = hooksMissing ? "Claude Code can't reach Nook yet" : "Nothing is running";
    doing.title = "";
    return;
  }
  const state = shownState(front);
  mainBot.setState(state);
  botCard.style.setProperty("--wash", washRGBA(WASH[state] ?? "soft"));
  whoName.textContent = labelText(front, sessions);
  whoName.title = front.cwd;
  whoWords.textContent = stateWords(front);
  whoWords.style.color = isResting(front) ? "" : colorOf(front);
  doing.textContent = front.doing;
  doing.title = front.doing;
  if (state === "approval") {
    // Inert here: the approval card's own buttons, at this card's scale.
    actions.append(
      h("button", { class: "btn secondary", text: "Deny" }),
      h("button", { class: "btn primary", text: "Allow" }),
    );
  }
}

function renderEmpty(none: boolean) {
  empty.hidden = !none;
  laneRow.hidden = none;
  foot.hidden = none;
  clear(empty);
  if (!none) return;
  if (hooksMissing) {
    empty.append(
      h("div", { class: "title", text: "Hooks not installed" }),
      h("div", { class: "sub", text: "Nook hears about sessions through Claude Code's hooks. Install them to see sessions here." }),
      h("button", { class: "btn secondary" }, svg(ICONS.gear, 12), "Open Settings"),
    );
  } else {
    empty.append(
      h("div", { class: "title", text: "No Claude Code sessions" }),
      h("div", { class: "sub" }, "Run ", h("code", { class: "code", text: "claude" }), " in any project folder and it shows up here."),
    );
  }
}

function renderFoot() {
  clear(foot);
  const s = hoverId ? sessions.find((x) => x.id === hoverId) : null;
  if (!s) {
    foot.classList.add("quiet");
    foot.append(h("div", { class: "hf-doing", text: "Hover a bot for its project and what it is doing. Click opens its session." }));
    return;
  }
  foot.classList.remove("quiet");
  const { name, n } = labelOf(s, sessions);
  const running = runningSubagents(s).length;
  foot.append(
    h("div", { class: "hf-who" },
      h("i", { class: "dot", style: `width:6px;height:6px;background:${colorOf(s)}` }),
      h("b", { text: name, title: s.cwd }),
      n == null ? null : h("em", { text: `·${n}` }),
      h("span", { text: stateWords(s) }),
      running ? h("span", { class: "subs", text: `${running} subagent${running === 1 ? "" : "s"} running` }) : null),
    h("div", { class: "hf-doing", text: s.doing, title: s.doing }),
  );
}

function renderList(hidden: FakeSession[]) {
  list.hidden = !listOpen || hidden.length === 0;
  clear(list);
  for (const s of hidden) {
    const { name, n } = labelOf(s, sessions);
    list.append(h(
      "button", { class: "gh-row", title: `${s.cwd}\n${s.doing}`, onclick: () => open(s.id) },
      h("i", { class: "dot", style: `width:7px;height:7px;background:${colorOf(s)}` }),
      h("span", { class: "gh-row-title" }, name, n == null ? null : h("em", { text: ` ·${n}` })),
      h("span", { class: "gh-row-where", text: stateWords(s) }),
      h("span", { class: "int-ago", text: waited(s) }),
    ));
  }
}

function toggleList() {
  listOpen = !listOpen;
  render();
  if (listOpen) list.animate([{ opacity: 0, transform: "translateY(7px) scale(0.985)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: SPRING });
}

document.addEventListener("click", (e) => {
  if (listOpen && !list.contains(e.target as Node)) { listOpen = false; render(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && listOpen) { listOpen = false; render(); }
});

// ── Resources ─────────────────────────────────────────────────────────────────

function sparkline() {
  const NS = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", `0 0 ${CPU_POINTS - 1} 14`);
  el.setAttribute("preserveAspectRatio", "none");
  el.setAttribute("class", "res-spark");
  const area = document.createElementNS(NS, "path");
  area.setAttribute("class", "area");
  const line = document.createElementNS(NS, "path");
  line.setAttribute("class", "line");
  el.append(area, line);
  return {
    el,
    draw(values: number[]) {
      if (values.length < 2) {
        // Nothing measured yet: a flat line where the trace will be.
        line.setAttribute("d", `M0 13H${CPU_POINTS - 1}`);
        area.setAttribute("d", "");
        return;
      }
      const x0 = CPU_POINTS - values.length;
      const pts = values.map((v, i) => `${x0 + i} ${(13 - (v / 100) * 12).toFixed(1)}`);
      line.setAttribute("d", `M${pts.join("L")}`);
      area.setAttribute("d", `M${x0} 14L${pts.join("L")}L${CPU_POINTS - 1} 14Z`);
    },
  };
}

/** "2h 14m", "3d 4h": until a limit's window starts again. */
function until(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const usageColor = (percent: number) => (percent >= 90 ? COLOR.red : percent >= 70 ? COLOR.amber : COLOR.blue);

function renderResources() {
  // CPU needs two samples: "—" in the same cell until the first real one.
  cpuValue.textContent = cpu.length ? `${Math.round(cpu[cpu.length - 1])}%` : "—";
  cpuValue.classList.toggle("blank", cpu.length === 0);
  cpuSpark.draw(cpu);

  const used = 11.2;
  ramValue.textContent = `${used.toFixed(1)} / ${RAM_TOTAL_GB.toFixed(1)} GB`;
  ramFill.style.width = `${(used / RAM_TOTAL_GB) * 100}%`;

  const windows = usage ? [usage.fiveHour, usage.sevenDay] : [];
  usageRows.forEach((row, i) => {
    const w = windows[i];
    row.el.style.visibility = w ? "visible" : "hidden";
    if (!w) return;
    row.value.textContent = `${w.used}%`;
    row.resets.textContent = `resets in ${until(w.resetsAt - clock.now())}`;
    row.fill.style.width = `${w.used}%`;
    row.fill.style.background = usageColor(w.used);
  });

  noUsage.hidden = usage != null;
  clear(noUsage);
  if (!usage) noUsage.append(h("b", { text: "No usage data yet" }), h("span", { text: NO_USAGE_REASONS[noUsageReason] }));

  const age = usage ? clock.now() - usage.updatedAt : 0;
  const stale = usage != null && age > USAGE_STALE_MS;
  usageBox.classList.toggle("stale", stale);
  usageAge.classList.toggle("stale", stale);
  usageAge.textContent = !usage ? "" : age < 60_000 ? "updated just now" : `updated ${span(age)} ago`;
}

// The metrics thread's first reading comes one interval after the island shows.
window.setInterval(() => {
  const last = cpu.length ? cpu[cpu.length - 1] : 31;
  cpu.push(Math.max(4, Math.min(96, last + (Math.random() - 0.5) * 22)));
  if (cpu.length > CPU_POINTS) cpu.shift();
  renderResources();
}, CPU_SAMPLE_MS);

// Time passing on its own: a session that reaches its fade time leaves without a click.
let fadedKey = "";
window.setInterval(() => {
  const key = sessions.filter(hasFaded).map((s) => s.id).join();
  if (key !== fadedKey) render();
  fadedKey = key;
  renderResources();
}, 5000);

// ── Preview controls (outside the island) ─────────────────────────────────────

const status = h("div", { class: "pv-status" });
const note = h("div", { class: "pv-note" });
const say = (text: string) => { note.textContent = text; };

function renderStatus(live: number, visible: number) {
  const skew = clock.skew ? `clock +${span(clock.skew)}` : "clock: now";
  status.textContent =
    `${sessions.length} tracked · ${visible} on show · ${live - visible} behind "+N" · ${sessions.length - live} faded · ${skew}`;
}

function load(next: FakeSession[], text: string, missing = false) {
  sessions = next;
  hooksMissing = missing;
  clock.skew = 0;
  usage = usage ? fakeUsage(2) : null;
  hoverId = null;
  listOpen = false;
  say(text);
  refresh();
}

function refresh() {
  render();
  renderResources();
}

function subagents(scenario: SubagentScenario, text: string) {
  if (!sessions.some((s) => !hasFaded(s))) sessions = fakeSessions(4);
  hooksMissing = false;
  // Always the same session (the first one), so the scenarios replace each other.
  const target = hasFaded(sessions[0]) ? sessions.find((s) => !hasFaded(s))! : sessions[0];
  applySubagents(target, scenario);
  say(`${labelText(target, sessions)}: ${text}`);
  refresh();
}

const button = (label: string, run: () => void) => h("button", { class: "pv-btn", text: label, onclick: (e: Event) => { e.stopPropagation(); run(); } });
const group = (title: string, ...buttons: HTMLElement[]) => h("div", { class: "pv-group" }, h("span", { text: title }), ...buttons);

const controls = h(
  "section", { class: "pv-controls" },
  h("h2", { text: "Preview controls" }),
  h("p", { text: "Outside the island: these stand in for what Claude Code and the clock would do." }),
  group("Sessions",
    button("0", () => load([], "No sessions: the middle says how to start one.")),
    button("0 · hooks not installed", () => load([], "No sessions because the hooks are not installed.", true)),
    button("1", () => load(fakeSessions(1), "One session.")),
    button("4", () => load(fakeSessions(4), "Four sessions, two of them in the same folder (nook ·1, nook ·2).")),
    button("8", () => load(fakeSessions(8), "Eight sessions: the six most urgent on show, the rest behind \"+2\".")),
    button("all 8 need attention", () => load(allNeedAttention(), "All eight ask at once: \"+2\" takes the colour of the most urgent one it hides."))),
  group("Edge cases",
    button("add a very long folder name", () => {
      const long = sessions.find((s) => s.cwd === longNameSession().cwd);
      if (long) {
        long.state = "approval";
        long.doing = "Bash · pnpm --filter @client/core run build:production";
        long.since = clock.now() - 20 * 60_000;
        say("The long folder now asks for permission: it is the front session, in the bot's card.");
      } else {
        sessions.push(longNameSession());
        hooksMissing = false;
        say("Added. Hover it (or open \"+N\") to see the name cut; click the button again to make it ask.");
      }
      refresh();
    }),
    button("finished → working again", () => {
      const done = sessions.filter((s) => shownState(s) === "finished");
      const s = done.find(hasFaded) ?? done[0];
      if (!s) return say("No finished session to wake: load 4 or 8 first.");
      const was = hasFaded(s) ? "had faded and comes back" : "leaves Done";
      s.state = "working";
      s.doing = "Shell · npm test";
      s.since = clock.now();
      s.seen = false;
      say(`${labelText(s, sessions)} ${was}: it is working again.`);
      refresh();
    }),
    button("fast-forward 5 min", () => {
      clock.skew += FADE_AFTER_MS;
      say("Five minutes later: finished sessions that were seen fade; one with an unseen result keeps its green mark for 30 min.");
      refresh();
    })),
  group("Subagents",
    button("2 running", () => subagents("two", "two subagents running, a dot each.")),
    button("one asking", () => subagents("asking", "one of its subagents asks for permission: its dot is amber.")),
    button("main stopped, subagents run", () => subagents("stopped", "its main turn stopped but two subagents run: it shows as working, not finished.")),
    button("6 running", () => subagents("six", "six subagents: four dots, then \"+2\"."))),
  group("Usage",
    button("fresh", () => { usage = fakeUsage(2); say("Usage updated 2 minutes ago."); renderResources(); }),
    button("stale", () => { usage = fakeUsage(14); say("Usage is 14 minutes old: past 10 minutes the bars dim."); renderResources(); }),
    button("none", () => {
      noUsageReason = usage ? 0 : (noUsageReason + 1) % NO_USAGE_REASONS.length;
      usage = null;
      say("No usage has ever arrived. Click again for the next reason.");
      renderResources();
    })),
  shapeControls(),
  group("Motion", button("replay open", () => { say("From the compact size to the open one: ears 9 → 16 px and the corners grow on the island's own spring."); replayOpen(); })),
  status,
  note,
);

document.getElementById("root")!.append(
  h("div", { class: "pv-desk" }, island),
  controls,
);

say("Four sessions, two of them in the same folder (nook ·1, nook ·2).");
refresh();
startBots();
