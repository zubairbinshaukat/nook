// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import {
  CLAUDE_ID, State, isQuestion, newSession, repliedWords, requestsOf, subagentName, targetTip, targetWords,
  type AgentTask, type ClaudeSession, type SessionRequest,
} from "../core/state";
import { CARD_AIR_MIN, fittedHeight, washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { buildHome } from "./home";
import { buildSession, sessionName } from "./session";
import { buildShelf, type MorphNames } from "./shelf";
import { diffLine, fileKind, plusMinus, readPatch } from "./code";
import { COLOR } from "./palette";
import { LUCIDE, lucide } from "./iconset";
import { TOOL_NAME, toolMark } from "./tool";
import { buildHeaderStats } from "./header-stats";

/** What stands for a session where there is none to go to: another agent's pill has no ↗. */
const NO_SESSION = newSession("");

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  /**
   * A card that tells something — a turn's end, an error — is done with. It
   * goes back to the Shelf when it came up over it; otherwise the island folds
   * (`fold`) or shows the home view, as it always did.
   */
  leaveCard(fold: boolean): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
  /** The answers to the question on the card, keyed by each question's own words. */
  answer(answers: Record<string, string>): void;
  /** The question on the card goes unanswered: Claude is told so and carries on without. */
  skipQuestion(): void;
  /** Leaves the question on the card to Claude Code's own window. */
  passQuestion(): void;
  /** A text field wants the keyboard, or gives it back: the island never takes it on its own. */
  keyboard(on: boolean): void;
  /** The session panel's sidebar was clicked: it wants the keyboard, for the arrows to move through it. */
  panelKeyboard(): void;
  /** The session panel at its large size, or back at its normal one. */
  setLarge(on: boolean): void;
  /** From the session panel, back to the card of the request its session is waiting on. */
  showRequest(): void;
  /**
   * Into the session panel: what Claude is writing or, its turn over, what it
   * said. With `changes`, straight to the list of files it changed.
   */
  openSession(changes?: boolean): void;
  /** Into the session panel, on the list of the sessions followed: the way from one to another. */
  openSessions(): void;
  /** Puts another Claude Code session in front: the island shows that one. */
  pickSession(id: string): void;
  /** Goes to where a session runs, whichever is in front, and folds the island once there. */
  goToSession(id: string): void;
  /** From the home view: a session's panel — or, when it is waiting for an answer, the card that asks. */
  openSessionOf(id: string): void;
  /** From the home view: the card of the request a session is waiting on, that session put in front. */
  reviewRequest(id: string): void;
  /** Motion is reduced (Settings → Appearance, or the system's): nothing travels, nothing morphs. */
  reducedMotion(): boolean;
  /**
   * The Shelf changes its own shape — a widget expands, or goes back — drawn as
   * a shared-element transition: `change` is run when the page is ready for it,
   * and the island is at its new size by then. False when the page cannot draw
   * one (or motion is reduced): nothing was done, and the Shelf changes itself
   * and says `resized`.
   */
  morph(change: () => void, names: MorphNames, open: boolean): boolean;
  /** The Shelf changed what it shows: the island takes its new size, shrinking or growing. */
  resized(shrinking: boolean): void;
}

