// The session panel — a Claude Code session, followed from the island.
//
// On the left, a sidebar: the bot, the session's name, and under them the tree
// of every session followed, each with the subagents it launched — how one
// goes from a session to another, and from a session to one of its subagents.
// On the right the journal of what is picked, read like a conversation: what
// was asked, then each thing Claude did in the order it did it — a file read,
// an edit with its diff, typed as it lands, a command, a question with what
// was picked, a permission with what was decided — and what Claude said to end
// its turn. Above it, chips that keep one kind of step. A subagent has a
// journal of its own, reached from the sidebar or from the line of the main
// journal where it was launched, ending on what it came back with. Behind the
// journal, the files the session has changed and each one's whole diff. It is
// for watching: to answer, there is Claude Code.
//
// The panel has two sizes: its normal one, and a large one (the expand button
// in the island's bar; Escape goes back) where a command is shown whole and
// what each step gave back is under it.
//
// Windows only for now. Nothing here is fetched: it is all in the hooks Claude Code already sends.
// An edit is shown the moment Claude Code says it is done, so the typing is a
// replay of it, a second behind. The session itself stays where it runs — the
// Claude app, VS Code, a terminal.

import { h, svg, clear, dot, replay, timeAgo } from "./dom";
import { diffLine, extBadge, fileKind, plusMinus, readPatch, splitPath, type FileKind } from "./code";
import { ICONS } from "./icons";
import { COLOR } from "./palette";
import { LUCIDE, lucide } from "./iconset";
import { collapses, reply as replyView, type PathOpener, type ReplyFold } from "./markdown";
import { Bridge } from "../core/bridge";
import {
  DECISION_WORDS, QUIET_WORDS, State, isQuestion, isQuiet, isTool, repliedWords, requestsOf, stepsApart, subagentKind, subagentName, subagentStanding, subagentTask, subagentTook, targetTip,
  type ChangedFile, type ClaudeSession, type ModelInfo, type SessionStep, type StepKind, type Subagent,
} from "../core/state";
import { targetButton, targetIcon } from "./target";
import { TOOL_NAME, toolMark } from "./tool";
import type { SessionAgent } from "../core/state";
import { stepIcon, stepName, stepPreview, type ToType } from "./step";
import { botGlowColor } from "../core/layout";
import { contextUse } from "../core/context";
import { Reader } from "../core/reading";
import type { ViewActions, ViewHost } from "./views";

/** What a session is called until it has a project or a title to go by. */
const UNNAMED = "Claude Code";
/** An edit is typed out when it reached the island less than this ago; older, it is just shown. */
const FRESH_MS = 4_000;
/** However long the edit, typing it takes about this long, a tick at a time. */
const TYPE_MS = 1_800;
const TICK_MS = 16;

/**
 * Lines of what a step did that its entry of the journal shows: fewer at the
 * panel's normal size, where only an edit shows any; an edit's whole diff is
 * behind **N files**.
 */
const JOURNAL_LINES = { normal: 6, large: 14 };
/** This close to the journal's end, it is being followed: what comes next is scrolled to. */
const FOLLOW_PX = 24;
/** Further than this above its end, the journal shows the way back down. */
const JUMP_PX = 120;
/** A wiggle (the jump button's, a line's) is not repeated sooner than this: a run of finishes is one shake, not a constant one. */
const WIGGLE_GAP_MS = 1_500;
/** A reply brought into view starts this far under the journal's top edge. */
const REVEAL_GAP = 6;
/** The window is asked for the keyboard; this long later it has it, and a row can take the focus. */
const FOCUS_MS = 120;

/**
 * What is on screen: a session's journal, the journal of one of its subagents,
 * the list of its changes, or one file's diff.
 */
type Screen =
  | { kind: "live" }
  | { kind: "agent"; session: string; id: string }
  | { kind: "list" }
  | { kind: "file"; path: string };
let screen: Screen = { kind: "live" };
/** Bumped by every action: what the view shows has changed. */
let stamp = 0;

/** The kind of step the journal keeps; "all" keeps everything, what was said included. */
type Filter = "all" | "edit" | "command" | "read" | "search";
const FILTERS: readonly (readonly [Filter, string])[] = [
  ["all", "All"], ["edit", "Edits"], ["command", "Commands"], ["read", "Reads"], ["search", "Searches"],
];
let filter: Filter = "all";

function go(next: Screen) {
  screen = next;
  filter = "all";
  stamp++;
  State.notify();
}

/**
 * Into the panel: on the session's journal, at its end, or on the list of its
 * changes. The sessions to choose from are in the sidebar, whatever is on show.
 */
export function enterSessionPanel(on: "journal" | "changes" | "sessions" = "journal", whole = false) {
  screen = { kind: on === "changes" ? "list" : "live" };
  filter = "all";
  wantWhole = whole;
  stamp++;
}

/**
 * A very long reply is cut until it is asked for whole. Which form each
 * is in, by the journal's step — or, for what a subagent came back with, by
 * the subagent: remembered while the session lives, and saved nowhere.
 */
const replyFolds = new WeakMap<object, boolean>();
/** Whether each reply is long enough to be cut (markdown.ts `CUT_OVER`): worked out once. */
const longReplies = new WeakMap<SessionStep, boolean>();
/** The panel was entered to read the reply ("Read reply", a session that waits on a decision): its last one opens whole. */
let wantWhole = false;

function isLong(step: SessionStep): boolean {
  let long = longReplies.get(step);
  if (long == null) longReplies.set(step, (long = collapses(step.target ?? "")));
  return long;
}

/** What a session said last, as its journal holds it. */
function lastReply(session: ClaudeSession): SessionStep | null {
  for (let i = session.steps.length - 1; i >= 0; i--) {
    if (session.steps[i].kind === "reply" && session.steps[i].target) return session.steps[i];
  }
  return null;
}

/**
 * The way to open the files a session's replies name: only for a session that
 * runs in an editor — VS Code, Cursor. Any other has none, and its paths stay
 * the code they are: no editor is guessed.
 */
function openerOf(session: ClaudeSession): PathOpener | null {
  const { kind, label } = session.target;
  if (!session.id || (kind !== "vscode" && kind !== "cursor")) return null;
  return {
    tip: `Open in ${label}`,
    open: (path, line) => Bridge.openSessionFile(session.id, path, line),
    exists: (path) => fileExists(session.id, path),
  };
}

// ── Is a bare name a file? (markdown.ts `bareName`) ───────────────────────────
// Asked of Rust, which answers yes or no by the rule it opens files by. The
// answers are kept by session and name, so a journal drawn again asks nothing;
// the questions of one drawing go out together, a moment after the first.

/** How long a "no" is believed: the file may be written a moment later. A "yes" is kept. */
const NO_FILE_FOR_MS = 30_000;
/** The questions of one drawing are gathered for this long, and sent as one. */
const FILE_ASK_MS = 40;
/** As many as Rust looks at in one call (openfile.rs `MAX_CHECKS`). */
const FILE_ASK_MAX = 20;

const fileKnown = new Map<string, { there: boolean; at: number }>();
const fileAsked = new Map<string, Promise<boolean>>();
let fileQueue: { sessionId: string; path: string; settle: (there: boolean) => void }[] = [];
let fileTimer: number | null = null;
const fileKey = (sessionId: string, path: string) => `${sessionId}\n${path}`;

function flushFileQuestions() {
  fileTimer = null;
  const queue = fileQueue;
  fileQueue = [];
  const bySession = new Map<string, typeof queue>();
  for (const question of queue) bySession.set(question.sessionId, [...(bySession.get(question.sessionId) ?? []), question]);
  for (const [sessionId, questions] of bySession) {
    for (let i = 0; i < questions.length; i += FILE_ASK_MAX) {
      const batch = questions.slice(i, i + FILE_ASK_MAX);
      void Bridge.sessionFilesExist(sessionId, batch.map((q) => q.path)).then((answers) => {
        batch.forEach((q, n) => {
          const there = answers?.[n] === true;
          fileKnown.set(fileKey(sessionId, q.path), { there, at: Date.now() });
          fileAsked.delete(fileKey(sessionId, q.path));
          q.settle(there);
        });
      });
    }
  }
}

function fileExists(sessionId: string, path: string): boolean | Promise<boolean> {
  const key = fileKey(sessionId, path);
  const known = fileKnown.get(key);
  if (known && (known.there || Date.now() - known.at < NO_FILE_FOR_MS)) return known.there;
  const asked = fileAsked.get(key);
  if (asked) return asked;
  const answer = new Promise<boolean>((settle) => fileQueue.push({ sessionId, path, settle }));
  fileAsked.set(key, answer);
  if (fileTimer == null) fileTimer = window.setTimeout(flushFileQuestions, FILE_ASK_MS);
  return answer;
}

