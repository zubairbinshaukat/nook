// Preview only: made-up Claude Code sessions, and the rules the planned home
// view and compact island read them by (plans/design-plan.md §1–2,
// plans/subagents-plan.md §7). Nothing here is used by the app.

import { botGlowColor, type BotStateName } from "../../src/core/layout";
import { COLOR } from "../../src/views/palette";

// ── The rules, as constants ───────────────────────────────────────────────────

/** A finished session leaves the home view after this long (decision 4). */
export const FADE_AFTER_MS = 5 * 60_000;
/** …unless nobody has opened its result: then it stays this long. */
export const UNSEEN_KEEP_MS = 30 * 60_000;
/** Sessions on show before the rest fold into "+N". */
export const MAX_VISIBLE = 6;
/** Child dots under a mini bot before "+N". */
export const MAX_CHILD_DOTS = 4;
/** Usage older than this dims. */
export const USAGE_STALE_MS = 10 * 60_000;

// ── A clock that can be pushed forward ────────────────────────────────────────

export const clock = {
  skew: 0,
  now: () => Date.now() + clock.skew,
};

const MIN = 60_000;
const ago = (minutes: number) => clock.now() - minutes * MIN;

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface FakeSubagent {
  id: string;
  type: string;
  description: string;
  running: boolean;
  /** It is the one a permission request came from. */
  asking: boolean;
}

export interface FakeSession {
  id: string;
  cwd: string;
  /** What the main turn last said it was: `finished` after a `Stop`. */
  state: BotStateName;
  /** One line of what it is doing. */
  doing: string;
  /** When it entered this state, on the preview's clock. */
  since: number;
  /** A finished session's result has been opened. */
  seen: boolean;
  subagents: FakeSubagent[];
}

let nextId = 1;
const session = (
  cwd: string, state: BotStateName, doing: string, minutes: number, seen = false,
): FakeSession => ({ id: `s${nextId++}`, cwd, state, doing, since: ago(minutes), seen, subagents: [] });

const NOOK = "D:/work/personal/nook";

const eight = (): FakeSession[] => [
  session(NOOK, "working", "Shell · cargo test --workspace", 2),
  session("D:/work/acme/api", "approval", "Bash · rm -rf dist && npm run build", 4),
  session("D:/work/acme/web", "finished", "Done · 3 files changed", 1),
  session(NOOK, "thinking", "Thinking about the relay's statusline mode", 6),
  session("D:/work/docs-site", "question", "Asks · Which sidebar layout?", 9),
  session("D:/work/ml-pipeline", "error", "Failed · pytest tests/test_loader.py", 3),
  session("D:/work/infra", "finished", "Done · terraform plan is clean", 3, true),
  session("D:/work/mobile-app", "working", "Edit · src/screens/Checkout.tsx", 1),
];

/** 0, 1, 4 or 8 sessions: the first n of the same eight. */
export function fakeSessions(n: number): FakeSession[] {
  return eight().slice(0, n);
}

export function allNeedAttention(): FakeSession[] {
  return eight().map((s, i) => ({
    ...s,
    state: i % 3 === 2 ? "question" : "approval",
    doing: i % 3 === 2 ? "Asks · Keep the old migration?" : `Bash · ${["git push --force", "npm publish", "rm -rf build", "docker system prune"][i % 4]}`,
    since: ago(12 - i),
  }));
}

export function longNameSession(): FakeSession {
  return session(
    "D:/work/client-with-an-unreasonably-long-repository-name-2026-rewrite",
    "working", "Read · packages/core/src/index.ts", 0,
  );
}

/** Nine for the compact island: six on show, three behind "+3". */
export function nineSessions(): FakeSession[] {
  return [...eight(), session("D:/work/scraper", "finished", "Done · 1 file changed", 2, true)];
}

const sub = (description: string, asking = false): FakeSubagent => ({
  id: `a${nextId++}`, type: "general-purpose", description, running: true, asking,
});

export type SubagentScenario = "two" | "asking" | "stopped" | "six";

/** Puts a subagent scenario of plans/subagents-plan.md §9 on a session. */
export function applySubagents(s: FakeSession, scenario: SubagentScenario) {
  s.since = clock.now();
  s.seen = false;
  switch (scenario) {
    case "two":
      s.state = "working";
      s.doing = "Agent · 2 subagents launched";
      s.subagents = [sub("Count files"), sub("Write a note")];
      break;
    case "asking":
      // The request is the session's: it needs you, and the dot says which subagent.
      s.state = "approval";
      // It has waited longest: the front session, so the bot's card names the subagent.
      s.since = ago(15);
      s.doing ="Write a note (general-purpose subagent) needs permission · Write sub-b.txt";
      s.subagents = [sub("Count files"), sub("Write a note", true)];
      break;
    case "stopped":
      // `Stop` arrived with background_tasks still running.
      s.state = "finished";
      s.doing = "Main turn stopped · waiting for its subagents";
      s.subagents = [sub("Count files"), sub("Write a note")];
      break;
    case "six":
      s.state = "working";
      s.doing = "Agent · 6 subagents launched";
      s.subagents = ["Map hooks", "Read relay", "Scan views", "List tests", "Check docs", "Audit CSS"].map((d) => sub(d));
      break;
  }
}

