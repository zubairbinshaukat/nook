// The agents list's rows, and what the island's page hands the list: one row
// per project, worked out here from the sessions, in plain functions that know
// nothing of the page. The island's page builds a snapshot (`snapshotOf`) and
// sends it; the list's page only draws it and keeps the clock (`shownStatus`).
// This file is the one place the snapshot's shape is written down.

import { contextUse, type ContextLevel } from "../core/context";
import type { Usage } from "../core/state";

/** How a project stands, the one thing to show first: waiting for the user, at work, just done, or at rest. */
export type AgentStatus = "wait" | "work" | "done" | "idle";

/** Waiting comes first, then work, then what has just finished, then what rests. */
const ORDER: Record<AgentStatus, number> = { wait: 0, work: 1, done: 2, idle: 3 };

/** A turn that ended this long ago still reads DONE; after it, IDLE. */
export const DONE_MS = 10 * 60_000;
/** The last words kept for a row: one line, cut by the list's own ellipsis long before this. */
const MESSAGE_CHARS = 200;

/** What the list needs of a session: the front end's `ClaudeSession` is one. */
export interface AgentSource {
  id: string;
  agent: AgentTool;
  project: string;
  cwd: string | null;
  state: string;
  approval: { askedAt?: number } | null;
  question: { askedAt?: number } | null;
  heardAt: number;
  restedAt: number;
  answer: string | null;
  lines: string[];
  steps: { kind: string; at: number }[];
  contextTokens: number | null;
  contextWindow: number | null;
  model: { id: string } | null;
}

/** The tools a session can belong to, in the order a row lists them: Claude Code first. */
export type AgentTool = "claude" | "cursor" | "codex";
const TOOLS: readonly AgentTool[] = ["claude", "cursor", "codex"];

/** One project: its main sessions, as one line of the list. */
export interface AgentRow {
  /** The folder it is told apart by; the list keeps a row per key. */
  key: string;
  /** The folder's name. */
  project: string;
  /** How many main sessions are open in it (never subagents). */
  count: number;
  /** Which tools have a session open in it, each once, Claude Code first. */
  agents: AgentTool[];
  status: AgentStatus;
  /** When that status began, Unix ms; 0 when it is not known. */
  since: number;
  /** For DONE: when it turns IDLE by itself (Unix ms). */
  doneUntil: number | null;
  /** The context of the session a click goes to, in tokens; null when none has been counted. */
  tokens: number | null;
  percent: number | null;
  level: ContextLevel | null;
  /** What that session said last, on one line. */
  message: string | null;
  /** The session a click goes to: the one that needs the user, else the latest heard. */
  sessionId: string;
}

/** What the island sends the list. */
export interface AgentsSnapshot {
  rows: AgentRow[];
  usage: Usage | null;
}

const WORKING: ReadonlySet<string> = new Set(["working", "thinking", "searching"]);
const NEEDS_YOU: ReadonlySet<string> = new Set(["approval", "question", "error", "ratelimit"]);

interface Standing {
  status: AgentStatus;
  since: number;
  doneUntil: number | null;
}

/** When the turn under way began: the last thing the user asked, or — its start gone from the journal — the oldest line left. */
function turnStart(session: AgentSource): number {
  const asked = session.steps.map((step) => step.kind).lastIndexOf("prompt");
  return session.steps[asked >= 0 ? asked : 0]?.at ?? session.heardAt;
}

/** Where one session stands: a request or an error is waiting for the user, a turn is under way, a turn just ended, or it rests. */
function standing(session: AgentSource, now: number): Standing {
  const asked = session.approval ?? session.question;
  if (asked || NEEDS_YOU.has(session.state)) return { status: "wait", since: asked?.askedAt ?? session.heardAt, doneUntil: null };
  if (WORKING.has(session.state)) return { status: "work", since: turnStart(session), doneUntil: null };
  const ended = session.restedAt > 0 ? session.restedAt : session.state === "finished" ? session.heardAt : 0;
  if (ended > 0 && now < ended + DONE_MS) return { status: "done", since: ended, doneUntil: ended + DONE_MS };
  return { status: "idle", since: ended > 0 ? ended : session.heardAt, doneUntil: null };
}

/** The folder a session works in, as the one key of its project: case and slashes do not tell two apart. */
function keyOf(session: AgentSource): string {
  const cwd = session.cwd?.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return cwd ? `dir:${cwd}` : `name:${session.project.toLowerCase()}`;
}