/** Out of a subagent's view, back to its session's journal. False when no subagent was on show. */
export function leaveSubagent(): boolean {
  if (screen.kind !== "agent") return false;
  go({ kind: "live" });
  return true;
}

const counted = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

// ── Several sessions ──────────────────────────────────────────────────────────

/** A session by its name: the conversation's title, or untitled, the folder it works in. */
export const sessionName = (session: ClaudeSession) => session.title ?? session.project;

/** Where a session is at, as a colour and in words: what its line of the sidebar shows and says. */
function standing(session: ClaudeSession): { color: string; words: string; quiet?: boolean } {
  if (session.question) return { color: COLOR.cyan, words: "is asking a question" };
  if (session.approval) return { color: COLOR.amber, words: "needs permission" };
  if (session.news === "error" || session.state === "error") return { color: COLOR.red, words: "stopped on an error" };
  // Its last reply waits on a decision: said after a request and an error, before "finished".
  if (session.decision) return { color: COLOR.purple, words: DECISION_WORDS.toLowerCase() };
  // It replied while its subagents still run, and nobody has looked yet: said as that, not as finished.
  if (session.news === "finished" && repliedWords(session)) return { color: COLOR.green, words: repliedWords(session)!.toLowerCase() };
  if (session.news === "finished" || session.state === "finished") return { color: COLOR.green, words: "finished" };
  if (session.state === "question") return { color: COLOR.cyan, words: "is waiting for you" };
  if (session.state === "idle" || session.state === "sleeping") return { color: COLOR.grey, words: "at rest" };
  // At work, and nothing heard from it for a long while: it says so, quietly. Its state is not touched.
  if (isQuiet(session)) return { color: botGlowColor(session.state), words: QUIET_WORDS, quiet: true };
  return { color: botGlowColor(session.state), words: session.state === "thinking" ? "thinking" : "at work" };
}

/** What the quiet word means, for whoever hovers it. */
const QUIET_TIP = "Nothing has come from this session for 10 minutes. It may be over: Claude Code does not always say when a turn ends.";

/** What the mark of a reply that waits on a decision means, for whoever hovers it. */
const DECISION_TIP = "Its last reply has something marked IMPORTANT. The mark goes once that reply has been read whole here, or when you answer it.";

/** Something a session wants looked at: it is waiting for an answer, or has news nobody has seen. */
const calls = (session: ClaudeSession) => session.news != null || session.question != null || session.approval != null || session.decision || session.attention;

/** What the mark of a turn that ended while the panel was being read says. */
const ATTENTION_WORDS = "New activity";

/**
 * The way to the sessions, where a session is shown: a chip that says how
 * many there are, kept in step by the function it returns. It is there only
 * with more than one, and takes the colour of a session behind the one on
 * show that wants looking at.
 */
export function sessionsChip(onOpen: () => void): { el: HTMLElement; sync(): void } {
  const el = h("button", { class: "sess-chip", onclick: onOpen });
  return {
    el,
    sync() {
      const count = State.sessions.length;
      el.style.display = count > 1 ? "" : "none";
      el.textContent = counted(count, "session");
      const calling = State.sessions.find((s) => s.id !== State.frontId && calls(s));
      el.classList.toggle("calls", calling != null);
      el.style.setProperty("--c", calling ? standing(calling).color : "currentColor");
      el.title = calling ? `${sessionName(calling)} ${standing(calling).words}${calling.attention ? ` — ${ATTENTION_WORDS.toLowerCase()}` : ""}` :"Every session followed, Claude Code and Cursor";
    },
  };
}

/**
 * A project's colour, for the thin stripe beside its sessions in the sidebar:
 * one of eight hues picked by its folder's name. (layout.ts `colorForProject`
 * has four, too few to tell four sessions apart.)
 */
const STRIPES = ["#3B9EFF", "#F472B6", "#A3E635", "#FB923C", "#8B5CF6", "#2DD4BF", "#FACC15", "#F87171"];
function stripe(project: string): string {
  let hash = 0;
  for (const ch of project) hash = (Math.imul(31, hash) + ch.charCodeAt(0)) | 0;
  return STRIPES[Math.abs(hash) % STRIPES.length];
}

/** A session by its folder; two in the same folder are told apart by a number. */
function folderOf(session: ClaudeSession): string {
  // Told apart within a tool: the same folder in Claude Code and in Cursor is told by the mark.
  const same = State.sessions.filter((s) => s.project === session.project && s.agent === session.agent);
  return same.length > 1 ? `${session.project} ·${same.indexOf(session) + 1}` : session.project;
}

/** What happened to the file: "edited" in grey, "new" in green. */
function statusWord(file: ChangedFile): HTMLElement {
  const word = h("span", { class: "gh-file-status", text: file.created ? "new" : "edited" });
  if (file.created) word.style.color = COLOR.green;
  return word;
}

function fileRow(file: ChangedFile): HTMLElement {
  const { dir, base } = splitPath(file.path);
  return h(
    "button",
    { class: "gh-row gh-file", title: file.path, onclick: () => go({ kind: "file", path: file.path }) },
    h("i", { class: "gh-row-icon" }, extBadge(file.path)),
    h("span", { class: "gh-row-title", text: base }),
    h("span", { class: "gh-row-where", text: dir }),
    h("span", { class: "gh-right" }, statusWord(file), plusMinus(file.additions, file.deletions), h("span", { class: "int-ago", text: timeAgo(file.at) })),
  );
}

/** A quiet line across a diff: lines skipped, or the start of another edit. */
function diffBreak(text: string): HTMLElement {
  return h("div", { class: "gh-diff-line hunk" }, h("span", { class: "n", text: "⋯" }), h("span", { class: "s" }), h("span", { class: "t", text }));
}

/** Every edit to the file, oldest first, a quiet break between two of them. */
function diffView(file: ChangedFile, kind: FileKind): HTMLElement {
  const diff = h("div", { class: "gh-diff" });
  const several = file.edits.length > 1;
  file.edits.forEach((edit, i) => {
    let first = true;
    for (const line of readPatch(edit.patch)) {
      if ("hunk" in line) {
        // Between two edits, which one this is; inside one, where lines were skipped.
        const label = first && several ? `Edit ${i + 1} of ${file.edits.length} · ${timeAgo(edit.at)}` : "";
        if (!first || label) diff.append(diffBreak(label));
        first = false;
        continue;
      }
      diff.append(diffLine(line.new ?? line.old, line.sign, line.text, kind));
    }
    if (edit.truncated) diff.append(diffBreak("The rest of this edit is in Claude Code"));
  });
  return h("div", { class: "gh-code" }, diff);
}

// ── Subagents: how each stands ────────────────────────────────────────────────

/**
 * The subagents a session's line of the sidebar lists: all it launched in the
 * turn under way, the finished ones dimmed — until that turn is really over,
 * when they clear. (They stay reachable from the lines of the journal where
 * they were launched.)
 */
const listed = (session: ClaudeSession) => session.subagents.filter((a) => !a.past);

/** How something stands, as a small round mark: going, done, failed — or waiting for the user. */
const MARKS = {
  running: () => h("i", { class: "sess-mark run" }),
  done: () => h("i", { class: "sess-mark done" }, svg(ICONS.check, 8, { stroke: 3.2 })),
  failed: () => h("i", { class: "sess-mark failed" }, svg(ICONS.xmark, 7)),
  asking: () => h("i", { class: "sess-mark needs" }, svg(ICONS.bang, 9)),
};

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** How long something has been going: kept up to date, a second at a time, by the panel's clock. */
function running(since: number): HTMLElement {
  const el = h("span", { class: "sess-elapsed", text: elapsed(Date.now() - since) });
  el.dataset.since = String(since);
  return el;
}

/**
 * How a subagent that has stopped ended, in words: "done in 1m 16s", "failed
 * after 27s" — and, when its start was not seen, just "done" or "failed": no
 * time is made up for it.
 */
function endedWords(a: Subagent): string {
  const ms = subagentTook(a);
  if (a.state === "failed") return ms == null ? "failed" : `failed after ${elapsed(ms)}`;
  return ms == null ? "done" : `done in ${elapsed(ms)}`;
}

/** How a subagent stands, in words: "running 1m 23s" (the time ticks, when its start was seen), or how it ended. */
function statusOf(session: ClaudeSession, a: Subagent): HTMLElement {
  const at = subagentStanding(session, a);
  const el = h("span", { class: `sess-status ${at}` });
  if (at === "asking") el.append(...(a.timed ? ["needs you · ", running(a.startedAt)] : ["needs you"]));
  else if (at === "running") el.append(...(a.timed ? ["running ", running(a.startedAt)] : ["running"]));
  else el.append(endedWords(a));
  return el;
}

