// Who is on the island, and in what order: the rules the home view's mini bots
// and the folded island's dots are both read by (plans/design-plan.md §1–2,
// plans/subagents-plan.md §7). No DOM here: a session goes in, and what it
// shows as comes out — its state, its lane, its colour, its words.

import { botGlowColor, type BotStateName } from "../core/layout";
import {
  DECISION_WORDS, QUIET_WORDS, State, TURN_DONE, isQuiet, subagentAsks, subagentName, turnSteps,
  type AgentTask, type ClaudeSession, type Subagent,
} from "../core/state";
import { COLOR } from "./palette";
import { stepName } from "./step";

// ── The rules, as constants ───────────────────────────────────────────────────

/** A session at rest leaves the home view, and the folded island, after this long (design-plan §7, decision 4). */
export const FADE_AFTER_MS = 5 * 60_000;
/** …unless nobody has looked at its result: then it stays this long. */
export const UNSEEN_KEEP_MS = 30 * 60_000;
/** Child dots under a mini bot before "+N". */
export const MAX_CHILD_DOTS = 4;

/** Needs you (asks, then errors) · Working · Done (at rest, on its own side). */
export type Lane = "needs" | "working" | "done";

/** Something with a place on the island: a Claude Code session, or another agent's pill. */
export interface Entry {
  id: string;
  /** The session; null for another agent's pill. */
  session: ClaudeSession | null;
  /** Another agent's pill (`nook_agent`); null for a session. */
  task: AgentTask | null;
  /** What it shows as. */
  state: BotStateName;
  lane: Lane;
  /** Lower is more urgent: asks, errors, work, replies that wait on a decision, results unseen, the rest. */
  rank: number;
  /** Since when it has stood where it stands: in a lane, the one that has waited longest comes first. */
  since: number;
  color: string;
  /** Its turn is over and nobody has looked at what came of it. */
  unseen: boolean;
  /** Its last reply waits on a decision (an `[!IMPORTANT]` alert) and has not been read whole. */
  decision: boolean;
}

// ── How a session reads ───────────────────────────────────────────────────────

/** What a session shows as: a request waiting says so, whatever else goes on. */
export function shownState(session: ClaudeSession): BotStateName {
  if (session.question) return "question";
  if (session.approval) return "approval";
  return session.state;
}