/** A reply's first line as plain words: what marks it as bold, a heading or code goes. */
function firstWords(text: string | null): string | null {
  return text?.split("\n").find((line) => line.trim())?.replace(/^#{1,6}\s+|\*\*|`/g, "").trim() ?? null;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /** How tall the island should be for what the view holds now, when that varies. */
  readonly height?: number;
  /** How wide, when it is not the usual: an expanded widget. */
  readonly width?: number;
  /**
   * The view has just come on show. A card that asks something starts its
   * arming again: whatever click brought it up must not also answer it.
   */
  arm?(): void;
  /** The session panel: to the next session of its sidebar (1) or the one before (-1), as a click on its line would. */
  step?(by: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

/**
 * Whose card this is, for a card about a Claude Code session: the conversation
 * by its name — with several open, the project alone would not say which —
 * and, when other sessions are waiting for an answer behind it, how many.
 */
function sessionWho(label: string): HTMLElement {
  const task = State.tasks.find((t) => t.id === CLAUDE_ID) ?? State.focusTask;
  const session = State.session;
  const row = h("div", { class: "who-row" });
  if (task) row.append(dot(task.color, 8), ...(session.id ? [toolMark(session.agent, 11)] : []), h("span", { class: "n", text: session.id ? sessionName(session) : task.name }));
  row.append(h("span", { text: label }));
  const waiting = State.waiting.length;
  if (waiting > 0) row.append(h("span", { class: "who-waiting", text: `+${waiting} waiting`, title: "Other sessions waiting for an answer" }));
  return row;
}

/**
 * Who is asking, on a request's card. The session itself: as `sessionWho`
 * says it. One of its subagents: by what it was launched to do, then its kind
 * and the session it belongs to — "Write a note (general-purpose subagent) of
 * nook needs permission" — or, when nothing named it, "A general-purpose
 * subagent of nook needs permission". When a request does not say who it comes
 * from (an older Claude Code) while subagents are at work, the card says only
 * what it knows: that one of them may be asking.
 */
function askerWho(request: SessionRequest | null, label: string, color: string): HTMLElement {
  const session = State.session;
  const agent = request?.agentId ? (session.subagents.find((a) => a.id === request.agentId) ?? null) : null;
  let row: HTMLElement;
  if (!agent) {
    row = sessionWho(label);
    const unsure = request != null && session.attributed !== true && session.subagents.some((a) => a.state === "running");
    if (unsure) row.insertBefore(h("span", { class: "who-maybe", text: "a subagent may be asking" }), row.querySelector(".who-waiting"));
  } else {
    row = h("div", { class: "who-row who-asker" }, dot(color, 8));
    const project = h("i", { class: "who-proj", text: session.project, title: session.title ?? session.project });
    // A short name keeps its own width; only a long one is held to a least width as it is cut.
    if (session.project.length <= 8) {
      project.style.flex = "0 0 auto";
      project.style.minWidth = "0";
    }
    // Its kind, as far as it is known: "general-purpose subagent", or just "subagent".
    const kind = agent.type ? `${agent.type} subagent` : "subagent";
    const task = agent.description ?? agent.task;
    if (task) {
      row.append(
        h("span", { class: "n", text: task, title: task }),
        h("span", { class: "who-of", text: `(${kind}) of` }), project, h("span", { class: "who-of", text: label }),
      );
    } else {
      row.append(h("span", { text: `A ${kind} of` }), project, h("span", { text: label }));
    }
    const waiting = State.waiting.length;
    if (waiting > 0) row.append(h("span", { class: "who-waiting", text: `+${waiting} waiting`, title: "Other sessions waiting for an answer" }));
  }
  // Two of the session's subagents can ask at once: one card at a time, the oldest first.
  const queued = requestsOf(session).length;
  if (queued > 1) {
    row.append(h("span", { class: "who-waiting", text: `1 of ${queued}`, title: `${queued} requests are waiting: the oldest first` }));
  }
  return row;
}

/** The request waiting behind the one on the card, in a line: who asks, and what. */
function nextWords(session: ClaudeSession): string {
  const next = session.queued[0];
  if (!next) return "";
  const agent = next.agentId ? session.subagents.find((a) => a.id === next.agentId) : null;
  const who = agent ? (agent.description ? `${agent.description} (${agent.type ? `${agent.type} ` : ""}subagent)` : `${subagentName(agent)} (subagent)`) : "another request";
  return `Next: ${who} · ${isQuestion(next) ? (next.questions[0]?.question ?? "a question") : next.command}`;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

/**
 * Keeps a card whose lines vary from filling up to its edges: measures what
 * its stack holds and asks the island for the height that leaves the least
 * air a card keeps. A card with room to spare is left as tall as it always was.
 */
function airy(lines: HTMLElement, onResize: () => void): { fit(): void; readonly height: number | undefined } {
  let height: number | undefined;
  const fit = () => {
    const parts = [...lines.children].map((child) => (child as HTMLElement).offsetHeight).filter((h) => h > 0);
    const gap = parseFloat(getComputedStyle(lines).rowGap) || 0;
    const content = parts.reduce((sum, part) => sum + part, 0) + gap * Math.max(0, parts.length - 1);
    // Not on screen yet: nothing to measure, the layout's own height stands.
    const next = parts.length > 0 ? fittedHeight(content, CARD_AIR_MIN) : undefined;
    if (next === height) return;
    height = next;
    onResize();
  };
  // Measured again when the card's width changes: while the island is still
  // opening it is narrow, its lines wrap, and it looks taller than it is.
  new ResizeObserver(fit).observe(lines);
  return {
    fit,
    get height() {
      return height;
    },
  };
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  // The two tabs: Home, the agents; the Shelf, the widgets. A click on one
  // never leaves it with the focus (island.ts stops that for every button).
  const tabHome = h("button", { class: "tab named", title: "Home: your sessions", onclick: () => go("overview") }, svg(ICONS.house, 13), "Home");
  const tabShelf = h("button", { class: "tab named", title: "Shelf: your widgets", onclick: () => go("shelf") }, svg(ICONS.shelf, 13), "Shelf");

  // The session panel's own button: its normal size, or as large as the display has room for.
  const expandBtn = h("button", { class: "expand ha", onclick: () => actions.setLarge(!State.large) });
  // A click on it does not leave it with the focus: the keyboard, which the
  // large panel takes, is for the sidebar and for Escape — Enter must not shrink the panel back.
  expandBtn.addEventListener("mousedown", (e) => e.preventDefault());
  let expandKey = "";
  const gearBtn = h("button", { class: "ha", title: "Settings", "aria-label": "Settings", onclick: () => go("settings") }, lucide(LUCIDE.slidersHorizontal, 15, 1.75));
  const soundBtn = h("button", { class: "ha", title: "Mute", "aria-label": "Mute", onclick: () => actions.toggleSound() });
  let soundKey = "";
  // The machine and Claude's usage: written when a sample or a usage comes, never on a timer.
  const stats = buildHeaderStats();
  State.onGauges(stats.draw);
  stats.draw();

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabShelf),
    stats.el,
    h("div", { class: "header-actions" }, expandBtn, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      // The session panel is reached from the overview and goes back to it.
      tabHome.classList.toggle("on", v === "overview" || v === "empty" || v === "session");
      tabShelf.classList.toggle("on", v === "shelf");
      // Drawn again only when it changes: rebuilt between a mouse-down and its mouse-up, it would swallow the click.
      const nextExpand = `${v === "session"}:${State.large}`;
      if (nextExpand !== expandKey) {
        expandKey = nextExpand;
        expandBtn.style.display = v === "session" ? "" : "none";
        clear(expandBtn);
        expandBtn.append(svg(State.large ? ICONS.shrink : ICONS.expand, 13, { stroke: 2 }));
        expandBtn.title = State.large ? "Smaller (Esc)" : "Larger";
        expandBtn.classList.toggle("on", State.large);
      }
      gearBtn.classList.toggle("on", v === "settings");
      const soundOn = State.settings.soundEnabled;
      const nextSound = String(soundOn);
      if (nextSound !== soundKey) {
        soundKey = nextSound;
        clear(soundBtn);
        soundBtn.append(lucide(soundOn ? LUCIDE.volume2 : LUCIDE.volumeX, 15, 1.75));
        soundBtn.title = soundBtn.ariaLabel = soundOn ? "Mute" : "Unmute";
      }
      stats.draw();
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Your Claude Code sessions show up here." }),
    ),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

/**
 * A fresh request's card ignores clicks for this long. The card slides out
 * under wherever the pointer happens to be, and a click that was aimed at
 * something else a moment earlier must not allow a command nobody has read.
 */
const REQUEST_ARM_MS = 400;

function buildApproval(actions: ViewActions, onResize: () => void): ViewHost {
  // The request the card was last armed for, and when its buttons start to count.
  let armedFor = "";
  let armedAt = 0;
  const decide = (decision: "allow" | "deny") => {
    // The request a click answers is the one the card has drawn, and has shown
    // for long enough. With several waiting, the next takes the card the
    // moment one is answered — before the card is drawn again: a second click
    // on the same spot must not answer a request nobody has seen.
    if ((State.pendingApproval?.requestId ?? "") !== armedFor || performance.now() < armedAt) return;
    actions.decide(decision);
  };
  const who = h("div");
  // All of what is asked, however long: it wraps, and scrolls past a few lines.
  const code = h("div", { class: "code asked" });
  // For an edit: the diff it would make, between what is asked and the answer.
  const proposed = h("div", { class: "proposed gh-code" });
  const row = h("div", { class: "actions" });
  // Behind the request on the card: the one that asked next.
  const next = h("div", { class: "who-next" });
  const lines = stack(116, 16, who, code, proposed, row, next);
  const el = h("div", { class: "view" }, card("amber", lines));
  const air = airy(lines, onResize);
  let rowKey = "";
  let proposedKey = "";
  return {
    el,
    // With a diff the island is as tall as the window allows, and the diff takes what is left.
    get height() {
      return State.pendingApproval?.proposal ? undefined : air.height;
    },
    arm() {
      armedAt = performance.now() + REQUEST_ARM_MS;
    },
    sync() {
      const approval = State.pendingApproval;
      const proposal = approval?.proposal ?? null;
      // Armed once per request, from the moment its card is drawn. The card
      // looks the same while it is arming; only the click waits.
      const asked = approval?.requestId ?? "";
      if (asked !== armedFor) {
        armedFor = asked;
        armedAt = performance.now() + REQUEST_ARM_MS;
      }
      clear(who);
      const asking = askerWho(approval, "needs permission", COLOR.amber);
      if (proposal) asking.append(plusMinus(proposal.additions, proposal.deletions));
      who.append(asking);
      next.textContent = next.title = nextWords(State.session);
      next.style.display = next.textContent ? "" : "none";
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = proposal
        ? `${approval?.tool} · ${proposal.path}${proposal.created ? " · new file" : ""}`
        : approval?.command || approval?.tool || "…";
      // What that edit would do, line by line, before it is allowed. Drawn once
      // per request: a list redrawn under the mouse would lose its scroll.
      proposed.style.display = proposal ? "" : "none";
      // A diff takes all the room it is given: the card keeps the air a
      // card has above its first line and under its buttons.
      lines.classList.toggle("airy", proposal != null);
      const nextProposed = proposal ? (approval?.requestId ?? "") : "";
      if (nextProposed !== proposedKey) {
        proposedKey = nextProposed;
        clear(proposed);
        if (proposal) {
          const kind = fileKind(proposal.path);
          const diff = h("div", { class: "gh-diff" });
          for (const line of readPatch(proposal.patch)) {
            if (!("hunk" in line)) diff.append(diffLine(line.new ?? line.old, line.sign, line.text, kind));
          }
          if (proposal.truncated) {
            diff.append(
              h("div", { class: "gh-diff-line hunk" }, h("span", { class: "n", text: "⋯" }), h("span", { class: "s" }), h("span", { class: "t", text: "The rest of this edit is in Claude Code" })),
            );
          }
          proposed.append(diff);
          // Open on the first line that changes, a line of context above it.
          const first = diff.querySelector<HTMLElement>(".add, .del");
          proposed.scrollTop = first ? Math.max(0, first.offsetTop - diff.offsetTop - first.offsetHeight) : 0;
        }
      }
      // Two buttons, built once per kind of request. Rebuilding them between a
      // mouse-down and a mouse-up would swallow the click. A request too long
      // to show whole has none: it is answered in Claude Code, which shows it all.
      const nextRow = approval?.tooLong ? "too-long" : "buttons";
      if (rowKey !== nextRow) {
        rowKey = nextRow;
        clear(row);
        if (approval?.tooLong) {
          row.append(h("span", { class: "too-long", text: `Too long to review here. Answer it in ${State.clientName}.` }));
        } else {
          row.append(
            btn("Deny", "secondary", () => decide("deny")),
            btn("Allow", "primary", () => decide("allow")),
          );
        }
      }
      air.fit();
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

/** Several options picked for one question go back as one answer, as Claude Code writes them. */
const ANSWER_JOIN = ", ";
/** A click in the field asks the window for the keyboard; this long later it has it. */
const FOCUS_MS = 120;

/**
 * A question Claude asks with its question tool, answered here: one question
 * at a time, each option with what it means beside it.
 * "Other…" takes a typed answer. The last answer sends them all — and the
 * session, wherever it runs, goes on as if they had been picked there.
 */
function buildQuestion(actions: ViewActions, onResize: () => void): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title q-title" });
  const row = h("div", { class: "actions q-options" });
  const hint = h("span", { class: "q-hint" });
  const back = h("button", { class: "link-btn q-link", text: "‹ Previous" });
  const pass = h("button", { class: "link-btn q-link", onclick: () => seen() && actions.passQuestion() });
  const skip = h("button", { class: "btn secondary q-skip", text: "Skip", title: "Leave this question unanswered", onclick: () => seen() && actions.skipQuestion() });
  // Under a list of options: "Other…", and Send when several can be picked.
  const tail = h("div", { class: "q-tail" });
  const foot = h("div", { class: "q-foot" }, tail, hint, h("div", { class: "grow" }), back, pass, skip);
  const field = h("input", {
    class: "island-field", type: "text", maxlength: "2000", autocomplete: "off", spellcheck: "false",
    placeholder: "Your answer",
  }) as HTMLInputElement;
  const lines = stack(116, 16, who, title, row, foot);
  // A question with more options than the window is tall for fills its card:
  // the list of options scrolls, and the card keeps its least air around it.
  lines.style.paddingTop = lines.style.paddingBottom = `${CARD_AIR_MIN}px`;
  const el = h("div", { class: "view" }, card("cyan", lines));

  /** The request all of this is about: a new one starts from the first question. */
  let request = "";
  let at = 0;
  /** One answer per question answered so far. */
  let answers: string[] = [];
  /** A question that takes several: the labels picked so far. */
  let picked = new Set<string>();
  let typing = false;
  let key = "";
  /** The island's height for what the card holds now; unset until it has been measured. */
  let height: number | undefined;
  /** When a fresh question starts taking answers: see REQUEST_ARM_MS. */
  let armedAt = 0;
  /** True once the card has drawn the question that waits, and shown it for long enough: only then does a click count. */
  const seen = () => (State.pendingQuestion?.requestId ?? "") === request && performance.now() >= armedAt;

  /** Asks the island for the room the card's content takes, no more. */
  function fit() {
    // The card's lines, and the gap the stack leaves between each two of them.
    const parts = [who.offsetHeight, title.offsetHeight, row.scrollHeight, foot.offsetHeight];
    const gap = parseFloat(getComputedStyle(lines).rowGap) || 0;
    const content = parts.reduce((sum, part) => sum + part, 0) + gap * (parts.length - 1);
    // Not on screen yet: nothing to measure, the layout's own height stands.
    const next = who.offsetHeight > 0 ? fittedHeight(content) : undefined;
    if (next === height) return;
    height = next;
    onResize();
  }

  // Measured again whenever the card's width changes: while the island is still
  // opening it is narrow, the lines wrap, and the content looks taller than it is.
  new ResizeObserver(() => fit()).observe(el);

  function settle(value: string) {
    const info = State.pendingQuestion;
    if (!info || !value) return;
    // Only the question the card has drawn, once it has been up long enough: see buildApproval's `decide`.
    if (info.requestId !== request || performance.now() < armedAt) return;
    answers[at] = value;
    stopTyping();
    picked = new Set();
    if (at + 1 < info.questions.length) {
      at++;
      actions.blip();
      State.notify();
      return;
    }
    const out: Record<string, string> = {};
    info.questions.forEach((q, i) => (out[q.question] = answers[i] ?? ""));
    actions.answer(out);
  }

  function stopTyping() {
    typing = false;
    field.value = "";
    field.blur();
  }

  field.addEventListener("blur", () => actions.keyboard(false));
  field.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") settle(field.value.trim());
    else if (e.key === "Escape") {
      stopTyping();
      State.notify();
    }
  });
  back.addEventListener("click", () => {
    if (at === 0) return;
    at--;
    stopTyping();
    picked = new Set();
    actions.blip();
    State.notify();
  });

  function draw() {
    const info = State.pendingQuestion;
    if ((info?.requestId ?? "") !== request) {
      request = info?.requestId ?? "";
      armedAt = performance.now() + REQUEST_ARM_MS;
      at = 0;
      answers = [];
      picked = new Set();
      typing = false;
      key = "";
    }
    // Rebuilding the buttons between a mouse-down and its mouse-up would
    // swallow the click, so only rebuild when what they show has changed.
    const asker = info?.agentId ? State.session.subagents.find((a) => a.id === info.agentId) : null;
    const next = [
      request, at, typing, [...picked].join("|"), State.clientName, State.waiting.length,
      requestsOf(State.session).length, asker?.type, asker?.description,
    ].join("~");
    if (next === key) return;
    key = next;

    const task = State.tasks.find((t) => t.id === CLAUDE_ID) ?? State.focusTask;
    const q = info?.questions[at];
    clear(who);
    clear(row);
    clear(tail);
    pass.textContent = `Answer in ${State.clientName}`;
    back.style.display = at > 0 ? "" : "none";
    if (!info || !q) {
      who.append(askerWho(info, "is asking a question", COLOR.cyan));
      title.textContent = task?.steps.at(-1) ?? "Claude needs an answer.";
      hint.textContent = "";
      pass.style.display = "none";
      skip.style.display = "none";
      return;
    }
    pass.style.display = "";
    skip.style.display = "";

    const asking = askerWho(info, "is asking a question", COLOR.cyan);
    if (q.header) asking.append(h("span", { class: "q-chip", text: q.header }));
    if (info.questions.length > 1) asking.append(h("span", { class: "q-count", text: `${at + 1}/${info.questions.length}` }));
    who.append(asking);
    title.textContent = q.question;
    title.title = q.question;

    const rest = q.multiSelect ? "Pick one or more, then send." : "";
    hint.textContent = rest;

    if (typing) {
      row.classList.remove("q-list");
      row.append(
        field,
        btn(at + 1 < info.questions.length ? "Next" : "Send", "primary", () => settle(field.value.trim())),
        btn("Back", "secondary", () => {
          stopTyping();
          State.notify();
        }),
      );
      return;
    }

    // Options that explain themselves are read before they are picked: each
    // on a line of its own, what it means beside its name. Bare labels stay
    // the row of buttons of the prototype.
    const explained = q.options.some((o) => o.description);
    row.classList.toggle("q-list", explained);
    for (const option of q.options) {
      const on = picked.has(option.label);
      const el = explained
        ? h(
            "button",
            { class: on ? "q-row on" : "q-row" },
            h("b", { text: option.label }),
            h("span", { text: option.description ?? "", title: option.description ?? "" }),
          )
        : h("button", { class: on ? "btn secondary q-opt on" : "btn secondary q-opt" }, h("span", { text: option.label }));
      el.addEventListener("click", () => {
        if (!q.multiSelect) return settle(option.label);
        if (!picked.delete(option.label)) picked.add(option.label);
        State.notify();
      });
      row.append(el);
    }
    // After the options: in the row of buttons, or under the list, at its foot.
    const after = explained ? tail : row;
    after.append(
      h("button", {
        class: "btn secondary q-opt other",
        text: "Other…",
        onclick: () => {
          typing = true;
          State.notify();
          actions.keyboard(true);
          window.setTimeout(() => field.focus(), FOCUS_MS);
        },
      }),
    );
    if (q.multiSelect) {
      after.append(
        btn(at + 1 < info.questions.length ? "Next" : "Send", "primary", () =>
          // In the order the options are listed, not the order they were clicked.
          settle(q.options.filter((o) => picked.has(o.label)).map((o) => o.label).join(ANSWER_JOIN)),
        ),
      );
    }
  }

  return {
    el,
    get height() {
      return height;
    },
    arm() {
      armedAt = performance.now() + REQUEST_ARM_MS;
    },
    sync() {
      draw();
      fit();
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions, onResize: () => void): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Session stopped on an error." });
  const detail = h("div", { class: "detail" });
  // Where what stopped runs: the Claude app, a terminal — the pill's own way out.
  const openLabel = h("span");
  const openBtn = h("button", { class: "btn secondary", onclick: () => actions.openTarget() }, openLabel);
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.leaveCard(false)),
    openBtn,
  );
  const lines = stack(116, 16, who, title, detail, row);
  const el = h("div", { class: "view" }, card("red", lines));
  const air = airy(lines, onResize);
  return {
    el,
    get height() {
      return air.height;
    },
    sync() {
      const task = State.focusTask;
      clear(who);
      // A Claude Code session is named by its conversation; a third-party
      // agent's pill by its own name.
      who.append(task?.id === CLAUDE_ID ? sessionWho(TOOL_NAME[State.session.agent]) : agentWho(task, "stopped"));
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
      // Nowhere known to go to — another agent's pill, a session that has not
      // said where it runs — and the button is not there.
      const session = task?.id === CLAUDE_ID ? State.session : NO_SESSION;
      const words = targetWords(session.target);
      openBtn.style.display = words ? "" : "none";
      openLabel.textContent = words ?? "";
      openBtn.title = targetTip(session) ?? "";
      air.fit();
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions, onResize: () => void): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  // Built once, like every button of a card: only its words follow the session.
  const openLabel = h("span");
  const openBtn = h("button", { class: "btn primary", onclick: () => actions.openTerminal() }, openLabel);
  const changesLabel = h("span");
  const changesBtn = h("button", { class: "btn secondary", onclick: () => actions.openSession(true) }, changesLabel);
  // What Claude said, in full: the card only has room for its first words.
  const readBtn = h("button", { class: "btn primary", onclick: () => actions.openSession() }, h("span", { text: "Read reply" }));
  const row = h("div", { class: "actions" },
    readBtn,
    openBtn,
    changesBtn,
    btn("OK", "secondary", () => actions.leaveCard(true)),
  );
  const lines = stack(116, 16, who, title, row);
  const el = h("div", { class: "view" }, card("green", lines));
  const air = airy(lines, onResize);
  return {
    el,
    get height() {
      return air.height;
    },
    sync() {
      clear(who);
      // A third-party agent's pill has no session behind it: its name, its last step, and OK.
      const claude = State.focusTask?.id === CLAUDE_ID;
      // A reply given while subagents still run is told on this card too, as
      // what it is: the session has replied, and is not finished.
      const replied = claude ? repliedWords(State.session) : null;
      who.append(claude ? sessionWho(replied ?? "finished") : agentWho(State.focusTask, "finished"));
      // What Claude said to end its turn, its first line; its last step otherwise.
      const answer = claude ? firstWords(State.session.answer) : null;
      title.textContent = answer ?? State.focusTask?.steps.at(-1) ?? "Session finished";
      // An answer is a sentence, not a step: smaller, and two lines at most.
      title.classList.toggle("said", answer != null);
      readBtn.style.display = answer ? "" : "none";
      openBtn.className = answer ? "btn secondary" : "btn primary";
      // Where the session runs, and what it left behind: the way to its diffs.
      const files = claude ? State.sessionFiles.length : 0;
      const words = claude ? targetWords(State.session.target) : null;
      openBtn.style.display = words ? "" : "none";
      openLabel.textContent = words ?? "";
      openBtn.title = claude ? targetTip(State.session) ?? "" : "";
      changesBtn.style.display = files > 0 ? "" : "none";
      changesLabel.textContent = files === 1 ? "1 file changed" : `${files} files changed`;
      air.fit();
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#FF6B7A", 6),
        h("span", { text: "Claude Code" }),
      );
    },
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onResize: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildHome(actions));
  map.set("empty", buildEmpty());
  map.set("approval", buildApproval(actions, onResize));
  map.set("question", buildQuestion(actions, onResize));
  map.set("error", buildError(actions, onResize));
  map.set("finished", buildFinished(actions, onResize));
  map.set("confused", buildConfused());
  map.set("settings", buildSettings(actions));
  map.set("session", buildSession(actions));
  map.set("shelf", buildShelf(actions));
  return map;
}