function statusWords(session: ClaudeSession, a: Subagent): string {
  const at = subagentStanding(session, a);
  return at === "asking" ? "waiting for your answer" : at === "running" ? "running" : endedWords(a);
}

/** A subagent's kind and what it is at, as a tooltip says them. */
const fullName = (a: Subagent) => (subagentTask(a) ? `${subagentKind(a)} · ${subagentTask(a)}` : subagentKind(a));

// ── The journal ───────────────────────────────────────────────────────────────

/** When a line of the journal happened, as a clock shows it. */
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Several options picked for one question come back as one answer, joined like this. */
const ANSWER_JOIN = ", ";

/** Where a tool's permission request stands, in a word and a colour. */
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

/** A question Claude asked, with its options — and, once it is answered, the ones picked lit. */
function askedView(step: SessionStep): HTMLElement {
  const el = h("div", { class: "jr-asks" });
  for (const q of step.questions ?? []) {
    const answer = step.answers?.[q.question] ?? null;
    const picked = new Set(answer == null ? [] : [answer, ...answer.split(ANSWER_JOIN)]);
    const options = h("div", { class: "jr-options" });
    let matched = false;
    for (const option of q.options) {
      const on = picked.has(option.label);
      matched ||= on;
      options.append(h("span", { class: on ? "jr-option on" : "jr-option", text: option.label, title: option.description ?? "" }));
    }
    // An answer typed rather than picked is none of the options: it is shown as it was written.
    if (answer && !matched) options.append(h("span", { class: "jr-option on typed", text: answer }));
    el.append(h("div", { class: "jr-q" }, h("div", { class: "jr-q-title", text: q.question }), options));
  }
  if (!step.answers) {
    el.append(h("div", { class: "jr-waiting", text: step.state === "running" ? "Waiting for an answer…" : step.state === "failed" ? "Left unanswered." : "Answered in Claude Code." }));
  }
  return el;
}

/**
 * One line of a journal — a session's, or a subagent's: they are drawn the
 * same. Something said is shown as it was said: the user's words in a bubble,
 * Claude's as it wrote them. A tool is its icon, its name and what it was at,
 * then a look at what it did: at the panel's normal size an edit's first
 * lines and nothing else; in the large panel a command whole, and under every
 * step what it gave back. `said` is what a reply is drawn with: the way to the
 * files it names, and which of its two forms a long one is in.
 */
function journalEntry(step: SessionStep, large: boolean, said: Said, typed?: ToType[]): HTMLElement {
  if (step.kind === "prompt") {
    return h("div", { class: "jr jr-asked" }, h("div", { class: "sess-asked", text: step.target ?? "", title: clock(step.at) }));
  }
  if (step.kind === "reply") {
    return h(
      "div",
      { class: "jr jr-reply" },
      h("div", { class: "sess-said" }, dot(COLOR.green, 6), h("b", { text: "Claude" }), h("span", { text: clock(step.at) })),
      step.target ? replyView(step.target, said.opener, said.fold(step)) : h("div", { class: "jr-waiting", text: "The turn ended without a word." }),
    );
  }
  if (step.kind === "note") {
    return h("div", { class: step.state === "failed" ? "jr jr-note failed" : "jr jr-note", text: step.target ?? "" });
  }

  const command = step.kind === "command";
  const whole = step.target ?? "";
  const head = h(
    "div",
    { class: "jr-head" },
    h("i", {}, stepIcon(step, 11)),
    h("b", { text: stepName(step) }),
    h("span", { class: "at", text: large && command ? whole : whole.split("\n")[0], title: whole }),
    h("div", { class: "grow" }),
  );
  if (step.permission) head.append(chip(PERMISSIONS[step.permission].words, PERMISSIONS[step.permission].color));
  else if (step.questions && step.state === "running") head.append(chip("waiting for an answer", COLOR.cyan));
  if (step.state === "running") head.append(MARKS.running());
  else if (step.state === "failed" && !step.questions && !step.permission) head.append(chip("failed", COLOR.red));
  head.append(h("span", { class: "jr-time", text: clock(step.at) }));

  const el = h("div", { class: `jr jr-step ${step.state} ${step.kind}` }, head);
  if (step.questions) el.append(askedView(step));
  else {
    let preview: HTMLElement | null = null;
    if (step.patch != null) preview = stepPreview(step, large ? JOURNAL_LINES.large : JOURNAL_LINES.normal, typed);
    // The command is in the head, whole: under it, only what it printed.
    else if (large) preview = stepPreview(step, JOURNAL_LINES.large, undefined, command);
    if (preview) el.append(h("div", { class: "jr-body" }, preview));
  }
  return el;
}

/** What a reply is drawn with. */
interface Said {
  opener: PathOpener | null;
  fold(key: object): ReplyFold;
}

/** What an entry is drawn from: when it changes, the entry is drawn again. */
const entryKey = (step: SessionStep, large: boolean, opener: PathOpener | null) =>
  [
    step.kind, step.state, step.result?.text.length, step.patch?.length, step.permission, step.answers ? Object.values(step.answers).join("|") : "", large,
    // A reply: which form it is in, and whether its paths open — and where.
    ...(step.kind === "reply" ? [replyFolds.get(step) ?? false, opener?.tip ?? ""] : []),
  ].join("~");

/**
 * The model a session or a subagent runs on, as a quiet chip — or nothing:
 * one that no event named is not guessed.
 */
function modelChip(model: ModelInfo | null | undefined): HTMLElement[] {
  return model ? [h("span", { class: "sess-model", text: model.label, title: model.id })] : [];
}

/** Which agent a subagent is, and the model it runs on — "Explore · Haiku 4.5": the model only when an event named it. */
const subagentMeta = (agent: Pick<Subagent, "type" | "model">) =>
  agent.model ? `${subagentKind(agent)} · ${agent.model.label}` : subagentKind(agent);