function laneOf(state: BotStateName): Lane {
  switch (state) {
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

/** Where a reply that waits on a decision stands: after everything at work, before a result that is only unseen. */
const DECISION_RANK = 2.5;

function rankOf(state: BotStateName, unseen: boolean, decision: boolean): number {
  switch (state) {
    case "approval":
    case "question":
      return 0;
    case "error":
      return 1;
    case "finished":
    case "idle":
    case "sleeping":
      return decision ? DECISION_RANK : unseen ? 3 : 4;
    default:
      return 2;
  }
}

function colorOf(state: BotStateName, lane: Lane, unseen: boolean, decision: boolean): string {
  // A request or an error keeps its own colour: only a session at rest wears the decision's.
  if (lane === "done") return decision ? COLOR.purple : unseen ? COLOR.green : COLOR.grey;
  return botGlowColor(state);
}

/** When each was first seen in the lane it is in: nothing else says since when a session has been at work. */
const stood = new WeakMap<object, { lane: Lane; at: number }>();

function standingSince(key: object, lane: Lane): number {
  const was = stood.get(key);
  if (was?.lane === lane) return was.at;
  const at = Date.now();
  stood.set(key, { lane, at });
  return at;
}

function sessionEntry(session: ClaudeSession): Entry {
  const state = shownState(session);
  const lane = laneOf(state);
  const unseen = lane === "done" && session.unseen;
  const entered = standingSince(session, lane);
  // A request says when it was asked, a turn when it ended: those are exact.
  const asked = (session.approval ?? session.question)?.askedAt;
  const since = lane === "needs" ? (asked ?? entered) : lane === "done" ? session.restedAt || session.heardAt || entered : entered;
  const decision = session.decision;
  return { id: session.id, session, task: null, state, lane, rank: rankOf(state, unseen, decision), since, color: colorOf(state, lane, unseen, decision), unseen, decision };
}

function agentEntry(task: AgentTask): Entry {
  const lane = laneOf(task.state);
  return {
    id: task.id, session: null, task, state: task.state, lane, rank: rankOf(task.state, false, false),
    since: standingSince(task, lane), color: colorOf(task.state, lane, false, false), unseen: false, decision: false,
  };
}

/**
 * Gone from the home view and from the folded island: at rest for five minutes
 * — thirty when its result was never looked at, and not at all while its last
 * reply waits on a decision nobody has read. It is still followed, until
 * Claude Code says the session is over, and is back the moment it works again:
 * nothing here is remembered, it is read from the session each time.
 */
export function hasFaded(entry: Entry, now = Date.now()): boolean {
  if (!entry.session || entry.lane !== "done" || entry.decision) return false;
  return now - entry.since >= (entry.unseen ? UNSEEN_KEEP_MS : FADE_AFTER_MS);
}

/** Most urgent first; in a group, the one that has waited longest first. */
const byUrgency = (a: Entry, b: Entry) => a.rank - b.rank || a.since - b.since;

export interface Roster {
  /** On show, most urgent first. */
  live: Entry[];
  /** Sessions followed that have faded. */
  faded: number;
}

/** Everything with a place on the island now: the sessions, then the other agents' pills. */
export function roster(now = Date.now()): Roster {
  const sessions = State.sessions.map(sessionEntry);
  const agents = State.tasks.filter((t) => t.source === "agent").map(agentEntry);
  const live = [...sessions.filter((e) => !hasFaded(e, now)), ...agents].sort(byUrgency);
  return { live, faded: sessions.length + agents.length - live.length };
}

/** The state the island's own bot wears where it speaks for them all: the most urgent one's. */
export function overallState(live: Entry[]): BotStateName {
  return live[0]?.state ?? (State.settings.hooksInstalled ? "idle" : "sleeping");
}

/**
 * At work, or asking: what "hide only when no session is active" waits for
 * (Settings → Island). One at rest — finished, idle, stopped on an error —
 * is not active.
 */
export const isActive = (entry: Entry) => entry.lane === "working" || entry.state === "approval" || entry.state === "question";

/** Sessions waiting for the user: a permission, or an answer. */
export const waitingCount = () => State.sessions.filter((s) => s.approval != null || s.question != null).length;

// ── Names and words ───────────────────────────────────────────────────────────

const sameFolder = (a: ClaudeSession, b: ClaudeSession) =>
  a.cwd && b.cwd ? a.cwd.toLowerCase() === b.cwd.toLowerCase() : a.project === b.project;

/** The folder's name; two sessions in one folder are told apart by "·1", "·2". */
export function labelOf(entry: Entry): { name: string; n: number | null; path: string } {
  const session = entry.session;
  if (!session) return { name: entry.task?.name ?? "", n: null, path: "" };
  const twins = State.sessions.filter((s) => sameFolder(s, session));
  return { name: session.project, n: twins.length > 1 ? twins.indexOf(session) + 1 : null, path: session.cwd ?? "" };
}

export function labelText(entry: Entry): string {
  const { name, n } = labelOf(entry);
  return n == null ? name : `${name} ·${n}`;
}

const WORDS: Record<BotStateName, string> = {
  idle: "at rest", working: "working", thinking: "thinking", searching: "searching",
  approval: "needs permission", question: "is asking you", error: "stopped on an error",
  finished: "finished", ratelimit: "rate limited", sleeping: "asleep", dizzy: "dizzy",
};

export function stateWords(entry: Entry): string {
  const session = entry.session;
  // Its last reply waits on a decision: said of one at rest — a request or an error is said first.
  if (session?.decision && entry.lane === "done") return DECISION_WORDS.toLowerCase();
  // A turn that ended is "finished" for as long as it is on show, not only while the bot hops.
  if (session && entry.lane === "done" && session.restedAt > 0) return WORDS.finished;
  if (session && entry.lane === "working" && isQuiet(session)) return QUIET_WORDS.toLowerCase();
  return WORDS[entry.state];
}

/** The subagents of a session that are at work, the one asking first: it is never the one folded into "+N". */
export function runningSubagents(session: ClaudeSession): { agent: Subagent; asking: boolean }[] {
  return session.subagents
    .filter((a) => a.state === "running")
    .map((agent) => ({ agent, asking: subagentAsks(session, agent) }))
    .sort((a, b) => Number(b.asking) - Number(a.asking));
}

export const subagentColor = (asking: boolean) => botGlowColor(asking ? "approval" : "working");

/** "2 subagents running", or nothing. */
export function subagentWords(session: ClaudeSession): string {
  const going = session.subagents.filter((a) => a.state === "running").length;
  return going ? `${going} subagent${going === 1 ? "" : "s"} running` : "";
}

const oneLine = (text: string | null | undefined) => text?.split("\n").find((line) => line.trim())?.trim() ?? "";

/** A reply's first line as plain words: what marks it as bold, a heading or code goes. */
const plain = (text: string | null) => oneLine(text).replace(/^#{1,6}\s+|\*\*|`/g, "");

/** What something on the island is doing, in one line. */
export function doingOf(entry: Entry): string {
  const session = entry.session;
  if (!session) return entry.task?.steps.at(-1) ?? "No activity yet";

  const request = session.approval ?? session.question;
  if (request) {
    const agent = request.agentId ? session.subagents.find((a) => a.id === request.agentId) : null;
    const what = session.question ? oneLine(session.question.questions[0]?.question) || "a question" : oneLine(session.approval?.command);
    if (agent) {
      const kind = agent.type ? `${agent.type} subagent` : "subagent";
      return `${subagentName(agent)} (${kind}) ${session.question ? "asks" : "needs permission"} · ${what}`;
    }
    return session.question ? `Asks · ${what}` : what;
  }
  if (session.state === "error") return "The session stopped on an error";

  const steps = turnSteps(session);
  const last = steps.at(-1) ?? null;
  const ended = [...session.steps].reverse().find((step) => step.kind !== "note")?.tool === TURN_DONE;
  if (ended || session.state === "finished") {
    const said = plain(session.answer);
    if (said) return `Done · ${said}`;
    const files = State.changes.get(session.id)?.length ?? 0;
    return files ? `Done · ${files} file${files === 1 ? "" : "s"} changed` : "Done";
  }
  const going = subagentWords(session);
  if (going && last?.state !== "running") return session.parked ? `Main turn stopped · ${going}` : `Agent · ${going}`;
  if (last) return last.target ? `${stepName(last)} · ${oneLine(last.target)}` : stepName(last);
  if (session.state === "thinking") return session.asked ? `Thinking · ${oneLine(session.asked)}` : "Thinking";
  return "Open · waiting for a prompt";
}

// ── Spans of time ─────────────────────────────────────────────────────────────

const MIN = 60_000;

/** "3 min", "1 h 05 min": how long something has been as it is. */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MIN));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** "2h 14m", "3d 4h": until a limit's window starts again. */
export function until(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MIN));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