/** What a session said last, on one line. */
function lastWords(session: AgentSource): string | null {
  const said = session.answer ?? session.lines[session.lines.length - 1] ?? "";
  const line = said.replace(/\s+/g, " ").trim();
  return line ? line.slice(0, MESSAGE_CHARS) : null;
}

function rowOf(key: string, sessions: AgentSource[], now: number): AgentRow {
  const stands = sessions.map((session) => ({ session, ...standing(session, now) }));
  const pick = (status: AgentStatus) => stands.filter((s) => s.status === status);
  const status = (["wait", "work", "done", "idle"] as const).find((s) => pick(s).length > 0)!;
  const same = pick(status);
  // Waiting and working: how long the longest has been; done and idle: how long ago the latest was.
  const since = status === "wait" || status === "work" ? Math.min(...same.map((s) => s.since)) : Math.max(...same.map((s) => s.since));
  // The one a click goes to: the one that has waited longest for the user, else the one heard from last.
  const waiting = pick("wait").sort((a, b) => a.since - b.since)[0];
  const latest = [...stands].sort((a, b) => b.session.heardAt - a.session.heardAt)[0];
  const best = (waiting ?? latest).session;
  const use = contextUse(best.contextTokens, best.contextWindow, best.model?.id);
  return {
    key,
    project: sessions[0].project,
    count: sessions.length,
    agents: TOOLS.filter((tool) => sessions.some((session) => session.agent === tool)),
    status,
    since,
    doneUntil: status === "done" ? Math.max(...same.map((s) => s.doneUntil ?? 0)) : null,
    tokens: use ? best.contextTokens : null,
    percent: use?.percent ?? null,
    level: use?.level ?? null,
    message: lastWords(best),
    sessionId: best.id,
  };
}

/** The rows, in an order that stays put: waiting, work, done, idle; then by name. */
export function buildRows(sessions: readonly AgentSource[], now: number): AgentRow[] {
  const groups = new Map<string, AgentSource[]>();
  for (const session of sessions) {
    const key = keyOf(session);
    const group = groups.get(key);
    if (group) group.push(session);
    else groups.set(key, [session]);
  }
  return [...groups].map(([key, group]) => rowOf(key, group, now)).sort(compareRows);
}

export function compareRows(a: AgentRow, b: AgentRow): number {
  return ORDER[a.status] - ORDER[b.status] || a.project.toLowerCase().localeCompare(b.project.toLowerCase()) || a.key.localeCompare(b.key);
}

/** What the island sends: the rows, and the usage limits for the list's two pills. */
export function snapshotOf(sessions: readonly AgentSource[], usage: Usage | null, now: number): AgentsSnapshot {
  return { rows: buildRows(sessions, now), usage };
}

/** The status a row shows at `now`: a DONE whose time has run out is IDLE, with nobody having to say so. */
export function shownStatus(row: Pick<AgentRow, "status" | "doneUntil">, now: number): AgentStatus {
  return row.status === "done" && row.doneUntil != null && now >= row.doneUntil ? "idle" : row.status;
}

/** "00:14", "04:34", "1:02:03": how long a status has lasted. Empty when it is not known. */
export function formatElapsed(since: number, now: number): string {
  if (!(since > 0)) return "";
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** "950", "182k", "1.2M": a context's size in tokens. Empty for none. */
export function formatTokens(tokens: number | null): string {
  if (tokens == null || !Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 999_500) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(Math.round(tokens));
}

/** A row's snapshot as the list reads it: anything that is not one is not drawn. */
export function readSnapshot(value: unknown): AgentsSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const { rows, usage } = value as { rows?: unknown; usage?: unknown };
  if (!Array.isArray(rows)) return null;
  const known = rows.filter((row): row is AgentRow =>
    !!row && typeof row.key === "string" && typeof row.project === "string" && typeof row.sessionId === "string"
    && typeof row.count === "number" && typeof row.since === "number" && row.status in ORDER);
  // A row from an island that does not say which tools is still drawn, without marks; an unknown tool is not drawn.
  const read = known.map((row) => ({ ...row, agents: Array.isArray(row.agents) ? TOOLS.filter((tool) => row.agents.includes(tool)) : [] }));
  return { rows: read, usage: (usage ?? null) as Usage | null };
}