// ── How a session reads ───────────────────────────────────────────────────────

export const runningSubagents = (s: FakeSession) => s.subagents.filter((a) => a.running);

/** What the session shows as: a main turn that stopped with subagents running is still working. */
export function shownState(s: FakeSession): BotStateName {
  if (s.state === "finished" && runningSubagents(s).length > 0) return "working";
  return s.state;
}

export type Lane = "needs" | "working" | "done";

export function laneOf(s: FakeSession): Lane {
  switch (shownState(s)) {
    case "approval":
    case "question":
    case "error":
      return "needs";
    case "finished":
    case "idle":
    case "sleeping":
      return "done";
    default:
      return "working";
  }
}

/** Lower is more urgent: asks, then errors, then work, then results unseen, then the rest. */
export function rank(s: FakeSession): number {
  switch (shownState(s)) {
    case "approval":
    case "question":
      return 0;
    case "error":
      return 1;
    case "finished":
      return s.seen ? 4 : 3;
    case "idle":
    case "sleeping":
      return 4;
    default:
      return 2;
  }
}

/** Most urgent first; in a group, the one that has waited longest first. */
export function byUrgency(sessions: FakeSession[]): FakeSession[] {
  return [...sessions].sort((a, b) => rank(a) - rank(b) || a.since - b.since);
}

export const isResting = (s: FakeSession) => laneOf(s) === "done";

/** Gone from the home view (still tracked: it comes back the moment it works again). */
export function hasFaded(s: FakeSession): boolean {
  if (shownState(s) !== "finished") return false;
  const age = clock.now() - s.since;
  return s.seen ? age >= FADE_AFTER_MS : age >= UNSEEN_KEEP_MS;
}

/** The colour a session is drawn in: its state's, grey once it rests. */
export function colorOf(s: FakeSession): string {
  const state = shownState(s);
  if (state === "finished") return s.seen ? COLOR.grey : COLOR.green;
  if (state === "idle" || state === "sleeping") return COLOR.grey;
  return botGlowColor(state);
}

export function subagentColor(a: FakeSubagent): string {
  return botGlowColor(a.asking ? "approval" : "working");
}

const WORDS: Record<BotStateName, string> = {
  idle: "at rest", working: "working", thinking: "thinking", searching: "searching",
  approval: "needs permission", question: "is asking you", error: "stopped on an error",
  finished: "finished", ratelimit: "rate limited", sleeping: "asleep", dizzy: "dizzy",
};

export const stateWords = (s: FakeSession) => WORDS[shownState(s)];

export const folderOf = (s: FakeSession) => s.cwd.split("/").pop() ?? s.cwd;

/** The folder's name; two sessions in one folder are told apart by "·1", "·2". */
export function labelOf(s: FakeSession, all: FakeSession[]): { name: string; n: number | null } {
  const twins = all.filter((x) => x.cwd === s.cwd);
  return { name: folderOf(s), n: twins.length > 1 ? twins.indexOf(s) + 1 : null };
}

export function labelText(s: FakeSession, all: FakeSession[]): string {
  const { name, n } = labelOf(s, all);
  return n == null ? name : `${name} ·${n}`;
}

/** "3 min", "1 h 05 min": how long a session has been in its state. */
export function waited(s: FakeSession): string {
  return span(clock.now() - s.since);
}

export function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MIN));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

// ── Claude usage ──────────────────────────────────────────────────────────────

export interface FakeUsage {
  fiveHour: { used: number; resetsAt: number };
  sevenDay: { used: number; resetsAt: number };
  updatedAt: number;
}

export function fakeUsage(minutesOld: number): FakeUsage {
  return {
    fiveHour: { used: 38, resetsAt: clock.now() + 134 * MIN },
    sevenDay: { used: 12, resetsAt: clock.now() + (3 * 24 + 4) * 60 * MIN },
    updatedAt: ago(minutesOld),
  };
}

/** Why usage has never arrived: the three reasons of design-plan §1. */
export const NO_USAGE_REASONS = [
  "The usage relay is not installed. Install it in Settings.",
  "No Claude Code session has run since it was installed.",
  "This plan has no usage limits to report.",
] as const;
