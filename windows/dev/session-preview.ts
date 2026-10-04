// Dev harness: the redesigned session panel, with subagents, on fake data in a
// plain browser (plans/design-plan.md section 3, plans/subagents-plan.md).
// Not part of the app bundle, and nothing in src/ knows of it.
// `npx vite`, then /dev/session-preview.html.
//
// What is the app's own: the style sheet (surfaces, radii, type), the bot
// (BotEngine — the only thing on this page that draws a character), how a step
// is drawn (stepIcon, stepName, stepPreview, diffs, Markdown), the island's
// spring and close curve. What is new, and drawn here only: the sidebar's tree
// of sessions and their subagents, the filter chips, the line of the journal
// where a subagent was launched, a subagent's own view, the expand button, and
// the line that names who is asking on a permission or a question card.

import "../src/style.css";
import "./preview-b/controls.css";
import "./preview-b/session-preview.css";
import { Tracked } from "../src/core/anim";
import { wipe } from "../src/core/canvas";
import {
  EXPANDED_CORNER, EXPANDED_W, PANEL_H, PANEL_W, SESSION_BOT, VIEW_LAYOUTS,
  botGlowColor, botGlowOpacity, fittedHeight, washRGBA, type BotStateName,
} from "../src/core/layout";
import { BotEngine } from "../src/bot/engine";
import { DECISION_WORDS, QUESTION_TOOL, type ClaudeSession, type SessionStep } from "../src/core/state";
import { clear, dot, h, svg } from "../src/views/dom";
import { ICONS } from "../src/views/icons";
import { COLOR } from "../src/views/palette";
import { LUCIDE, lucide } from "../src/views/iconset";
import { reply as replyView, type PathOpener, type ReplyFold } from "../src/views/markdown";
import { stepIcon, stepName, stepPreview } from "../src/views/step";
import { controls, picker } from "./preview-b/controls";
import { checkMarkdown, checkPathLinks } from "./preview-b/markdown-check";
import {
  ASKED_BY, ENDED_AGO, EXAMPLE_AGENT, EXAMPLE_ID, EXAMPLE_REPLY, ENDED_REPLY, ENDED_RESULTS, LONG_FOLDER, LONG_REPLY, LONG_TITLES, MAIN_ID, QUESTION,
  REQUEST_MAIN, REQUEST_QUEUED, REQUEST_SUBAGENT, SESSIONS, SHOWN,
  type PreviewSession, type Request, type Subagent,
} from "./preview-b/session-data";

// ── What the preview can be put in ────────────────────────────────────────────

/** What the session on show holds. */
type Scenario = "default" | "five" | "ended";
/** Who is waiting for an answer in it. */
type Ask = "none" | "subagent" | "queued" | "unnamed" | "main" | "question";
/** What the panel shows: the main session, or one of the subagents the controls name. */
type Open = "main" | "running" | "finished" | "asking";
type Filter = "all" | "edit" | "command" | "read" | "search";
type OnOff = "off" | "on";

const SCENARIOS = ["default", "five", "ended"] as const;
const ASKS = ["none", "subagent", "queued", "unnamed", "main", "question"] as const;
const OPENS = ["main", "running", "finished", "asking"] as const;

const params = new URLSearchParams(location.search);
const among = <T extends string>(value: string | null, all: readonly T[], fallback: T): T =>
  all.includes(value as T) ? (value as T) : fallback;

const LOADED = Date.now();
const firstScenario = among<Scenario>(params.get("scenario"), SCENARIOS, "default");
const firstCard = among<Ask>(params.get("card"), ASKS, "none");
const firstOpen = among<Open>(params.get("open"), OPENS, "main");
/** `session=reply`: the session whose reply has everything the Markdown draws; `open=result`: its subagent's long result. */
const onExample = params.get("session") === "reply";

const ui = {
  large: params.get("size") === "large",
  scenario: firstScenario,
  /** Who is asking. In the default scenario a subagent is, with the session panel still on show. */
  ask: (firstCard !== "none" ? firstCard : firstScenario === "ended" ? "none" : "subagent") as Ask,
  /** The card that asks is on show, in the session panel's place. */
  card: firstCard !== "none",
  /** How the request was answered on its card, once it has been. */
  answered: null as "allowed" | "denied" | null,
  /** One more subagent has just started. */
  newAgent: false,
  /** When the session's turn ended, in the scenario where it has. */
  endedAt: LOADED - ENDED_AGO,
  longFolder: params.get("folder") === "long",
  longTitle: params.get("title") === "long",
  /** Older Claude Code: tool events carry no agent id. */
  noIds: params.get("ids") === "missing",
  front: onExample ? EXAMPLE_ID : MAIN_ID,
  /** The subagent on show; none for the main session's journal. */
  agent: (onExample ? (params.get("open") === "result" ? EXAMPLE_AGENT : null) : firstOpen === "main" ? null : SHOWN[firstOpen]) as string | null,
  filter: "all" as Filter,
};

// ── Sessions: where each stands ───────────────────────────────────────────────

const byId = (id: string) => SESSIONS.find((s) => s.session.id === id) ?? SESSIONS[0];
const front = () => byId(ui.front);
const isMain = (pv: PreviewSession) => pv.session.id === MAIN_ID;
const ended = (pv: PreviewSession) => isMain(pv) && ui.scenario === "ended";

/** The folder a session works in, by its name: the main one's can be made long. */
const folderOf = (s: ClaudeSession) => (s.id === MAIN_ID && ui.longFolder ? LONG_FOLDER : s.project);

/**
 * A project's colour, for the thin stripe beside its sessions: one of eight hues picked by a hash of the
 * folder's name, as the approved mockup has it. (layout.ts `colorForProject` has four, too few to tell
 * four sessions apart.)
 */
const HUES = ["#3B9EFF", "#F472B6", "#A3E635", "#FB923C", "#8B5CF6", "#2DD4BF", "#FACC15", "#F87171"];
function stripe(project: string): string {
  let hash = 0;
  for (const ch of project) hash = (Math.imul(31, hash) + ch.charCodeAt(0)) | 0;
  return HUES[Math.abs(hash) % HUES.length];
}

/** A session's state, with what the scenario on show does to the main one. */
function stateOf(s: ClaudeSession): BotStateName {
  if (s.id !== MAIN_ID) return s.state;
  if (ui.scenario === "ended") return "finished";
  if (ui.ask === "question") return "question";
  if (ui.ask !== "none") return "approval";
  return s.state;
}

/** Where a session is at: a colour, words, and how urgent (0 first). As session.ts `standing`, with the plan's order. */
function standing(s: ClaudeSession): { color: string; words: string; rank: number } {
  const state = stateOf(s);
  switch (state) {
    case "question": return { color: COLOR.cyan, words: "is asking a question", rank: 0 };
    case "approval": return { color: COLOR.amber, words: "needs permission", rank: 0 };
    case "error": return { color: COLOR.red, words: "stopped on an error", rank: 1 };
    // Its last reply waits on a decision: said after a request and an error, before "finished".
    case "finished": return s.decision ? { color: COLOR.purple, words: DECISION_WORDS.toLowerCase(), rank: 3 } : { color: COLOR.green, words: "finished", rank: 3 };
    case "idle":
    case "sleeping": return { color: COLOR.grey, words: "at rest", rank: 4 };
    default: return { color: botGlowColor(state), words: state === "thinking" ? "thinking" : "at work", rank: 2 };
  }
}