export function buildSession(actions: ViewActions): ViewHost {
  // ── What the panel is made of ───────────────────────────────────────────────

  // The sidebar: the bot (the island draws it, here is its room), whose
  // session this is, and the tree of the sessions and their subagents.
  const name = h("b", { text: UNNAMED });
  const nameSub = h("span");
  // The model the session runs on, beside its name — in the panel at its
  // normal size, where the line above the journal has no room for it.
  const nameModel = h("span", { class: "sess-name-model" });
  const tree =h("div", { class: "sess-tree", role: "tree", "aria-label": "Sessions and their subagents" });
  // All · Claude Code · Cursor · Codex: there only while sessions of more than one tool are followed.
  let toolFilter: "all" | SessionAgent = "all";
  const toolChips = h("div", { class: "sess-tools", role: "group", "aria-label": "Show sessions of" });
  toolChips.hidden = true;
  const rail = h(
    "div",
    { class: "sess-rail" },
    h("div", { class: "sess-rail-head" }, h("div", { class: "sess-bot-slot" }), h("div", { class: "gh-side-who" }, h("div", { class: "sess-name-row" }, name, nameModel), nameSub)),
    toolChips,
    tree,
  );
  /** The chips of the filter, drawn again when the kinds followed change. */
  let chipsKey = "";
  function drawToolChips() {
    const kinds = (["claude", "cursor", "codex"] as const).filter((kind) => State.sessions.some((s) => s.agent === kind));
    const both = kinds.length > 1;
    if (!both || (toolFilter !== "all" && !kinds.includes(toolFilter))) toolFilter = "all";
    const key = `${kinds.join()}|${toolFilter}`;
    toolChips.hidden = !both;
    if (key === chipsKey) return;
    chipsKey = key;
    clear(toolChips);
    if (!both) return;
    for (const which of ["all", ...kinds] as const) {
      const label = which === "all" ? "All" : TOOL_NAME[which];
      const chip = h("button", { class: `sess-tool${toolFilter === which ? " on" : ""}`, type: "button", "aria-pressed": String(toolFilter === which) },
        which === "all" ? null : toolMark(which, 10), label);
      chip.addEventListener("click", () => {
        toolFilter = which;
        railKey = "";
        chipsKey = "";
        drawToolChips();
        drawRail(State.session);
      });
      toolChips.append(chip);
    }
  }

  // Above a journal: the chips that keep one kind of step — and, for the
  // session's own, where it is at and the way to its changes and to where it
  // runs. Above a subagent's: where one is, and the way back.
  const filters = h("div", { class: "sess-filters" });
  const crumb = h("div", { class: "sess-crumb" });
  // The way to where the session runs — an editor's window, a terminal's, the
  // Claude app — said by its icon and its tooltip; none for a session nothing
  // says the place of.
  const goToSession = () => targetButton("gh-icon", 11, () => actions.openTerminal());
  /** The one above the changes: built once, it follows the session in front. */
  const headTarget = goToSession();

  // Above the changes and a file's diff: a head like an editor's tab.
  const who = h("b");
  const sub = h("span", { class: "gh-sub" });
  const badge = h("span", { class: "gh-head-badge" });
  const aside = h("span", { class: "gh-head-aside" });
  // One step back: from a file to the changes, from the changes to the journal.
  const backBtn = h("button", { class: "gh-icon sess-back", title: "Back" }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 }));
  const tab = h("div", { class: "gh-tab" }, badge, who);
  const head = h("div", { class: "gh-head" }, backBtn, tab, aside, h("div", { class: "grow" }), sub, headTarget.el);
  // The journal, and behind it the changes: one of the two is on screen.
  const journal = h("div", { class: "gh-list sess-journal" });
  const list = h("div", { class: "gh-list" });

  // The way back to the journal's end, from further up. A sibling of the
  // scroller, not a child: the journal is redrawn and fades out at its edge.
  const jumpDot = h("i", { class: "sess-jump-dot" });
  const jump = h("button", { class: "sess-jump", type: "button", "aria-label": "Jump to latest", title: "Jump to latest", hidden: true }, svg(ICONS.chevronDown, 12, { stroke: 2.4 }), jumpDot);
  const main = h("div", { class: "gh-main" }, head, crumb, filters, journal, list, jump);
  // The panel itself can hold the focus, unseen: keys then reach the island
  // without any line of the sidebar having been given it.
  const el = h("div", { class: "view gh-view session-view", tabindex: "-1" }, h("div", { class: "card gh-card" }, rail, main));

  backBtn.addEventListener("click", () => {
    actions.blip();
    go(screen.kind === "file" ? { kind: "list" } : { kind: "live" });
  });

  for (const scroller of [journal, list]) {
    const fade = () => scroller.classList.toggle("more", scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2);
    scroller.addEventListener("scroll", fade, { passive: true });
    new ResizeObserver(fade).observe(scroller);
  }

  // Where the reader wants the journal: at its end, until they scroll up on
  // purpose. Kept apart from where it is now, because a size change moves the
  // end without a scroll: the panel growing or shrinking, a session's lines
  // drawn longer at the large size. Only a scroll upward, away from the end,
  // lets go of it; one back to the end takes it up again.
  let pinned = true;
  let lastTop = 0;
  /** Something came in under a reader who is further up. */
  let unread = false;
  /** A turn ended under the reader (hooks.ts `hold`): the button shows for it, however near the end they are. */
  let held = false;
  /** The sync under way is one a turn's end was held back for: set by `sync`, for the front session. */
  let holding = false;
  /** The front session's turn ended while its journal was not on show (the changes, a file): its line wears the mark until the journal is back, where the button takes it up. */
  let owed: ClaudeSession | null = null;

  /** `pinned`, told to the one who asks whether the panel is being read (`core/reading.ts`). */
  function pin(on: boolean) {
    pinned = on;
    Reader.away = !on;
  }

  // Whoever touches the panel is reading it, for a while.
  for (const type of ["wheel", "keydown", "pointerdown", "pointermove"]) el.addEventListener(type, () => Reader.touch(), { passive: true, capture: true });

  const gapBelow = () => journal.scrollHeight - journal.scrollTop - journal.clientHeight;

  function placeJump() {
    // Not when the journal has no height (the island folded, the journal hidden): nothing was reached.
    if (journal.clientHeight > 0 && gapBelow() <= FOLLOW_PX) unread = held = false;
    const far = journal.clientHeight > 0 && journal.scrollHeight > journal.clientHeight && gapBelow() > JUMP_PX;
    // Something that ended under a reader who is near the end, though not far
    // from it: the button shows for it, with its dot, until the end is reached.
    const behind = held && journal.clientHeight > 0 && journal.scrollHeight > journal.clientHeight;
    jump.hidden = !(far || behind);
    jump.classList.toggle("fresh", !jump.hidden && unread);
  }

  /** Last time something wiggled, by what: a session's line, or the jump button. */
  const wiggled = new WeakMap<object, number>();

  /** A short shake of `el`, once; not again within `WIGGLE_GAP_MS`. It takes no pointer and no focus. */
  function wiggle(el: HTMLElement, by: object) {
    const now = Date.now();
    if (now - (wiggled.get(by) ?? 0) < WIGGLE_GAP_MS) return;
    wiggled.set(by, now);
    replay(el, "sess-wiggle");
  }
  el.addEventListener("animationend", (e) => (e.target as HTMLElement).classList.remove("sess-wiggle"));

  journal.addEventListener("scroll", () => {
    const top = journal.scrollTop;
    if (gapBelow() <= FOLLOW_PX) pin(true);
    else if (top < lastTop) pin(false);
    lastTop = top;
    placeJump();
  }, { passive: true });

  // Every step of the panel's animation resizes the journal: it is put back at
  // its end each time, so that it is there when the panel settles.
  new ResizeObserver(() => {
    if (pinned && journal.clientHeight > 0) journal.scrollTop = journal.scrollHeight;
    placeJump();
  }).observe(journal);

  jump.addEventListener("click", () => {
    pin(true);
    unread = held = false;
    const still = document.documentElement.dataset.motion === "reduce";
    journal.scrollTo({ top: journal.scrollHeight, behavior: still ? "auto" : "smooth" });
    placeJump();
  });

  /** A session picked in the sidebar: it comes in front, on its journal. The one in front goes back to its journal. */
  function pickSession(id: string) {
    actions.blip();
    if (id !== State.frontId) actions.pickSession(id);
    // One whose last reply waits on a decision is picked to read it: it opens whole.
    wantWhole = State.sessions.find((s) => s.id === id)?.decision === true;
    go({ kind: "live" });
  }

  /** A subagent picked — in the sidebar, or on the line where it was launched: its own view. */
  function openAgent(sessionId: string, agentId: string) {
    actions.blip();
    if (sessionId !== State.frontId) actions.pickSession(sessionId);
    go({ kind: "agent", session: sessionId, id: agentId });
  }

  // ── The sidebar: a tree of sessions and their subagents ─────────────────────
  // The sessions stay in the order they were first heard in: a line never
  // moves from under the pointer or the keyboard because a request came in.
  //
  // What is open. A session's subagents show while one of them runs. Closed by
  // hand, they stay closed until they are opened by hand or a NEW subagent
  // starts (the count of subagents is kept at the moment of closing: more than
  // that, and the line follows its subagents again). Opened by hand, they stay
  // open — finished subagents too — until closed.
  //
  // The keyboard. One tab stop (roving tabindex). Up / Down move through the
  // lines on show, Home / End go to the first and the last, Enter opens the
  // line, Ctrl+Enter goes to where a session runs, Right opens a session's subagents (or, open already, goes
  // to the first), Left closes them (or, on a subagent, goes to its session).
  // Space is not the tree's: it is the panel's size, wherever the focus is
  // (island.ts). It works once the island has the keyboard, which a click in
  // the tree, opening the panel, or the panel going large, asks for. No line
  // is given the focus by any of those: the panel holds it, and the first
  // arrow pressed puts it on the tree's tab stop.

  type Fold = { open: true } | { open: false; count: number };
  const folds = new Map<string, Fold>();

  function expanded(session: ClaudeSession, subs: Subagent[]): boolean {
    if (subs.length === 0) return false;
    const fold = folds.get(session.id);
    if (fold?.open) return true;
    if (fold && subs.length <= fold.count) return false;
    if (fold) folds.delete(session.id);
    return subs.some((a) => a.state === "running");
  }

  function toggle(session: ClaudeSession, open: boolean) {
    folds.set(session.id, open ? { open: true } : { open: false, count: listed(session).length });
    State.notify();
  }

  const sessionKey = (sessionId: string) => `s:${sessionId}`;
  const agentKey = (sessionId: string, agentId: string) => `a:${sessionId}:${agentId}`;
  const domId = (key: string) => `sess-${key.replace(/[^a-zA-Z0-9]/g, "-")}`;

  /** The line the keyboard is on. */
  let focusKey = "";
  /** The last thing used was the keyboard: the line with the focus wears its ring. */
  let byKeyboard = false;
  /** What the tree last drew: drawn again only when it changes, so a click is never lost between its down and its up. */
  let railKey = "";

  const rows = () => [...tree.querySelectorAll<HTMLElement>(".sess-ti")];

  function moveTo(row: HTMLElement | undefined) {
    if (!row) return;
    for (const other of rows()) other.tabIndex = other === row ? 0 : -1;
    focusKey = row.dataset.key!;
    row.focus();
    row.scrollIntoView({ block: "nearest" });
  }

  function drawRail(front: ClaudeSession) {
    const onAgent = screen.kind === "agent" ? screen.id : null;
    // What each line shows, and whether its subagents are on show.
    const lines = State.sessions.filter((s) => toolFilter === "all" || s.agent === toolFilter).map((session) => {
      const subs = listed(session);
      return { session, subs, open: expanded(session, subs), at: standing(session) };
    });
    const next = lines
      .map(({ session, subs, open, at }) =>
        [
          session.id, session.agent, folderOf(session), session.title, at.words, at.color, open, targetTip(session), session.target.kind, session.model?.label, session.decision, session.attention,
          contextUse(session.contextTokens, session.contextWindow, session.model?.id)?.percent,
          ...subs.map((a) => [a.id, a.type, subagentTask(a), subagentStanding(session, a), a.model?.label].join(":")),
        ].join("~"))
      .concat(front.id, onAgent ?? "", owed?.id ?? "")
      .join("|");
    if (next === railKey) return;
    railKey = next;

    const hadFocus = tree.contains(document.activeElement);
    const scroll = tree.scrollTop;
    clear(tree);
    for (const { session, subs, open, at } of lines) {
      const inFront = session === front;
      const key = sessionKey(session.id);
      const groupId = `${domId(key)}-subs`;
      const asking = subs.filter((a) => subagentStanding(session, a) === "asking").length;
      const going = subs.filter((a) => a.state === "running").length;
      const folder = folderOf(session);
      const mark = dot(at.color, 7);
      if (session.question || session.approval) mark.classList.add("calls");
      mark.style.setProperty("--c", at.color);

      const row = h("div", {
        class: `sess-ti sess-node${inFront ? " front" : ""}${inFront && !onAgent ? " on" : ""}`,
        id: domId(key),
        role: "treeitem",
        "aria-level": 1,
        "aria-selected": String(inFront && !onAgent),
        title: `${TOOL_NAME[session.agent]} — ${folder} — ${session.title ?? TOOL_NAME[session.agent]}${session.model ? ` — ${session.model.label}` : ""} — ${at.words}${subs.length ? ` — ${counted(subs.length, "subagent")}, ${going} running` : ""}`,
      });
      row.dataset.key = key;
      row.dataset.session = session.id;
      row.style.setProperty("--c", stripe(session.project));
      if (subs.length > 0) {
        row.setAttribute("aria-expanded", String(open));
        row.setAttribute("aria-owns", groupId);
        const twisty = h("i", { class: "sess-twisty", title: open ? "Hide its subagents" : "Show its subagents" }, svg(ICONS.chevronRight, 9, { stroke: 2.8 }));
        twisty.addEventListener("click", (e) => {
          e.stopPropagation();
          toggle(session, !open);
        });
        row.append(twisty);
      } else {
        row.append(h("i", { class: "sess-twisty none" }));
      }
      row.append(toolMark(session.agent, 11), h("b", { text: folder }));
      if (subs.length > 0) {
        row.append(h("span", {
          class: asking > 0 ? "sess-count asking" : going > 0 ? "sess-count going" : "sess-count",
          text: String(subs.length),
          title: `${counted(subs.length, "subagent")}: ${going} running${asking ? `, ${asking} waiting for you` : ""}`,
        }));
      }
      // The way to where it runs, from its own line: no need to put it in
      // front first. Not a tab stop — the tree has one — and a click on it is
      // not a click on the line. None for a session nothing says the place of.
      const tip = targetTip(session);
      const icon = tip ? targetIcon(session.target.kind, 10) : null;
      if (tip && icon) {
        const goto = h("i", { class: "sess-goto", title: `${tip} (Ctrl+Enter)`, "aria-label": tip, role: "button" }, icon);
        goto.dataset.target = session.target.kind;
        // Not the tree's mouse-down either: going there is not asking for the keyboard.
        goto.addEventListener("mousedown", (e) => {
          e.stopPropagation();
          e.preventDefault();
        });
        goto.addEventListener("click", (e) => {
          e.stopPropagation();
          actions.blip();
          actions.goToSession(session.id);
        });
        goto.addEventListener("dblclick", (e) => e.stopPropagation());
        row.append(goto);
      }
      // How full its context is, for the one to go and /compact: a cue, as Nook cannot do it.
      // Said in words as well as colour; none before an answer has been counted.
      const use = contextUse(session.contextTokens, session.contextWindow, session.model?.id);
      if (use) {
        const words = `Context ${use.percent}%`;
        row.append(h("i", { class: `sess-ctx ${use.level}`, title: words }, h("u", { style: `width:${use.percent}%` }), h("span", { class: "sess-ctx-words", text: words })));
        row.title += ` — ${words}`;
      }
      // A turn of its ended while the panel was being read: not said by sound or card, but here, until it is opened.
      if ((session.attention && !inFront) || session === owed) {
        row.classList.add("attn");
        row.append(h("i", { class: "sess-new", role: "img", "aria-label": ATTENTION_WORDS, title: ATTENTION_WORDS }));
        row.title += ` — ${ATTENTION_WORDS.toLowerCase()}`;
      }
      row.append(mark);
      row.addEventListener("click", () => pickSession(session.id));
      tree.append(row);
      // Nothing heard from it for a long while: a quiet word under its line.
      if (at.quiet) tree.append(h("div", { class: "sess-quiet", text: at.words, title: QUIET_TIP }));
      // Its last reply waits on a decision: a mark under its line, whatever its dot says — a request
      // or an error keeps the dot. A click reads the reply, as a click on the line does.
      if (session.decision) {
        tree.append(h(
          "div", { class: "sess-decide", title: DECISION_TIP, onclick: () => pickSession(session.id) },
          lucide(LUCIDE.messageSquareWarning, 10, 2.2), h("span", { text: DECISION_WORDS }),
        ));
      }

      if (subs.length === 0 || !open) continue;
      const group = h("div", { class: "sess-subs", id: groupId, role: "group" });
      for (const a of subs) {
        const akey = agentKey(session.id, a.id);
        const on = inFront && onAgent === a.id;
        const stands = subagentStanding(session, a);
        const line = h(
          "div",
          {
            class: `sess-ti sess-sub ${stands}${on ? " on" : ""}`,
            id: domId(akey),
            role: "treeitem",
            "aria-level": 2,
            "aria-selected": String(on),
            // All of both lines, however they were cut: its type and task, its model, how it stands.
            title: `${fullName(a)}${a.model ? ` — ${a.model.label}` : ""} — ${statusWords(session, a)}`,
          },
          MARKS[stands](),
          // Two lines: what it was launched to do, and under it, quieter, which agent it is and the model it runs on.
          h("span", { class: "sess-sub-words" },
            h("span", { class: "sess-sub-task", text: subagentTask(a) ?? subagentKind(a) }),
            h("span", { class: "sess-sub-meta", text: subagentMeta(a) })),
        );
        if (stands === "asking") line.append(h("span", { class: "sess-sub-needs", text: "needs me" }));
        line.dataset.key = akey;
        line.dataset.session = session.id;
        line.dataset.agent = a.id;
        line.addEventListener("click", () => openAgent(session.id, a.id));
        group.append(line);
      }
      tree.append(group);
    }

    // One line holds the tab stop: the one the keyboard was on, or its session when it is no longer on show.
    const all = rows();
    let holder = all.find((r) => r.dataset.key === focusKey);
    if (!holder && focusKey.startsWith("a:")) holder = all.find((r) => r.dataset.key === sessionKey(focusKey.split(":")[1]));
    holder ??= all.find((r) => r.classList.contains("on")) ?? all[0];
    for (const r of all) r.tabIndex = r === holder ? 0 : -1;
    if (holder) focusKey = holder.dataset.key!;
    tree.scrollTop = scroll;
    if (hadFocus && holder) {
      holder.focus();
      holder.scrollIntoView({ block: "nearest" });
    }
  }

  /** Puts the focus on the tree's tab stop, once the window has the keyboard: the arrows then move through it. */
  function focusTree() {
    window.setTimeout(() => {
      if (tree.contains(document.activeElement)) return;
      rows().find((r) => r.tabIndex === 0)?.focus({ preventScroll: true });
    }, FOCUS_MS);
  }

  /**
   * The panel opens, or goes large: the panel itself takes the focus, once the
   * window has the keyboard — never a line of the tree, which would then take
   * the next key for itself and wear a ring nobody asked for. Whatever in the
   * panel has the focus already keeps it.
   */
  function focusPanel() {
    window.setTimeout(() => {
      if (State.mode !== "expanded" || State.view !== "session") return;
      const active = document.activeElement;
      if (active && active !== document.body && el.contains(active)) return;
      el.focus({ preventScroll: true });
    }, FOCUS_MS);
  }

  // The first arrow pressed with the focus on the panel, not in the tree: the
  // tree's tab stop takes it, and wears its ring from then on.
  const TREE_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]);
  el.addEventListener("keydown", (e) => {
    if (!TREE_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    if (tree.contains(target) || target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const stop = rows().find((r) => r.tabIndex === 0);
    if (!stop) return;
    e.preventDefault();
    byKeyboard = true;
    tree.classList.add("kbd");
    stop.focus();
    stop.scrollIntoView({ block: "nearest" });
  });

  // A click in the tree is asking to use it: the island takes the keyboard,
  // which its window never has on its own, so the arrows work from then on.
  tree.addEventListener("mousedown", () => {
    byKeyboard = false;
    tree.classList.remove("kbd");
    actions.panelKeyboard();
    focusTree();
  });
  tree.addEventListener("focusin", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".sess-ti");
    if (row?.dataset.key) focusKey = row.dataset.key;
  });
  tree.addEventListener("keydown", (e) => {
    const all = rows();
    const row = (e.target as HTMLElement).closest<HTMLElement>(".sess-ti");
    if (!row) return;
    const session = State.sessions.find((s) => s.id === row.dataset.session);
    if (!session) return;
    // Ctrl+Enter on a session's line: to where it runs, as its ↗ does.
    if (e.key === "Enter" && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !row.dataset.agent) {
      e.preventDefault();
      if (targetTip(session)) actions.goToSession(session.id);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const i = all.indexOf(row);
    const agentId = row.dataset.agent;
    const hasSubs = row.hasAttribute("aria-expanded");
    const open = row.getAttribute("aria-expanded") === "true";
    let handled = true;
    switch (e.key) {
      case "ArrowDown": moveTo(all[i + 1]); break;
      case "ArrowUp": moveTo(all[i - 1]); break;
      case "Home": moveTo(all[0]); break;
      case "End": moveTo(all[all.length - 1]); break;
      case "Enter":
        if (agentId) openAgent(session.id, agentId);
        else pickSession(session.id);
        break;
      case "ArrowRight":
        if (agentId || !hasSubs) break;
        if (open) moveTo(all[i + 1]);
        else toggle(session, true);
        break;
      case "ArrowLeft":
        if (agentId) moveTo(all.find((r) => r.dataset.key === sessionKey(session.id)));
        else if (open) toggle(session, false);
        break;
      default: handled = false;
    }
    if (!handled) return;
    byKeyboard = true;
    tree.classList.add("kbd");
    e.preventDefault();
  });

  // ── Typing ──────────────────────────────────────────────────────────────────

  let typing: number | null = null;
  /** Shows at once whatever the typing under way has left to type. */
  let finishTyping: (() => void) | null = null;

  function stopTyping() {
    if (typing != null) window.clearInterval(typing);
    typing = null;
    finishTyping?.();
    finishTyping = null;
  }

  /**
   * Types the new lines of an edit one after the other, a caret at the end,
   * each line taking its colours once it is whole. Out of sight — the island
   * folded, another view up — it has nobody to type for and ends at once.
   */
  function type(lines: ToType[], kind: FileKind) {
    stopTyping();
    if (lines.length === 0) return;
    const total = lines.reduce((n, l) => n + l.text.length + 1, 0);
    const perTick = Math.max(1, Math.ceil(total / (TYPE_MS / TICK_MS)));
    const caret = h("span", { class: "sess-caret" });
    let at = 0;
    let letters = 0;

    const finish = (line: ToType) => line.row.replaceWith(diffLine(line.number, "+", line.text, kind));
    const begin = (line: ToType) => {
      line.row.classList.remove("untyped");
      // Only for one who follows the end: a reader who is further up keeps their place.
      if (pinned || gapBelow() <= FOLLOW_PX) line.row.scrollIntoView({ block: "nearest" });
    };
    begin(lines[0]);
    finishTyping = () => lines.slice(at).forEach(finish);

    typing = window.setInterval(() => {
      const seen = State.mode === "expanded" && State.view === "session" && lines[at].row.isConnected;
      let budget = seen ? perTick : total;
      while (budget > 0 && at < lines.length) {
        const line = lines[at];
        const step = Math.min(budget, line.text.length - letters);
        letters += step;
        budget -= step;
        if (letters < line.text.length) break;
        // The end of a line costs a letter: the pause of a carriage return.
        finish(line);
        budget -= 1;
        at++;
        letters = 0;
        if (at < lines.length) begin(lines[at]);
      }
      if (at >= lines.length) {
        stopTyping();
        if (pinned || gapBelow() <= FOLLOW_PX) journal.scrollTop = journal.scrollHeight;
        return;
      }
      const cell = lines[at].row.querySelector(".t");
      if (cell) {
        cell.textContent = lines[at].text.slice(0, letters);
        cell.append(caret);
      }
    }, TICK_MS);
  }

  // ── A journal: the session's, or a subagent's ───────────────────────────────

  /** Each step's entry, kept: only one that changed is drawn again, and a scroll or a selection stays. */
  const entries = new WeakMap<SessionStep, { el: HTMLElement; key: string }>();
  /** The edits typed already: an edit is typed once. */
  const typedSteps = new WeakSet<SessionStep>();
  const empty = h("div", { class: "int-empty" });
  /** What the journal was last opened on: another session or subagent, or the panel entered again, starts at its end. */
  let opened = "";
  let shown = "";
  let shownSession = "";

  /**
   * The place in the main journal where a subagent was launched: one line,
   * with how it stands. A click opens the subagent's own view.
   */
  function launchRow(session: ClaudeSession, a: Subagent): HTMLElement {
    const stands = subagentStanding(session, a);
    const task = subagentTask(a);
    return h(
      "button",
      {
        class: `jr sess-launch ${stands}`,
        title: `${fullName(a)} — ${statusWords(session, a)}. Open its steps.`,
        onclick: () => openAgent(session.id, a.id),
      },
      MARKS[stands](),
      h("b", { text: "Launched" }),
      // Its kind, then what it is at; with nothing said of that, its kind alone.
      h("span", { class: "sess-launch-type", text: task ? `${subagentKind(a)}:` : subagentKind(a) }),
      task ? h("span", { class: "sess-launch-task", text: task }) : null,
      h("span", { class: "sess-launch-sep", text: "·" }),
      statusOf(session, a),
      h("span", { class: "grow" }),
      ...modelChip(a.model),
      h("span", { class: "jr-time", text: clock(a.startedAt) }),
      h("i", { class: "sess-launch-go" }, svg(ICONS.chevronRight, 9, { stroke: 2.8 })),
    );
  }

  /** What a subagent's view ends on, kept while it says the same: its buttons are not rebuilt under a click. */
  let ended: { key: string; el: HTMLElement; of: Subagent } | null = null;

  /** The reply whose form has just been changed, or that the panel was entered to read: its top is brought into view. */
  let reveal: object | null = null;

  /** A long reply's form, and the way to its other one. `key` is its step, or its subagent. */
  function foldOf(key: object): ReplyFold {
    return {
      open: replyFolds.get(key) ?? false,
      toggle(open) {
        actions.blip();
        replyFolds.set(key, open);
        reveal = key;
        State.notify();
      },
    };
  }

  /**
   * Before a session's journal is drawn: the reply the panel was entered to
   * read opens whole; and a reply that waits on a decision, once it is on show
   * whole — a short one as soon as its journal is, a long one once it has
   * been opened — has been read: its mark goes.
   */
  function settleReply(session: ClaudeSession, agent: Subagent | null) {
    const whole = wantWhole;
    wantWhole = false;
    if (agent || !(whole || session.decision)) return;
    const said = lastReply(session);
    if (!said) return;
    if (whole && isLong(said)) {
      replyFolds.set(said, true);
      reveal = said;
    }
    const shown = State.mode === "expanded" && State.view === "session" && filter === "all";
    if (session.decision && shown && said.target === session.answer && (!isLong(said) || replyFolds.get(said) === true)) session.decision = false;
  }

  /** What a subagent's view ends on: what it came back with — or, while it runs, that it still does. */
  function ending(session: ClaudeSession, a: Subagent): HTMLElement {
    const stands = subagentStanding(session, a);
    const request = requestsOf(session).find((r) => r.agentId === a.id) ?? null;
    // What it came back with opens the files it names in its session's editor.
    const opener = openerOf(session);
    const key = [session.id, a.id, stands, a.result, request?.requestId, a.timed, a.endedAt, replyFolds.get(a) ?? false, opener?.tip ?? ""].join("~");
    if (ended?.key === key) return ended.el;
    let el: HTMLElement;
    if (request) {
      const question = isQuestion(request);
      const what = question ? (request.questions[0]?.question ?? "") : request.command;
      el = h(
        "div",
        { class: "jr sess-end asking" },
        MARKS.asking(),
        h("span", { class: "sess-end-words" }, h("b", { text: question ? "Waiting for your answer" : "Waiting for your permission" }), h("span", { class: "sess-end-what", text: what, title: what })),
        h("button", { class: "sess-end-btn", text: question ? "Show question" : "Show request", onclick: () => actions.showRequest() }),
      );
    } else if (a.state === "running") {
      el = h("div", { class: "jr sess-end running" }, MARKS.running(), h("span", { class: "sess-end-words" }, h("b", {}, ...(a.timed ? ["Still running · ", running(a.startedAt)] : ["Still running"])), h("span", { text: "Its result will show here when it finishes." })));
    } else {
      const failed = a.state === "failed";
      el = h(
        "div",
        { class: `jr sess-result ${a.state}` },
        h("div", { class: "sess-result-h" }, MARKS[a.state](), h("b", { text: failed ? "Stopped without finishing" : "Result" }), h("span", { text: endedWords(a) })),
        replyView(a.result ?? (failed ? "It said nothing before it stopped." : "It finished without a last message."), opener, foldOf(a)),
      );
    }
    ended = { key, el, of: a };
    return el;
  }

  /** No agent ids on tool events: SubagentStart and SubagentStop still name the subagent, but none of its steps do. */
  const apart = h(
    "div",
    { class: "jr sess-apart" },
    svg(ICONS.bang, 12),
    h(
      "div",
      {},
      h("b", { text: "This subagent's steps cannot be told apart on this version of Claude Code." }),
      h("span", { text: "Its tool events carry no agent id, so they are in the main journal, among the session's own steps, in the order they happened." }),
      h("button", { class: "sess-end-btn", text: "Open the main journal", onclick: () => go({ kind: "live" }) }),
    ),
  );

  const wanted = (step: SessionStep) => filter === "all" || step.kind === filter;

  function syncJournal(session: ClaudeSession, agent: Subagent | null) {
    const source = `${session.id}/${agent?.id ?? ""}`;
    const entering = opened !== `${source}:${stamp}`;
    opened = `${source}:${stamp}`;
    if (entering) {
      pin(true);
      unread = held = false;
    }
    // A turn ended while this was being read: the journal does not follow its
    // end, nor move at all, until the reader goes down by themselves (the
    // button) — whether they were at the end or further up.
    const keep = holding && !entering;
    if (keep) pin(false);
    const following = entering || (!keep && (pinned || gapBelow() <= FOLLOW_PX));
    const was = journal.scrollHeight;
    const place = journal.scrollTop;
    const large = State.large;
    const told = agent == null || stepsApart(session, agent);

    let toType: { lines: ToType[]; kind: FileKind } | null = null;
    const said: Said = { opener: openerOf(session), fold: foldOf };
    const nodes: HTMLElement[] = [];
    const steps = agent ? agent.steps : session.steps;
    for (const step of told ? steps.filter(wanted) : []) {
      // Where a subagent was launched: a line of its own, drawn from how the subagent stands.
      const launched = step.kind === "launch" ? session.subagents.find((a) => a.id === step.agentId) : null;
      if (step.kind === "launch" && !launched) continue;
      const key = launched
        ? [launched.type, subagentTask(launched), subagentStanding(session, launched), launched.endedAt, launched.timed, launched.model?.label].join("~")
        : entryKey(step, large, said.opener);
      let entry = entries.get(step);
      if (!entry || entry.key !== key) {
        const known = entry != null;
        // Typed once, and only while it is news: seen later, the edit is just there.
        const fresh = step.patch != null && !typedSteps.has(step) && !entering && Date.now() - step.at < FRESH_MS;
        if (step.patch != null) typedSteps.add(step);
        const lines: ToType[] = [];
        const drawn = launched ? launchRow(session, launched) : journalEntry(step, large, said, fresh ? lines : undefined);
        // A line that is new comes in; one that got something more — what the
        // tool gave back, what was decided — only brings that in.
        if (!entering) drawn.classList.add(known ? "more" : "in");
        entry?.el.replaceWith(drawn);
        entry = { el: drawn, key };
        entries.set(step, entry);
        if (lines.length > 0) toType = { lines, kind: fileKind(step.target ?? "") };
      }
      nodes.push(entry.el);
    }
    if (!told) nodes.push(apart);
    else if (nodes.length === 0) {
      empty.textContent =
        filter !== "all" ? `No step of this kind in this ${agent ? "subagent" : "session"}${steps.length > 0 ? "" : " yet"}.`
        : agent ? "No step yet."
        : session.id ? "Nothing has happened in this session yet." : "No Claude Code session yet.";
      nodes.push(empty);
    }
    if (agent) nodes.push(ending(session, agent));
    const same = journal.children.length === nodes.length && nodes.every((node, i) => journal.children[i] === node);
    if (!same) journal.replaceChildren(...nodes);
    if (keep) {
      journal.scrollTop = place;
      // No scroll event comes if the end did not move: where the reader stands decides.
      pin(gapBelow() <= FOLLOW_PX);
    }

    // Another session's journal comes in from the side; a subagent's, and the
    // way back from it, rise into place.
    if (entering && source !== shown) {
      if (session.id !== shownSession) {
        if (shownSession) replay(journal, "gh-from-right");
      } else {
        replay(journal, "sess-enter");
      }
      shown = source;
      shownSession = session.id;
    }
    // A reply just opened, or put back as it was, is read from its top: not from the journal's end.
    const revealed = reveal ? (reveal === ended?.of ? ended.el : entries.get(reveal as SessionStep)?.el) : null;
    reveal = null;
    if (toType) type(toType.lines, toType.kind);
    else if (revealed?.isConnected) {
      journal.scrollTop += revealed.getBoundingClientRect().top - journal.getBoundingClientRect().top - REVEAL_GAP;
      // Moved down, the scroll listener would not let go of the end: the panel's
      // next resize would take the reply from its top. Reaching the end by the
      // reader's own scroll pins again.
      if (gapBelow() > FOLLOW_PX) pin(false);
    } else if (following && typing == null) journal.scrollTo({ top: journal.scrollHeight, behavior: entering ? "auto" : "smooth" });
    if (!following && journal.scrollHeight > was) unread = true;
    if (keep) unread = held = true;
    placeJump();
    if (keep && !jump.hidden) wiggle(jump, jump);
  }

  // ── Above the journal ───────────────────────────────────────────────────────

  let topKey = "";

  /** The chips that keep one kind of step, each with how many of them the journal has. */
  function chips(steps: SessionStep[]): HTMLElement[] {
    const tools = steps.filter(isTool);
    return FILTERS.map(([id, label]) => {
      const count = id === "all" ? tools.length : tools.filter((s) => s.kind === (id as StepKind)).length;
      return h(
        "button",
        {
          class: filter === id ? "sess-f on" : "sess-f",
          "aria-pressed": String(filter === id),
          onclick: () => {
            actions.blip();
            filter = id;
            State.notify();
          },
        },
        label, h("b", { text: String(count) }),
      );
    });
  }

  function drawTop(session: ClaudeSession, agent: Subagent | null) {
    const steps = agent ? agent.steps : session.steps;
    const at = standing(session);
    const files = State.sessionFiles.length;
    const waits = session.question != null || session.approval != null;
    const next = [
      session.id, agent?.id, filter, FILTERS.map(([id]) => steps.filter((s) => isTool(s) && (id === "all" || s.kind === id)).length).join(","),
      agent
        ? [agent.type, subagentTask(agent), subagentStanding(session, agent), agent.endedAt, agent.timed, stepsApart(session, agent), folderOf(session), agent.model?.label].join(":")
        : [at.words, at.color, files, waits, session.target.kind, targetTip(session), session.model?.label].join(":"),
    ].join("~");
    if (next === topKey) return;
    topKey = next;
    clear(filters);
    clear(crumb);
    if (!agent) {
      // Where the session is at; while it waits for an answer, the way to its card.
      const state = chip(at.words, at.quiet ? COLOR.grey : at.color);
      if (at.quiet) state.title = QUIET_TIP;
      if (waits) {
        state.classList.add("opens");
        state.title = "Show what it asks";
        state.addEventListener("click", () => actions.showRequest());
      }
      filters.append(...chips(steps), h("div", { class: "grow" }), ...modelChip(session.model), state);
      if (files > 0) {
        filters.append(h("button", {
          class: "sess-files", title: "Every file this session changed", text: counted(files, "file"),
          onclick: () => {
            actions.blip();
            go({ kind: "list" });
          },
        }));
      }
      const target = goToSession();
      target.sync(session);
      filters.append(target.el);
      return;
    }
    const folder = folderOf(session);
    const back = () => {
      actions.blip();
      go({ kind: "live" });
    };
    crumb.append(
      h("button", { class: "sess-crumb-back", title: `Back to ${folder} (the main session)`, "aria-label": "Back to the main session", onclick: back }, svg(ICONS.chevronLeft, 11, { stroke: 2.8 })),
      h("button", { class: "sess-crumb-session", text: folder, title: `Back to ${folder} (the main session)`, onclick: back }),
      h("span", { class: "sess-crumb-sep", text: "›" }),
      h("span", { class: "sess-crumb-type", text: subagentKind(agent) }),
      ...(subagentTask(agent)
        ? [h("span", { class: "sess-crumb-dot", text: "·" }), h("b", { class: "sess-crumb-task", text: subagentTask(agent)!, title: subagentName(agent) })]
        : []),
      h("span", { class: "grow" }),
      ...modelChip(agent.model),
      MARKS[subagentStanding(session, agent)](),
      statusOf(session, agent),
    );
    // Its chips count its own steps, and nothing else's. With no agent ids there are none to count.
    if (stepsApart(session, agent)) filters.append(...chips(steps));
  }

  // ── Time that runs ──────────────────────────────────────────────────────────
  // "running 1m 23s" moves a second at a time, on a timer of its own that
  // writes the words and nothing else: it never wakes the island's frame loop.
  // It runs only while the panel is on show with something going in it, and
  // stops itself the moment either is no longer so.

  let clockTimer: number | null = null;

  function tick() {
    const seen = State.mode === "expanded" && State.view === "session";
    const going = seen ? el.querySelectorAll<HTMLElement>(".sess-elapsed") : null;
    for (const span of going ?? []) span.textContent = elapsed(Date.now() - Number(span.dataset.since));
    if (going && going.length > 0) return;
    if (clockTimer != null) window.clearInterval(clockTimer);
    clockTimer = null;
  }

  /** The session the panel was last drawn for. */
  let followed = "";
  /** How many held-back turn ends of each session the panel has shown. */
  const shownNudges = new WeakMap<ClaudeSession, number>();
  let key = "";
  let headKey = "";
  /** What the list last drew, to keep its scroll when it draws the same again. */
  let drawn = "";
  let wasLarge = false;

  return {
    el,
    // The panel has just come on show.
    arm: focusPanel,
    // Tab and Shift+Tab: the next session in the sidebar's order, round and
    // round, picked as a click on its line picks it. Subagents are passed
    // over, and a subagent's view is left for the next session's journal. No
    // line takes the focus, and none wears a ring for it.
    step(by) {
      const all = State.sessions;
      if (all.length < 2) return;
      const at = all.findIndex((s) => s.id === State.frontId);
      const next = all[(Math.max(0, at) + by + all.length) % all.length];
      pickSession(next.id);
      // The tree's tab stop follows, so that an arrow pressed next starts from there.
      focusKey = sessionKey(next.id);
    },
    sync() {
      const session = State.session;
      const files = State.sessionFiles;

      // Turns that ended since the last sync, while the panel was being read
      // (hooks.ts `hold`): each session's count is compared with what was shown.
      // A session met for the first time shows nothing for what came before.
      const nudged = State.sessions.filter((s) => s.nudges !== (shownNudges.get(s) ?? s.nudges));
      for (const s of State.sessions) shownNudges.set(s, s.nudges);
      holding = nudged.includes(session);

      // Another session came in front: whatever of the last one was open — a
      // file, a subagent — its journal.
      if (session.id !== followed) {
        // A finish still owed to the one left behind is not lost: its line keeps the mark.
        if (owed && owed !== session) owed.attention = true;
        owed = null;
        followed = session.id;
        if (!(screen.kind === "agent" && screen.session === session.id)) screen = { kind: "live" };
        filter = "all";
        stamp++;
      }
      // A subagent that is no longer among the session's gives way to the main journal.
      const agentId = screen.kind === "agent" ? screen.id : null;
      const agent = agentId ? (session.subagents.find((a) => a.id === agentId) ?? null) : null;
      if (agentId && !agent) screen = { kind: "live" };
      // A file opened and gone since (another session took over): the list.
      const openedFile = screen.kind === "file" ? screen.path : null;
      const picked = openedFile ? (files.find((f) => f.path === openedFile) ?? null) : null;
      if (openedFile && !picked) screen = { kind: "list" };
      const live = screen.kind === "live" || screen.kind === "agent";
      // A finish held back while the journal is not on show: signalled on the line now, on the button when the journal is back.
      if (holding && !live) owed = session;
      else if (live && owed === session) {
        holding = true;
        owed = null;
      }

      // The panel's size: what the large one shows more of is drawn from this.
      el.classList.toggle("large", State.large);
      if (State.large && !wasLarge) focusPanel();
      wasLarge = State.large;

      // The sidebar: whose session, by its folder and its conversation's title, and the tree.
      // "Claude Code · project" / "Cursor · project", with the tool's mark before it.
      const heading = session.id ? `${TOOL_NAME[session.agent]} · ${folderOf(session)}` : UNNAMED;
      name.replaceChildren(...(session.id ? [toolMark(session.agent, 12), heading] : [heading]));
      name.title = heading;
      drawToolChips();
      nameSub.textContent = nameSub.title = session.title ?? (session.id ? TOOL_NAME[session.agent] : "");
      nameModel.textContent = session.model?.label ?? "";
      nameModel.title = session.model?.id ?? "";
      nameModel.hidden = !session.model;
      // Before the sidebar is drawn: a reply read whole takes its mark off its line.
      if (live) settleReply(session, agent);
      drawRail(session);
      tree.classList.toggle("kbd", byKeyboard);
      // Another session's turn ended: its line shakes, if it is on show.
      for (const s of nudged) {
        const line = s === session && live ? null : rows().find((r) => r.dataset.key === sessionKey(s.id));
        if (line) wiggle(line, s);
      }

      journal.style.display = live ? "" : "none";
      list.style.display = live ? "none" : "";
      head.style.display = live ? "none" : "";
      headTarget.sync(session);
      crumb.style.display = agent ? "" : "none";
      filters.style.display = live && (!agent || stepsApart(session, agent)) ? "" : "none";
      main.classList.toggle("of-agent", agent != null);
      if (!live) stopTyping();

      if (live) {
        main.style.setProperty("--accent", "rgba(0,0,0,0)");
        headKey = "";
        drawTop(session, agent);
        syncJournal(session, agent);
        if (clockTimer == null && State.mode === "expanded" && el.querySelector(".sess-elapsed")) {
          clockTimer = window.setInterval(tick, 1000);
          tick();
        }
        return;
      }

      // The head: a file opened from the changes has its name on the tab, as in an editor.
      const path = picked?.path ?? null;
      const nextHead = [session.id, screen.kind, path, files.length, picked?.edits.length].join("~");
      if (nextHead !== headKey) {
        headKey = nextHead;
        clear(badge);
        clear(aside);
        sub.classList.toggle("path", path != null);
        who.classList.toggle("file", path != null);
        if (path) {
          who.textContent = splitPath(path).base;
          sub.textContent = path;
          badge.append(extBadge(path));
        } else {
          who.textContent = "Changes";
          sub.textContent = files.length > 0 ? counted(files.length, "file") : "";
          badge.append(dot(standing(session).color, 7));
        }
        if (picked) aside.append(statusWord(picked), plusMinus(picked.additions, picked.deletions));
        else if (files.length > 0) {
          aside.append(plusMinus(files.reduce((n, f) => n + f.additions, 0), files.reduce((n, f) => n + f.deletions, 0)));
        }
        main.style.setProperty("--accent", picked ? (picked.created ? COLOR.green : COLOR.amber) : "rgba(0,0,0,0)");
      }

      // Rebuilding the rows between a mouse-down and its mouse-up would swallow
      // the click, so only rebuild when something they show has changed.
      const total = files.reduce((n, f) => n + f.edits.length, 0);
      const next = [session.id, stamp, screen.kind, total, files[0]?.path].join("~");
      if (next === key) return;
      key = next;

      const now = `${screen.kind}:${picked?.path ?? ""}`;
      const scroll = now === drawn ? list.scrollTop : 0;
      drawn = now;
      clear(list);
      list.classList.toggle("gh-edge", picked != null);
      if (picked) list.append(diffView(picked, fileKind(picked.path)));
      else if (files.length === 0) list.append(h("div", { class: "int-empty", text: "Nothing written in this session yet." }));
      else for (const f of files) list.append(fileRow(f));
      list.scrollTop = scroll;
    },
  };
}