/**
 * The sidebar's order: the order the sessions were first heard in, which does not change. (The order by
 * urgency the earlier preview had would move a row from under the keyboard each time a request came in.)
 */
const ordered = () => SESSIONS;

// ── The bot ───────────────────────────────────────────────────────────────────
// The character is the app's: BotEngine (src/bot/engine.ts) updates it and
// draws it, `engine.draw(ctx, w, h)`, on the one canvas below. Nothing else on
// this page draws a character — no CSS shape, no SVG, no canvas code of its own.

/** As in island.ts: room above the body for what flies out of it. */
const OVERHANG = 40;
const DPR = Math.min(2, window.devicePixelRatio || 1);

/** The real engine, drawn the way island.ts draws its own: a canvas of `diameter / 0.6`, and the glow under it. */
const bot = (() => {
  const engine = new BotEngine();
  engine.particleOverhang = OVERHANG;
  const glow = h("div", { class: "pv-glow" });
  const canvas = h("canvas", {});
  const el = h("div", { class: "pv-bot" }, glow, canvas);
  el.addEventListener("mousedown", () => engine.slap());
  let size = 0;
  return {
    el,
    engine,
    fit(diameter: number) {
      const next = Math.round(diameter / 0.6);
      if (next === size) return;
      size = next;
      el.style.width = el.style.height = `${size}px`;
      el.style.setProperty("--d", `${diameter}px`);
      canvas.width = Math.round(size * DPR);
      canvas.height = Math.round((size + OVERHANG) * DPR);
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size + OVERHANG}px`;
      canvas.style.top = `${-OVERHANG}px`;
      glow.style.width = glow.style.height = `${diameter * 2.2}px`;
      glow.style.left = glow.style.top = `${size / 2 - diameter * 1.1}px`;
    },
    wear(state: BotStateName) {
      engine.setState(state);
      glow.style.background = `radial-gradient(circle, ${botGlowColor(state)} 0%, transparent 62%)`;
      glow.style.opacity = String(botGlowOpacity(state));
    },
    frame(dt: number, mouse: { x: number; y: number }) {
      const r = el.getBoundingClientRect();
      engine.lookX = Math.tanh((mouse.x - (r.left + r.width / 2)) / 260);
      engine.lookY = -Math.tanh((mouse.y - (r.top + r.height / 2)) / 200);
      engine.update(dt);
      const ctx = canvas.getContext("2d");
      if (!ctx || size === 0) return;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      wipe(ctx);
      engine.draw(ctx, size, size + OVERHANG);
    },
  };
})();

// ── Subagents: what the panel knows of each ───────────────────────────────────

/** A subagent as the panel shows it: the data's, with what the scenario on show does to it. */
interface Sub {
  id: string;
  sessionId: string;
  type: string;
  /** What it was launched to do; null when no event named it. */
  description: string | null;
  state: Subagent["state"];
  /** It is waiting for an answer: a permission, or a question. */
  asking: boolean;
  startedAt: number;
  endedAt: number | null;
  result: string | null;
  steps: SessionStep[];
}

const titleOf = (a: Pick<Sub, "description">) => a.description ?? "Subagent";

/** The requests waiting in the main session, the oldest first. */
function requests(): Request[] {
  switch (ui.ask) {
    case "subagent":
    case "unnamed": return [REQUEST_SUBAGENT];
    case "queued": return [REQUEST_SUBAGENT, REQUEST_QUEUED];
    case "main": return [REQUEST_MAIN];
    default: return [];
  }
}

/** The step a request is about, as the journal holds it while the answer is awaited — and after. */
function requestStep(r: Request, permission: SessionStep["permission"], at: number): SessionStep {
  return {
    tool: r.tool, kind: r.kind, state: permission === "denied" ? "failed" : "running", target: r.target,
    result: null, patch: null, questions: null, answers: null, permission, at,
  };
}

/** Steps that came with a request, after the data's own: the one waiting for its answer, or the one that got it. */
function askedSteps(agentId: string | null): SessionStep[] {
  const steps: SessionStep[] = [];
  requests().forEach((r, i) => {
    if (r.agentId === agentId) steps.push(requestStep(r, "asked", LOADED - 20000 + i * 1000));
  });
  if (ui.ask === "question" && agentId === ASKED_BY) {
    steps.push({ ...requestStep({ agentId, tool: QUESTION_TOOL, kind: "other", target: QUESTION.question }, null, LOADED - 15000), questions: [QUESTION] });
  }
  if (ui.ask === "none" && ui.answered && agentId === REQUEST_SUBAGENT.agentId) {
    steps.push(requestStep(REQUEST_SUBAGENT, ui.answered, LOADED - 20000));
  }
  return steps;
}

const settled = (steps: SessionStep[]) => steps.map((s) => (s.state === "running" ? { ...s, state: "done" as const } : s));

function subOf(pv: PreviewSession, a: Subagent): Sub {
  const main = isMain(pv);
  const over = ended(pv) && a.state === "running";
  const extra = main && !ended(pv) ? askedSteps(a.id) : [];
  const nameless = main && ui.ask === "unnamed" && a.id === REQUEST_SUBAGENT.agentId;
  return {
    id: a.id,
    sessionId: pv.session.id,
    type: a.type,
    description: nameless ? null : (ui.longTitle && LONG_TITLES[a.id]) || a.description,
    state: over ? "done" : a.state,
    // Without agent ids a request does not say which subagent it comes from.
    asking: !ui.noIds && extra.some((s) => s.permission === "asked" || s.questions != null),
    startedAt: a.startedAt,
    endedAt: over ? ui.endedAt : a.endedAt,
    result: over ? (ENDED_RESULTS[a.id] ?? null) : a.result,
    steps: over || extra.length > 0 ? [...settled(a.steps), ...extra] : a.steps,
  };
}

/** A session's lines for the scenario on show. */
function itemsOf(pv: PreviewSession) {
  if (!isMain(pv)) return pv.items;
  return pv.items.filter((item) => item.kind !== "launch" || !item.when || (item.when === "five" ? ui.scenario === "five" : ui.newAgent));
}

/** A session's subagents, in the order they started. */
function subsOf(pv: PreviewSession): Sub[] {
  const subs: Sub[] = [];
  for (const item of itemsOf(pv)) if (item.kind === "launch") subs.push(subOf(pv, item.agent));
  return subs;
}

/**
 * The subagents a session's sidebar row lists: all it launched, the finished ones dimmed — until the
 * session's turn is over, when they clear.
 */
function listed(pv: PreviewSession): Sub[] {
  const state = stateOf(pv.session);
  return state === "finished" || state === "idle" || state === "sleeping" ? [] : subsOf(pv);
}

// ── The sidebar's tree: what is open ──────────────────────────────────────────
// The rule: a session's subagents show while one of them runs. Closed by hand,
// they stay closed until they are opened by hand or a NEW subagent starts (the
// count of subagents is kept at the moment of closing: more than that, and the
// row follows its subagents again). Opened by hand, they stay open — finished
// subagents too — until closed.

type Fold = { open: true } | { open: false; count: number };
const folds = new Map<string, Fold>();
if (params.get("sidebar") === "collapsed") folds.set(MAIN_ID, { open: false, count: subsOf(byId(MAIN_ID)).length });

function expanded(pv: PreviewSession, subs = listed(pv)): boolean {
  if (subs.length === 0) return false;
  const fold = folds.get(pv.session.id);
  if (fold?.open) return true;
  if (fold && subs.length <= fold.count) return false;
  if (fold) folds.delete(pv.session.id);
  return subs.some((a) => a.state === "running");
}

function setExpanded(pv: PreviewSession, open: boolean) {
  folds.set(pv.session.id, open ? { open: true } : { open: false, count: listed(pv).length });
}

// ── A step, as the journal draws it ───────────────────────────────────────────
// session.ts keeps `journalEntry` to itself; this is the same entry, from the
// same pieces, with the one thing the redesign changes: at the panel's normal
// size a command or a file read is one line, and in the large panel the whole
// command wraps and what it printed is under it.

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const counted = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

const PERMISSIONS = {
  asked: { words: "needs permission", color: COLOR.amber },
  allowed: { words: "allowed", color: COLOR.green },
  denied: { words: "denied", color: COLOR.red },
} as const;

function chip(text: string, color: string): HTMLElement {
  const el = h("span", { class: "jr-chip", text });
  el.style.setProperty("--c", color);
  return el;
}

/** How something stands, as a small round mark: going, done, failed — or waiting for the user. */
const MARKS = {
  running: () => h("i", { class: "sess-mark run" }),
  done: () => h("i", { class: "sess-mark done" }, svg(ICONS.check, 8, { stroke: 3.2 })),
  failed: () => h("i", { class: "sess-mark failed" }, svg(ICONS.xmark, 7)),
  asking: () => h("i", { class: "sess-mark pv-needs" }, svg(ICONS.bang, 9)),
};

const markOf = (a: Sub) => (a.asking ? MARKS.asking() : MARKS[a.state]());

// ── A reply, as the app's journal draws it ────────────────────────────────────
// `reply()` is the app's own (src/views/markdown.ts): the Markdown, a very long
// reply's two forms, the chips that open a file. What session.ts adds is here
// as it is there: which form each reply is in, and the way to open a path —
// only for a session that runs in an editor. Nothing opens from a browser:
// the opener answers "no", and the chip says "not found", as it would for a
// file that is not there.

const replyFolds = new WeakMap<object, boolean>();
// `reply=long`: the example's place is taken by a reply long enough to be cut.
if (params.get("reply") === "long") {
  for (const pv of SESSIONS) {
    for (const it of pv.items) if (it.kind === "step" && it.step.kind === "reply" && it.step.target === EXAMPLE_REPLY) it.step.target = LONG_REPLY;
  }
}
// `reply=full`: every reply whole from the start — and so read: no badge.
if (params.get("reply") === "full") {
  for (const pv of SESSIONS) {
    for (const it of pv.items) if (it.kind === "step" && it.step.kind === "reply") replyFolds.set(it.step, true);
    pv.session.decision = false;
  }
}

/** Every path a chip was clicked for, as it would be handed to Rust: what a check reads (`opened` in the console). */
const opened: { session: string; path: string; line: number | null }[] = [];
Object.assign(window, { opened });

function openerOf(s: ClaudeSession): PathOpener | null {
  const { kind, label } = s.target;
  if (kind !== "vscode" && kind !== "cursor") return null;
  return {
    tip: `Open in ${label}`,
    open(path, line) {
      opened.push({ session: s.id, path, line });
      return Promise.resolve(false);
    },
  };
}

/** A long reply's form, and the way to its other one. Opened whole, a reply that waited on a decision has been read. */
function foldOf(key: object, s: ClaudeSession, last = false): ReplyFold {
  return {
    open: replyFolds.get(key) ?? false,
    toggle(open) {
      replyFolds.set(key, open);
      if (open && last) s.decision = false;
      render();
    },
  };
}

/** Lines of what a step did that its entry shows: fewer at the panel's normal size. */
const LINES = { normal: 6, large: 14 };

function entry(step: SessionStep, s: ClaudeSession, last = false): HTMLElement {
  if (step.kind === "prompt") {
    return h("div", { class: "jr jr-asked" }, h("div", { class: "sess-asked", text: step.target ?? "", title: clock(step.at) }));
  }
  if (step.kind === "reply") {
    return h(
      "div",
      { class: "jr jr-reply" },
      h("div", { class: "sess-said" }, dot(COLOR.green, 6), h("b", { text: "Claude" }), h("span", { text: clock(step.at) })),
      replyView(step.target ?? "", openerOf(s), foldOf(step, s, last)),
    );
  }
  if (step.kind === "note") return h("div", { class: "jr jr-note", text: step.target ?? "" });

  const command = step.kind === "command";
  const whole = step.target ?? "";
  const head = h(
    "div",
    { class: "jr-head" },
    h("i", {}, stepIcon(step, 11)),
    h("b", { text: stepName(step) }),
    h("span", { class: "at", text: ui.large && command ? whole : whole.split("\n")[0], title: whole }),
    h("div", { class: "grow" }),
  );
  if (step.permission) head.append(chip(PERMISSIONS[step.permission].words, PERMISSIONS[step.permission].color));
  else if (step.questions && step.state === "running") head.append(chip("waiting for an answer", COLOR.cyan));
  if (step.state === "running") head.append(MARKS.running());
  else if (step.state === "failed" && !step.permission) head.append(chip("failed", COLOR.red));
  head.append(h("span", { class: "jr-time", text: clock(step.at) }));

  const el = h("div", { class: `jr jr-step ${step.state} ${step.kind}` }, head);
  let preview: HTMLElement | null = null;
  if (step.patch != null) preview = stepPreview(step, ui.large ? LINES.large : LINES.normal);
  // The command is in the head, whole: under it, only what it printed.
  else if (ui.large) preview = stepPreview(command ? { ...step, kind: "other" } : step, LINES.large);
  if (preview) el.append(h("div", { class: "jr-body" }, preview));
  return el;
}

// ── Time that runs ────────────────────────────────────────────────────────────

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** How long something has been going, kept up to date by the page's clock. */
function running(since: number): HTMLElement {
  const el = h("span", { class: "pv-elapsed", text: elapsed(Date.now() - since) });
  el.dataset.since = String(since);
  return el;
}

window.setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>(".pv-elapsed")) el.textContent = elapsed(Date.now() - Number(el.dataset.since));
}, 1000);

const took = (a: Sub) => elapsed((a.endedAt ?? Date.now()) - a.startedAt);

/** How a subagent stands, in words: "running 1m 23s" (the time ticks), "done in 1m 16s", "failed after 27s". */
function statusOf(a: Sub): HTMLElement {
  const el = h("span", { class: `pv-status ${a.asking ? "asking" : a.state}` });
  if (a.asking) el.append("needs you · ", running(a.startedAt));
  else if (a.state === "running") el.append("running ", running(a.startedAt));
  else el.append(a.state === "done" ? `done in ${took(a)}` : `failed after ${took(a)}`);
  return el;
}

const statusWords = (a: Sub) =>
  a.asking ? "waiting for your answer" : a.state === "running" ? "running" : a.state === "done" ? `done in ${took(a)}` : `failed after ${took(a)}`;

// ── The journal ───────────────────────────────────────────────────────────────

const FILTERS: readonly (readonly [Filter, string])[] = [
  ["all", "All"], ["edit", "Edits"], ["command", "Commands"], ["read", "Reads"], ["search", "Searches"],
];
const SAID = new Set<SessionStep["kind"]>(["prompt", "reply", "note"]);
const tools = (steps: SessionStep[]) => steps.filter((s) => !SAID.has(s.kind));
const wanted = (s: SessionStep) => ui.filter === "all" || s.kind === ui.filter;

/**
 * The place in the main journal where a subagent was launched: one line, with how it stands. A click
 * opens the subagent's own view.
 */
function launchRow(a: Sub): HTMLElement {
  const row = h(
    "button",
    {
      class: `jr pv-launch ${a.asking ? "asking" : a.state}`,
      title: `${a.type} · ${titleOf(a)} — ${statusWords(a)}. Open its steps.`,
      onclick: () => openAgent(a.sessionId, a.id),
    },
    markOf(a),
    h("b", { text: "Launched" }),
    h("span", { class: "pv-launch-type", text: `${a.type}:` }),
    h("span", { class: "pv-launch-task", text: titleOf(a) }),
    h("span", { class: "pv-launch-sep", text: "·" }),
    statusOf(a),
    h("span", { class: "grow" }),
    h("span", { class: "jr-time", text: clock(a.startedAt) }),
    h("i", { class: "pv-launch-go" }, svg(ICONS.chevronRight, 9, { stroke: 2.8 })),
  );
  return row;
}

/** The main session's own steps — and, with no agent ids, its subagents' among them, since they cannot be told apart. */
function mainSteps(pv: PreviewSession): SessionStep[] {
  const steps: SessionStep[] = [];
  for (const item of itemsOf(pv)) if (item.kind === "step") steps.push(item.step);
  const own = ended(pv) ? [...settled(steps), { ...ENDED_REPLY, at: ui.endedAt }] : isMain(pv) ? [...steps, ...askedSteps(null)] : steps;
  if (!ui.noIds) return own;
  // A subagent's steps — the one it asks permission for among them — are so many more of the session's.
  const all = [...own];
  for (const a of subsOf(pv)) all.push(...a.steps);
  return all.sort((x, y) => x.at - y.at);
}

function mainNodes(pv: PreviewSession): HTMLElement[] {
  const steps = mainSteps(pv);
  // The reply a decision waits on is the last thing the session said.
  const said = [...steps].reverse().find((s) => s.kind === "reply");
  const lines: { at: number; el: HTMLElement }[] = steps.filter(wanted).map((s) => ({ at: s.at, el: entry(s, pv.session, s === said) }));
  // A launch is not a step of a kind: it shows with everything, and gives way to a filter.
  if (ui.filter === "all") for (const a of subsOf(pv)) lines.push({ at: a.startedAt, el: launchRow(a) });
  lines.sort((x, y) => x.at - y.at);
  if (lines.length === 0) return [h("div", { class: "int-empty", text: "No step of this kind in this session yet." })];
  return lines.map((l) => l.el);
}

/** What a subagent's view ends on: what it came back with — or, while it runs, that it still does. */
function ending(a: Sub, s: ClaudeSession): HTMLElement {
  if (a.asking) {
    const request = requests().find((r) => r.agentId === a.id);
    const what = request ? `${request.tool} · ${request.target}` : QUESTION.question;
    return h(
      "div",
      { class: "jr pv-end asking" },
      MARKS.asking(),
      h("span", { class: "pv-end-words" }, h("b", { text: request ? "Waiting for your permission" : "Waiting for your answer" }), h("span", { class: "pv-end-what", text: what, title: what })),
      h("button", { class: "pv-end-btn", text: request ? "Show request" : "Show question", onclick: () => showCard() }),
    );
  }
  if (a.state === "running") {
    return h("div", { class: "jr pv-end running" }, MARKS.running(), h("span", { class: "pv-end-words" }, h("b", {}, "Still running · ", running(a.startedAt)), h("span", { text: "Its result will show here when it finishes." })));
  }
  const failed = a.state === "failed";
  return h(
    "div",
    { class: `jr pv-result ${a.state}` },
    h("div", { class: "pv-result-h" }, MARKS[a.state](), h("b", { text: failed ? "Stopped without finishing" : "Result" }), h("span", { text: `${failed ? "failed after" : "done in"} ${took(a)}` })),
    replyView(a.result ?? (failed ? "It said nothing before it stopped." : "It finished without a last message."), openerOf(s), foldOf(byAgent(a.id), s)),
  );
}

/** A subagent's own object in the data: what its result's form is kept by (a `Sub` is made anew each time). */
const byAgent = (id: string): object => {
  for (const pv of SESSIONS) for (const it of pv.items) if (it.kind === "launch" && it.agent.id === id) return it.agent;
  return SESSIONS;
};

function agentNodes(a: Sub, s: ClaudeSession): HTMLElement[] {
  // No agent ids: SubagentStart and SubagentStop still name it, but none of the tool events do.
  if (ui.noIds) {
    return [
      h(
        "div",
        { class: "jr pv-apart" },
        svg(ICONS.bang, 12),
        h(
          "div",
          {},
          h("b", { text: "This subagent's steps cannot be told apart on this version of Claude Code." }),
          h("span", { text: "Its tool events carry no agent id, so they are in the main journal, among the session's own steps, in the order they happened." }),
          h("button", { class: "pv-end-btn", text: "Open the main journal", onclick: () => backToMain() }),
        ),
      ),
      ending(a, s),
    ];
  }
  const shown = a.steps.filter(wanted);
  const nodes = shown.map((step) => entry(step, s));
  if (shown.length === 0) nodes.push(h("div", { class: "int-empty", text: a.steps.length === 0 ? "No step yet." : "No step of this kind in this subagent." }));
  nodes.push(ending(a, s));
  return nodes;
}

// ── The island ────────────────────────────────────────────────────────────────

const EXPAND = "M4 9.5V4h5.5M20 14.5V20h-5.5M4 4l6 6M20 20l-6-6";
const SHRINK = "M10 4.5V10H4.5M14 19.5V14h5.5M10 10 4 4M14 14l6 6";

const expandBtn = h("button", { class: "pv-expand", onclick: () => setLarge(!ui.large) });
const header = h(
  "div",
  { class: "pv-header" },
  h(
    "div",
    { class: "tabs" },
    h("button", { class: "tab", title: "Home" }, svg(ICONS.house, 13)),
    h("button", { class: "tab", title: "Shelf" }, svg(ICONS.stack, 13)),
    h("button", { class: "tab slot", title: "Reserved: to be decided", disabled: true }, svg(ICONS.add, 11, { stroke: 2 })),
  ),
  h("div", { class: "header-actions" }, expandBtn, h("button", { title: "Settings" }, svg(ICONS.gear, 14))),
);
const views = h("div", { class: "pv-views" });
const island = h("div", { class: "pv-island" }, h("div", { class: "pv-content" }, header, views));
document.getElementById("stage")!.append(island);

// The session panel: built once, its two halves drawn again as things change.
const botSlot = h("div", { class: "pv-bot-slot" });
const who = h("div", { class: "gh-side-who" });
const tree = h("div", { class: "pv-tree", role: "tree", "aria-label": "Sessions and their subagents" });
const mainCol = h("div", { class: "gh-main" });
const panelEl = h("div", { class: "card gh-card pv-panel" }, h("div", { class: "pv-rail" }, h("div", { class: "pv-rail-head" }, botSlot, who), tree), mainCol);

/** The journal on show, to keep its place when the panel is drawn again. */
let journal: HTMLElement | null = null;
let drawnFor = "";
const startAt = params.get("at");

function fade() {
  if (!journal) return;
  journal.classList.toggle("more", journal.scrollTop + journal.clientHeight < journal.scrollHeight - 2);
}

// ── The sidebar: a tree of sessions and their subagents ───────────────────────
// One tab stop (roving tabindex). Up / Down move through the rows on show,
// Home / End go to the first and the last, Enter or Space opens the row, Right
// opens a session's subagents (or, open already, goes to the first), Left
// closes them (or, on a subagent, goes to its session).

const sessionKey = (sessionId: string) => `s:${sessionId}`;
const agentKey = (sessionId: string, agentId: string) => `a:${sessionId}:${agentId}`;
const domId = (key: string) => `pv-${key.replace(/[^a-zA-Z0-9]/g, "-")}`;

/** The row the keyboard is on. */
let focusKey = ui.agent ? agentKey(ui.front, ui.agent) : sessionKey(ui.front);
/** The last thing used was the keyboard: the row with the focus wears its ring. */
let byKeyboard = false;

const rows = () => [...tree.querySelectorAll<HTMLElement>(".pv-ti")];

function moveTo(row: HTMLElement | undefined) {
  if (!row) return;
  for (const other of rows()) other.tabIndex = other === row ? 0 : -1;
  focusKey = row.dataset.key!;
  row.focus();
  row.scrollIntoView({ block: "nearest" });
}

function drawRail(pv: PreviewSession) {
  const s = pv.session;
  const hadFocus = tree.contains(document.activeElement);
  clear(who);
  who.append(h("b", { text: folderOf(s), title: folderOf(s) }), h("span", { text: s.title ?? "", title: s.title ?? "" }));

  const scroll = tree.scrollTop;
  clear(tree);
  for (const other of ordered()) {
    const os = other.session;
    const subs = listed(other);
    const open = expanded(other, subs);
    const at = standing(os);
    const mark = dot(at.color, 7);
    if (at.rank === 0) mark.classList.add("calls");
    mark.style.setProperty("--c", at.color);
    const inFront = other === pv;
    const key = sessionKey(os.id);
    const groupId = `${domId(key)}-subs`;
    const asking = subs.filter((a) => a.asking).length;
    const going = subs.filter((a) => a.state === "running").length;

    const row = h("div", {
      class: `pv-ti pv-sess${inFront ? " front" : ""}${inFront && !ui.agent ? " on" : ""}`,
      id: domId(key),
      role: "treeitem",
      "aria-level": 1,
      "aria-selected": String(inFront && !ui.agent),
      title: `${folderOf(os)} — ${os.title ?? ""} — ${at.words}${subs.length ? ` — ${counted(subs.length, "subagent")}, ${going} running` : ""}`,
    });
    row.dataset.key = key;
    row.dataset.session = os.id;
    row.style.setProperty("--c", stripe(os.project));
    if (subs.length > 0) {
      row.setAttribute("aria-expanded", String(open));
      row.setAttribute("aria-owns", groupId);
      const twisty = h("i", { class: "pv-twisty", title: open ? "Hide its subagents" : "Show its subagents" }, svg(ICONS.chevronRight, 9, { stroke: 2.8 }));
      twisty.addEventListener("click", (e) => {
        e.stopPropagation();
        toggle(other, !open);
      });
      row.append(twisty);
    } else {
      row.append(h("i", { class: "pv-twisty none" }));
    }
    row.append(h("b", { text: folderOf(os) }));
    if (subs.length > 0) {
      row.append(h("span", {
        class: asking > 0 ? "pv-count asking" : going > 0 ? "pv-count going" : "pv-count",
        text: String(subs.length),
        title: `${counted(subs.length, "subagent")}: ${going} running${asking ? `, ${asking} waiting for you` : ""}`,
      }));
    }
    row.append(mark);
    row.addEventListener("click", () => pickSession(os.id));
    tree.append(row);
    // Its last reply waits on a decision: the app's own mark, under its line (session.ts `drawRail`).
    if (os.decision) {
      tree.append(h(
        "div", { class: "sess-decide", title: "Its last reply has something marked IMPORTANT.", onclick: () => pickSession(os.id) },
        lucide(LUCIDE.messageSquareWarning, 10, 2.2), h("span", { text: DECISION_WORDS }),
      ));
    }

    if (subs.length > 0 && open) {
      const group = h("div", { class: "pv-subs", id: groupId, role: "group" });
      for (const a of subs) {
        const akey = agentKey(os.id, a.id);
        const on = inFront && ui.agent === a.id;
        const line = h(
          "div",
          {
            class: `pv-ti pv-sub ${a.asking ? "asking" : a.state}${on ? " on" : ""}`,
            id: domId(akey),
            role: "treeitem",
            "aria-level": 2,
            "aria-selected": String(on),
            title: `${a.type} · ${titleOf(a)} — ${statusWords(a)}`,
          },
          markOf(a),
          h("span", { class: "pv-sub-type", text: a.type }),
          h("span", { class: "pv-sub-task", text: titleOf(a) }),
        );
        if (a.asking) line.append(h("span", { class: "pv-sub-needs", text: "needs me" }));
        line.dataset.key = akey;
        line.dataset.session = os.id;
        line.dataset.agent = a.id;
        line.addEventListener("click", () => openAgent(os.id, a.id));
        group.append(line);
      }
      tree.append(group);
    }
  }

  // One row holds the tab stop: the one the keyboard was on, or its session when it is no longer on show.
  const all = rows();
  let holder = all.find((r) => r.dataset.key === focusKey);
  if (!holder && focusKey.startsWith("a:")) holder = all.find((r) => r.dataset.key === sessionKey(focusKey.split(":")[1]));
  holder ??= all.find((r) => r.classList.contains("on")) ?? all[0];
  for (const r of all) r.tabIndex = r === holder ? 0 : -1;
  if (holder) focusKey = holder.dataset.key!;
  tree.scrollTop = scroll;
  tree.classList.toggle("kbd", byKeyboard);
  if (hadFocus && holder) {
    holder.focus();
    holder.scrollIntoView({ block: "nearest" });
  }
}

tree.addEventListener("mousedown", () => {
  byKeyboard = false;
  tree.classList.remove("kbd");
});
tree.addEventListener("focusin", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".pv-ti");
  if (row?.dataset.key) focusKey = row.dataset.key;
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  byKeyboard = true;
  tree.classList.add("kbd");
});

tree.addEventListener("keydown", (e) => {
  const all = rows();
  const row = (e.target as HTMLElement).closest<HTMLElement>(".pv-ti");
  if (!row || e.altKey || e.ctrlKey || e.metaKey) return;
  const i = all.indexOf(row);
  const pv = byId(row.dataset.session!);
  const agentId = row.dataset.agent;
  const hasSubs = row.hasAttribute("aria-expanded");
  const open = row.getAttribute("aria-expanded") === "true";
  let handled = true;
  byKeyboard = true;
  tree.classList.add("kbd");
  switch (e.key) {
    case "ArrowDown": moveTo(all[i + 1]); break;
    case "ArrowUp": moveTo(all[i - 1]); break;
    case "Home": moveTo(all[0]); break;
    case "End": moveTo(all[all.length - 1]); break;
    case "Enter":
    case " ":
      if (agentId) openAgent(pv.session.id, agentId);
      else pickSession(pv.session.id);
      break;
    case "ArrowRight":
      if (agentId || !hasSubs) break;
      if (open) moveTo(all[i + 1]);
      else toggle(pv, true);
      break;
    case "ArrowLeft":
      if (agentId) moveTo(all.find((r) => r.dataset.key === sessionKey(pv.session.id)));
      else if (open) toggle(pv, false);
      break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
});

/** Opens or closes a session's subagents in the sidebar. The panel beside it does not move. */
function toggle(pv: PreviewSession, open: boolean) {
  setExpanded(pv, open);
  drawRail(front());
  sync();
}

// ── The panel beside it: the main journal, or a subagent's view ───────────────

function chips(steps: SessionStep[]): HTMLElement {
  const row = h("div", { class: "pv-filters" });
  for (const [id, name] of FILTERS) {
    const count = id === "all" ? steps.length : steps.filter((x) => x.kind === id).length;
    row.append(h(
      "button",
      { class: ui.filter === id ? "pv-f on" : "pv-f", "aria-pressed": String(ui.filter === id), onclick: () => { ui.filter = id; render(); } },
      name, h("b", { text: String(count) }),
    ));
  }
  return row;
}

function drawMain(pv: PreviewSession) {
  const s = pv.session;
  const agent = ui.agent ? subsOf(pv).find((a) => a.id === ui.agent) ?? null : null;
  const key = `${s.id}/${agent?.id ?? ""}`;
  const same = drawnFor === key;
  const scroll = journal && same ? journal.scrollTop : null;
  drawnFor = key;
  clear(mainCol);
  mainCol.classList.toggle("of-agent", agent != null);

  if (agent) {
    const back = h("button", { class: "pv-back", title: `Back to ${folderOf(s)} (the main session)`, "aria-label": "Back to the main session", onclick: () => backToMain() }, svg(ICONS.chevronLeft, 11, { stroke: 2.8 }));
    mainCol.append(h(
      "div",
      { class: "pv-crumb" },
      back,
      h("button", { class: "pv-crumb-session", text: folderOf(s), title: `Back to ${folderOf(s)} (the main session)`, onclick: () => backToMain() }),
      h("span", { class: "pv-crumb-sep", text: "›" }),
      h("span", { class: "pv-crumb-type", text: agent.type }),
      h("span", { class: "pv-crumb-dot", text: "·" }),
      h("b", { class: "pv-crumb-task", text: titleOf(agent), title: titleOf(agent) }),
      h("span", { class: "grow" }),
      markOf(agent),
      statusOf(agent),
    ));
    // Its chips count its own steps, and nothing else's. With no agent ids there are none to count.
    if (!ui.noIds) mainCol.append(chips(tools(agent.steps)));
    journal = h("div", { class: "gh-list sess-journal" }, ...agentNodes(agent, s));
  } else {
    const steps = tools(mainSteps(pv));
    const filters = chips(steps);
    const at = standing(s);
    const files = new Set(steps.filter((x) => x.kind === "edit").map((x) => x.target)).size;
    filters.append(h("div", { class: "grow" }), chip(at.words, at.color));
    if (files > 0) filters.append(h("button", { class: "sess-files", title: "Every file this session changed", text: counted(files, "file") }));
    mainCol.append(filters);
    journal = h("div", { class: "gh-list sess-journal" }, ...mainNodes(pv));
  }
  if (!same) journal.classList.add("pv-enter");
  journal.addEventListener("scroll", fade, { passive: true });
  mainCol.append(journal);
  const list = journal;
  // Opened at its end, as the app's journal is — or, with `?at=top`, at its start. Now if it is laid out
  // already, and again on the next frame, when what it holds has its height.
  const settle = () => {
    list.scrollTop = scroll ?? (startAt === "top" ? 0 : list.scrollHeight);
    fade();
  };
  settle();
  requestAnimationFrame(settle);
}

function openAgent(sessionId: string, agentId: string) {
  ui.front = sessionId;
  ui.agent = agentId;
  ui.filter = "all";
  ui.card = false;
  render();
}

function backToMain() {
  ui.agent = null;
  ui.filter = "all";
  render();
}

function pickSession(id: string) {
  // As in the app: one whose last reply waits on a decision is picked to read it — it opens whole, and is read.
  const picked = byId(id);
  if (picked.session.decision) {
    for (const it of picked.items) if (it.kind === "step" && it.step.kind === "reply") replyFolds.set(it.step, true);
    picked.session.decision = false;
  }
  ui.front = id;
  ui.agent = null;
  ui.filter = "all";
  ui.card = false;
  render();
}

// ── The cards that ask ────────────────────────────────────────────────────────

/** Who is asking, as a card's first line says it: a subagent by what it does, of which session. */
function asker(who: Sub | null, s: ClaudeSession, words: string, color: string): HTMLElement {
  const row = h("div", { class: "who-row pv-who" }, dot(color, 8));
  const project = h("i", { class: "pv-proj", text: folderOf(s), title: folderOf(s) });
  // A short name keeps its own width; only a long one is held to a least width as it is cut.
  if (folderOf(s).length <= 8) project.style.flex = "0 0 auto";
  // No agent ids: the card cannot tell, and says only what it knows.
  if (who && ui.noIds) {
    row.append(h("span", { class: "n", text: folderOf(s) }), h("span", { text: words }), h("span", { class: "pv-maybe", text: "a subagent may be asking" }));
  } else if (who?.description) {
    row.append(h("span", { class: "n", text: who.description, title: who.description }), h("span", { class: "pv-of", text: `(${who.type} subagent) of` }), project, h("span", { class: "pv-of", text: words }));
  } else if (who) {
    row.append(h("span", { text: `A ${who.type} subagent of` }), project, h("span", { text: words }));
  } else {
    row.append(h("span", { class: "n", text: folderOf(s), title: s.title ?? "" }), h("span", { text: words }));
  }
  return row;
}

/** In the preview a card's buttons answer it: the request is gone and the session panel is back. */
function answer(how: "allowed" | "denied" | null) {
  ui.answered = ui.ask === "subagent" || ui.ask === "queued" || ui.ask === "unnamed" ? how : null;
  ui.ask = "none";
  ui.card = false;
  render();
}

const answering = (label: string, kind: string, how: "allowed" | "denied" | null) =>
  h("button", { class: `btn ${kind}`, title: "Preview: answers, and goes back to the session panel", onclick: () => answer(how) }, h("span", { text: label }));

function approvalCard(pv: PreviewSession, request: Request, queued: Request | null): HTMLElement {
  const subs = subsOf(pv);
  const sub = (r: Request) => subs.find((a) => a.id === r.agentId) ?? null;
  const who = asker(sub(request), pv.session, "needs permission", COLOR.amber);
  if (queued) who.append(h("span", { class: "who-waiting", text: "1 of 2", title: "Two requests are waiting: the oldest first" }));
  const lines = h(
    "div",
    { class: "stack" },
    who,
    h("div", { class: "code", text: `${request.tool} · ${request.target}`, title: request.target }),
    h("div", { class: "actions" }, answering("Deny", "secondary", "denied"), answering("Allow", "primary", "allowed")),
  );
  if (queued) {
    const other = sub(queued);
    const next = other && !ui.noIds ? `${titleOf(other)} (${other.type} subagent)` : "another request";
    lines.append(h("div", { class: "pv-next", text: `Next: ${next} · ${queued.tool} · ${queued.target}` }));
  }
  return alertCard("amber", lines, 116);
}

function questionCard(pv: PreviewSession): HTMLElement {
  const who = asker(subsOf(pv).find((a) => a.id === ASKED_BY) ?? null, pv.session, "is asking a question", COLOR.cyan);
  if (QUESTION.header) who.append(h("span", { class: "q-chip", text: QUESTION.header }));
  const options = h("div", { class: "actions q-options q-list" });
  for (const option of QUESTION.options) {
    options.append(h("button", { class: "q-row", onclick: () => answer(null) }, h("b", { text: option.label }), h("span", { text: option.description ?? "" })));
  }
  const lines = h(
    "div",
    { class: "stack" },
    who,
    h("div", { class: "title q-title", text: QUESTION.question }),
    options,
    h("div", { class: "q-tail" }, answering("Other…", "secondary q-opt other", null), answering("Skip", "secondary q-skip", null)),
  );
  return alertCard("cyan", lines, 116);
}

/** A card that asks something, as views.ts builds one: the wash in its colour, the bot on its left. */
function alertCard(wash: "amber" | "cyan", lines: HTMLElement, padLeft: number): HTMLElement {
  lines.style.padding = `4px 16px 4px ${padLeft}px`;
  const card = h("div", { class: "card wash pv-alert" }, h("div", { class: "pv-card-bot" }, bot.el), lines);
  card.style.setProperty("--wash", washRGBA(wash));
  return card;
}

/** The card is the island's: it takes the session panel's place, as the app's does when a request comes in. */
function showCard() {
  if (ui.ask === "none") ui.ask = "subagent";
  ui.front = MAIN_ID;
  ui.card = true;
  render();
}

// ── Size ──────────────────────────────────────────────────────────────────────

const width = new Tracked(PANEL_W);
const height = new Tracked(PANEL_H);
let fitted = VIEW_LAYOUTS.approval.height;

/** The panel's large size: up to 1120 × 640, and never more than the window shows. */
function largeSize() {
  return {
    w: Math.max(PANEL_W, Math.min(1120, window.innerWidth - 32)),
    h: Math.max(PANEL_H, Math.min(640, window.innerHeight - 24)),
  };
}

const carded = () => ui.card && ui.ask !== "none";

function targetSize(): { w: number; h: number } {
  if (carded()) return { w: EXPANDED_W, h: fitted };
  return ui.large ? largeSize() : { w: PANEL_W, h: PANEL_H };
}

/** As island.ts: a spring to grow, the close curve to shrink. */
function resize(animate = true) {
  const { w, h: hgt } = targetSize();
  if (!animate) {
    width.jump(w);
    height.jump(hgt);
  } else if (w * hgt < width.value * height.value) {
    width.curveTowards(w);
    height.curveTowards(hgt);
  } else {
    width.springTo(w);
    height.springTo(hgt);
  }
  place();
}

function place() {
  island.style.width = `${width.value}px`;
  island.style.height = `${Math.max(0, height.value)}px`;
  island.style.borderRadius = `0 0 ${EXPANDED_CORNER}px ${EXPANDED_CORNER}px`;
}

// ── Drawing ───────────────────────────────────────────────────────────────────

function render(animate = true) {
  const pv = front();
  const s = pv.session;
  const card = carded();
  // A subagent that is no longer among the session's (the scenario changed) gives way to the main journal.
  if (ui.agent && !subsOf(pv).some((a) => a.id === ui.agent)) ui.agent = null;
  // The large panel is the session panel's: a card that asks keeps its own size.
  island.classList.toggle("large", ui.large && !card);
  clear(expandBtn);
  expandBtn.append(svg(ui.large ? SHRINK : EXPAND, 13, { stroke: 2 }));
  expandBtn.title = ui.large ? "Smaller (Esc)" : "Larger";
  expandBtn.classList.toggle("on", ui.large);
  expandBtn.disabled = card;

  bot.wear(stateOf(s));
  if (!card) {
    bot.fit(SESSION_BOT[ui.large ? "large" : "normal"].diameter);
    botSlot.append(bot.el);
    drawRail(pv);
    drawMain(pv);
    if (panelEl.parentElement !== views) {
      clear(views);
      views.append(panelEl);
    }
  } else {
    journal = null;
    drawnFor = "";
    clear(views);
    bot.fit(VIEW_LAYOUTS.approval.botDiameter);
    const pending = requests();
    const el = ui.ask === "question" ? questionCard(pv) : approvalCard(pv, pending[0], pending[1] ?? null);
    views.append(el);
    // As tall as what it holds asks for (layout.ts `fittedHeight`), measured with the card at its natural height.
    const lines = el.querySelector<HTMLElement>(".stack")!;
    lines.style.height = "auto";
    fitted = fittedHeight(lines.offsetHeight - 8);
    lines.style.height = "";
  }
  sync();
  resize(animate);
}

function setLarge(next: boolean) {
  ui.large = next;
  render();
}

// ── Preview controls ──────────────────────────────────────────────────────────

const sizePicker = picker<"normal" | "large">("Size", [["normal", "Normal"], ["large", "Large (Esc returns)"]], ui.large ? "large" : "normal", (v) => setLarge(v === "large"));

const scenarioPicker = picker<Scenario>("Scenario", [
  ["default", "Default: 2 running, 1 finished, 1 asking"],
  ["five", "5 subagents (sidebar scrolls)"],
  ["ended", "Session ends (subagents clear)"],
], ui.scenario, (v) => {
  ui.scenario = v;
  ui.front = MAIN_ID;
  ui.agent = null;
  ui.filter = "all";
  ui.card = false;
  ui.answered = null;
  ui.newAgent = false;
  ui.ask = v === "ended" ? "none" : "subagent";
  ui.endedAt = Date.now() - ENDED_AGO;
  folds.delete(MAIN_ID);
  render();
});

const openPicker = picker<Open>("Open", [
  ["main", "Back to main"],
  ["running", "The running subagent"],
  ["finished", "The finished one"],
  ["asking", "The one asking"],
], firstOpen, (v) => {
  if (ui.scenario === "ended") ui.scenario = "default";
  if (v === "asking" && ui.ask === "none") ui.ask = "subagent";
  if (v === "main") {
    ui.front = MAIN_ID;
    ui.card = false;
    backToMain();
  } else {
    openAgent(MAIN_ID, SHOWN[v]);
  }
});

const sidebarPicker = picker<"expanded" | "collapsed" | "new">("Sidebar", [
  ["expanded", "Expanded"],
  ["collapsed", "Collapsed"],
  ["new", "A new subagent starts (opens it again)"],
], "expanded", (v) => {
  const main = byId(MAIN_ID);
  if (ui.scenario === "ended") {
    ui.scenario = "default";
    ui.ask = "subagent";
  }
  ui.card = false;
  if (v === "new") ui.newAgent = true;
  else setExpanded(main, v === "expanded");
  render();
});

const cardPicker = picker<Ask>("Card", [
  ["none", "No card (session panel)"],
  ["subagent", "Subagent asks permission"],
  ["queued", "Two subagents ask: 1 of 2"],
  ["unnamed", "Subagent without a description"],
  ["main", "Main session asks"],
  ["question", "Question from a subagent"],
], ui.card ? ui.ask : "none", (v) => {
  if (v === "none") {
    ui.card = false;
    if (ui.ask === "none" && ui.scenario !== "ended") ui.ask = "subagent";
    render();
    return;
  }
  if (ui.scenario === "ended") ui.scenario = "default";
  ui.ask = v;
  ui.answered = null;
  showCard();
});

/** Where the session on show runs: in an editor its paths are chips that open; in a terminal they stay code. */
type Runs = "vscode" | "cursor" | "terminal";
const RUNS: Record<Runs, ClaudeSession["target"]> = {
  vscode: { kind: "vscode", label: "VS Code", tabbed: false },
  cursor: { kind: "cursor", label: "Cursor", tabbed: false },
  terminal: { kind: "terminal", label: "Windows Terminal", tabbed: true },
};
const firstRuns = params.get("runs");
if (firstRuns && firstRuns in RUNS) byId(EXAMPLE_ID).session.target = RUNS[firstRuns as Runs];

const replyPicker = picker<"reply" | "long" | "full" | "result" | "badge">("Reply", [
  ["reply", "The example reply (shown whole)"],
  ["long", "A very long reply (cut)"],
  ["full", "Read whole (clears the badge)"],
  ["result", "A subagent's long result"],
  ["badge", "Put the badge back"],
], "reply", (v) => {
  const example = byId(EXAMPLE_ID);
  const said = example.items.flatMap((it) => (it.kind === "step" && it.step.kind === "reply" ? [it.step] : []))[0];
  ui.front = EXAMPLE_ID;
  ui.agent = v === "result" ? EXAMPLE_AGENT : null;
  ui.filter = "all";
  ui.card = false;
  if (v === "badge") example.session.decision = true;
  // The very long one takes the example's place, and gives it back.
  if (v === "reply" || v === "long") said.target = v === "long" ? LONG_REPLY : EXAMPLE_REPLY;
  if (v === "long") example.session.decision = true;
  if (v === "reply" || v === "long" || v === "badge") replyFolds.set(said, false);
  if (v === "full") {
    replyFolds.set(said, true);
    example.session.decision = false;
  }
  render();
});

const runsPicker = picker<Runs>("Runs in", [
  ["vscode", "VS Code (paths open)"],
  ["cursor", "Cursor (paths open)"],
  ["terminal", "A terminal (paths stay code)"],
], (firstRuns && firstRuns in RUNS ? firstRuns : "vscode") as Runs, (v) => {
  front().session.target = RUNS[v];
  render();
});

const titlePicker = picker<OnOff>("Task title", [["off", "Short"], ["on", "Very long"]], ui.longTitle ? "on" : "off", (v) => {
  ui.longTitle = v === "on";
  render();
});

const folderPicker = picker<OnOff>("Folder name", [["off", "Short"], ["on", "Very long"]], ui.longFolder ? "on" : "off", (v) => {
  ui.longFolder = v === "on";
  render();
});

const idsPicker = picker<OnOff>("Agent ids", [["off", "Present"], ["on", "No agent ids (older Claude Code)"]], ui.noIds ? "on" : "off", (v) => {
  ui.noIds = v === "on";
  render();
});

/** The controls say what the island shows, however it got there: by them, by a click, by the keyboard. */
function sync() {
  const shown = (Object.keys(SHOWN) as (keyof typeof SHOWN)[]).find((k) => ui.front === MAIN_ID && SHOWN[k] === ui.agent);
  sizePicker.set(ui.large ? "large" : "normal");
  scenarioPicker.set(ui.scenario);
  // A session or a subagent the controls do not name lights none of them.
  openPicker.set((ui.front === MAIN_ID && !ui.agent ? "main" : shown ?? "") as Open);
  sidebarPicker.set(expanded(byId(MAIN_ID)) ? "expanded" : "collapsed");
  cardPicker.set(carded() ? ui.ask : "none");
  const runs = front().session.target;
  runsPicker.set(runs.kind === "cursor" ? "cursor" : runs.kind === "vscode" ? "vscode" : "terminal");
}

document.getElementById("controls")!.append(
  controls(
    "Fake data. In the island: click a session or a subagent in the sidebar, a “Launched …” line, a filter chip, the back arrow. Tab into the sidebar, then Up / Down, Enter, Left, Right.",
    sizePicker.el, scenarioPicker.el, openPicker.el, sidebarPicker.el, cardPicker.el, replyPicker.el, runsPicker.el, titlePicker.el, folderPicker.el, idsPicker.el,
  ),
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.large) setLarge(false);
});
window.addEventListener("resize", () => {
  if (ui.large) resize(false);
});

// ── Frame loop (this page's only) ─────────────────────────────────────────────

const mouse = { x: window.innerWidth / 2, y: 0 };
window.addEventListener("mousemove", (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
});

let last = performance.now();
function frame(nowMs: number) {
  const dt = Math.min(0.05, (nowMs - last) / 1000);
  last = nowMs;
  if (width.animating || height.animating) {
    width.step(dt, nowMs);
    height.step(dt, nowMs);
    place();
    fade();
  }
  bot.frame(dt, mouse);
  requestAnimationFrame(frame);
}

render(false);
requestAnimationFrame(frame);
// The Markdown's rules, checked where they can be seen to fail: the console says how many held.
checkMarkdown();
void checkPathLinks();
