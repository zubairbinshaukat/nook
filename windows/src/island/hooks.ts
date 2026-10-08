// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// client — the Claude desktop app, VS Code, Windows Terminal, PowerShell… — and
// all of them are handled.
//
// Windows goes a step further than the Swift app on two things, both read from
// what the hooks already carry: what Claude is doing — each file it changes,
// what it said to end its turn (the session panel) — and the questions it asks
// with its question tool, answered on the island.

import { Bridge, onEvent } from "../core/bridge";
import { Reader } from "../core/reading";
import { Sound } from "../core/sound";
import {
  CLAUDE_ID, QUESTION_TOOL, SESSION_UNNAMED, State, TURN_DONE, isQuestion, newSession, newStep, nextRequest, readModel, readTarget, requestsOf, taskStart,
  type ChangedFile, type ClaudeSession, type Question, type SessionRequest, type SessionStep,
  type StepKind, type StepResult, type Subagent,
} from "../core/state";
import type { IslandViewName } from "../core/layout";
import { needsDecision } from "../views/markdown";
import { rememberProject } from "../widgets/projects";
import type { Island } from "./island";

/**
 * By request: clears it if no decision was made before the hook gave up. Nook
 * answers within 108 s or not at all; after that the terminal has taken over
 * and the card would be lying. Each request has its own connection to the
 * relay and its own 108 s: one that waits behind another's card is timed from
 * the moment it came, like the one on the card.
 */
const pendingTimeouts = new Map<string, number>();
const PENDING_MS = 110_000;

export interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  nook_agent?: string;
  /** "cursor" or "codex" on an event of that tool's (nook-hook --agent cursor, --agent codex); absent for Claude Code. */
  nook_tool?: string;
  /** CLAUDE_CODE_ENTRYPOINT and TERM_PROGRAM, added by nook-hook. */
  entrypoint?: string;
  term_program?: string;
  /**
   * Where the session runs, and so where its ↗ goes — added by Nook itself
   * (src-tauri/src/target.rs) from what nook-hook reports, in the place of the
   * processes the relay named. Read with `readTarget`.
   */
  target?: unknown;
  /** What an edit tool did to its file — added by nook-hook to PostToolUse. */
  change?: { patch: string; additions: number; deletions: number; truncated: boolean; created: boolean };
  /** A few lines of what a tool gave back — added by nook-hook to PostToolUse. */
  result?: StepResult;
  /** On a PostToolUseFailure: what went wrong. */
  error?: string;
  /** What was picked for each question of Claude's question tool — added by nook-hook to PostToolUse. */
  answers?: Record<string, string>;
  /** On a PermissionRequest: what it asks was too long for nook-hook to send whole. */
  target_truncated?: boolean;
  /** What an edit asking for permission would do — added by nook-hook to PermissionRequest. */
  proposal?: { patch: string; additions: number; deletions: number; truncated: boolean; created: boolean };
  /** The conversation's title, read by nook-hook from the session's transcript. */
  session_title?: string;
  /** Tokens the session's last answer was given to read, counted by nook-hook in the transcript; only on the events that read it. */
  context_tokens?: number;
  /** On a Stop: what Claude said to end its turn. On a SubagentStop: what the subagent said last. */
  last_message?: string;
  /**
   * The subagent an event comes from: on SubagentStart and SubagentStop, and on
   * every tool event fired from inside one, a permission request included.
   * Events of the session itself have neither. Older versions of Claude Code
   * have them on none.
   */
  agent_id?: string;
  agent_type?: string;
  /** On the PostToolUse of an `Agent` call: the id of the subagent it launched — lifted by nook-hook from the tool's response. */
  launched_agent?: string;
  /** With `launched_agent`: the subagent went on in the background. Without it, the call waited for it, and it has come back. */
  launched_async?: boolean;
  /** On a Stop and a SubagentStop: what still runs in the background, the subagents among it. */
  background_tasks?: unknown;
  /**
   * The model the session runs on, where an event says it (SessionStart does):
   * its id, or `{ id, display_name }`. Read with `readModel`.
   */
  model?: unknown;
  /** With `launched_agent`: the model the subagent it launched runs on, by its id. */
  launched_model?: unknown;
}

/** The model a session runs on, as the status line's relay says it for that session (the `session_model` event). */
interface SessionModelPayload {
  sessionId?: string;
  model?: unknown;
  /** The size of its context window in tokens, when the status line said it. */
  contextWindow?: number | null;
}

/**
 * Sessions followed at once. The home view shows six of them and folds the
 * rest into "+N"; past this many, one at rest gives its place (`makeRoom`).
 */
const MAX_SESSIONS = 12;
/** Files kept for a session, and edits kept for a file. */
const MAX_FILES = 40;
const MAX_EDITS = 12;
/**
 * Lines kept of a session's journal. It empties as it fills: past that, the
 * oldest line goes for each new one, so a session that runs all day costs no
 * more than one that just started.
 */
const MAX_STEPS = 80;
/** Lines kept of what a session did; past that the older half goes. */
const MAX_LINES = 200;
/** Such a line is this long at most. */
const LINE_CHARS = 60;
/** How long a session that just finished says so before it goes back to rest. */
const FINISHED_MS = 5_200;
/** The id of a session whose hooks carry none. */
const ANONYMOUS = "session";
/** Subagents kept for a session; past that, the oldest that has stopped goes. */
const MAX_SUBAGENTS = 24;
/** Requests that wait behind the one on a session's card; one more goes back to the terminal. */
const MAX_QUEUED = 6;
/** The tool that launches a subagent, by its name today and the one older versions gave it. */
const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
/** What Claude said when its own turn stopped with subagents still at work, in the place of a tool's name. */
const TURN_PARKED = "Waiting";

/** What each tool does, as far as showing it goes; one not listed is "other". */
const STEP_KINDS: Record<string, StepKind> = {
  Read: "read", NotebookRead: "read",
  Edit: "edit", Write: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Bash: "command", PowerShell: "command",
  Grep: "search", Glob: "search", WebSearch: "search", ToolSearch: "search",
};

/** The fields of a tool's input that say what it is at, the most telling first. */
const TARGET_FIELDS = ["command", "file_path", "notebook_path", "path", "pattern", "query", "url", "description"] as const;
const PATH_FIELDS: ReadonlySet<string> = new Set(["file_path", "notebook_path", "path"]);

/** What a tool is at: its file by its path in the session's folder, its command, what it looks for. */
function stepTarget(input: Record<string, unknown>, cwd: string): string | null {
  for (const field of TARGET_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return PATH_FIELDS.has(field) ? sessionPath(value, cwd) : value.trim();
  }
  return null;
}

/** One more line in a journal: the session's, or a subagent's own. */
function log(journal: SessionStep[], step: SessionStep) {
  journal.push(step);
  if (journal.length > MAX_STEPS) journal.shift();
  return step;
}

/** The step of a tool still going, the last one started. */
function goingStep(journal: SessionStep[], tool: string) {
  return [...journal].reverse().find((s) => s.tool === tool && s.state === "running") ?? null;
}

/** A tool starts: one more step, going. */
function startStep(journal: SessionStep[], tool: string, input: Record<string, unknown>, cwd: string) {
  const step = log(journal, newStep(tool, STEP_KINDS[tool] ?? "other", stepTarget(input, cwd)));
  if (tool === QUESTION_TOOL) step.questions = questionsOf(input);
  return step;
}

/** A tool ends: its last step still going takes the outcome, and what the tool gave back. */
function endStep(journal: SessionStep[], payload: HookPayload, state: "done" | "failed") {
  const step = goingStep(journal, payload.tool_name ?? "Tool");
  if (!step) return null;
  step.state = state;
  step.at = Date.now();
  step.patch = payload.change?.patch ?? null;
  step.result = payload.result ?? (payload.error ? { text: payload.error, start: null, truncated: false, tail: false } : null);
  if (payload.answers) step.answers = payload.answers;
  // It ran, so whoever was asked said yes — here or in Claude Code.
  if (step.permission === "asked") step.permission = state === "done" ? "allowed" : "denied";
  return step;
}

/** Nothing of a journal is going any more. */
function settle(journal: SessionStep[]) {
  for (const step of journal) if (step.state === "running") step.state = "done";
}

/** The turn ends: nothing is going any more, and the journal closes on what Claude said. */
function closeSteps(session: ClaudeSession, answer: string | null) {
  settle(session.steps);
  // Cursor's words are already in the journal, one "Cursor said" line each.
  log(session.steps, newStep(TURN_DONE, "reply", session.agent === "cursor" ? null : answer));
}

// ── Subagents ─────────────────────────────────────────────────────────────────
// A subagent has no session of its own: its events carry the session's id, and
// `agent_id` says which subagent they come from (plans/subagents-plan.md). What
// it was launched to do is not on its own events: it is on the session's
// `Agent` call, tied to it by `launched_agent`, and in `background_tasks`.
//
// Not everything that fires SubagentStop is a subagent. Claude Code runs side
// agents of its own — the progress line of a background agent, written every
// half minute; the recap of a session left alone; a prompt suggestion; its
// memory — and each fires SubagentStop when it is done, with an `agent_id`
// nothing else ever carried and an empty `agent_type`, and no SubagentStart
// before it. A session with one subagent at work sends dozens of them. So a
// subagent exists here only once it was really launched: an `Agent` call that
// came back naming it, a SubagentStart that says its type (or answers a call
// that is waiting for one), or a background task Claude Code lists with its
// type and its description. A stop, or a tool event, from an id that was never
// launched makes nothing.

/** The ids given to subagents no event gave one to. */
let anonymous = 0;

/** The line of the main journal where a subagent was launched: one per subagent, and what opens its view. */
function launchStep(agent: Subagent): SessionStep {
  const step = newStep("Agent", "launch", null);
  step.agentId = agent.id;
  step.at = agent.startedAt;
  return step;
}

/** One subagent too many: the oldest that has stopped goes, and the line it was launched on with it. */
function trimSubagents(session: ClaudeSession) {
  while (session.subagents.length > MAX_SUBAGENTS) {
    const old = session.subagents.find((a) => a.state !== "running") ?? session.subagents[0];
    session.subagents.splice(session.subagents.indexOf(old), 1);
    session.steps = session.steps.filter((s) => !(s.kind === "launch" && s.agentId === old.id));
  }
}

/** A type as an event says it: a word, or nothing. Claude Code's own side agents stop with an empty one. */
const typeOf = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The subagent of this id, if the session launched one. */
const metSubagent = (session: ClaudeSession, id: string | null | undefined) =>
  (id ? session.subagents.find((a) => a.id === id) : null) ?? null;

/** What an event says of a subagent already met: its type, if nothing had said it. */
function tellType(agent: Subagent, type: string) {
  if (type && !agent.type) agent.type = type;
}

/**
 * One more subagent of the session: only ever called for one that was really
 * launched (see above). `call` is the `Agent` call that launched it, when it
 * was seen: its start is the subagent's, and when it is a line of the main
 * journal, that line becomes the one the subagent was launched on — one line
 * per subagent, and the same object as the subagent. `timed` says its start
 * was seen some other way (its SubagentStart).
 */
function addSubagent(session: ClaudeSession, id: string, type: string, call: SessionStep | null, timed: boolean): Subagent {
  const agent: Subagent = {
    id, type, description: null, task: null, state: "running",
    startedAt: call?.at ?? Date.now(), timed: timed || call != null, endedAt: null,
    result: null, steps: [], anonymous: false, strays: 0, past: false,
  };
  session.subagents.push(agent);
  const called = call ? session.steps.indexOf(call) : -1;
  if (called >= 0) session.steps[called] = launchStep(agent);
  else log(session.steps, launchStep(agent));
  trimSubagents(session);
  return agent;
}

/** What an `Agent` call says of the subagent it launches: its type, what for, and the start of what it is asked. */
function callWords(input: Record<string, unknown>) {
  const text = (key: string) => (typeof input[key] === "string" && (input[key] as string).trim() ? (input[key] as string).trim() : null);
  return { type: text("subagent_type"), description: text("description"), task: taskStart(input.prompt) };
}

/** A subagent takes what a call says of it, where nothing had said it yet. */
function nameSubagent(agent: Subagent, words: ReturnType<typeof callWords>) {
  if (words.description) agent.description = words.description;
  if (words.task && !agent.task) agent.task = words.task;
  tellType(agent, words.type ?? "");
}

/**
 * A subagent starts. The session's `Agent` call that launched it came just
 * before, and its line of the journal becomes the line the subagent was
 * launched on. Which call is known for sure only when the call comes back
 * (`launched_agent`); until then, calls and starts are paired in the order
 * they come, kind for kind — which is also all there is to go by on a version
 * of Claude Code that says no more. A start that says no type and answers no
 * call is not a launch, and makes nothing.
 */
function startSubagent(session: ClaudeSession, payload: HookPayload): Subagent | null {
  const type = typeOf(payload.agent_type);
  const met = metSubagent(session, payload.agent_id);
  if (met) {
    tellType(met, type);
    return met;
  }
  // The call of its kind that has waited longest; a start that says no kind, or a call that does not, takes the oldest.
  let at = session.launching.findIndex((call) => call.type === type);
  if (at < 0) at = session.launching.findIndex((call) => !type || !call.type);
  const call = at >= 0 ? session.launching.splice(at, 1)[0] : null;
  if (!type && !call) return null;
  const id = payload.agent_id ?? `nook-${++anonymous}`;
  const agent = addSubagent(session, id, type || call?.type || "", call?.step ?? null, true);
  if (call) nameSubagent(agent, call);
  if (!payload.agent_id) {
    // No id on its own start: none of its tool events will say they are its.
    agent.anonymous = true;
    session.attributed = false;
  }
  return agent;
}

/**
 * An `Agent` call has come back: its response says which subagent it launched,
 * and the call what for. A call that ran in the background comes back at once,
 * just after the subagent's start; one that waited for its subagent comes back
 * after it has stopped. Either way the subagent is known by then — unless its
 * start went by unseen (Nook started in between), and then the call itself is
 * the launch: `call` is its line of the journal, when there is one.
 */
function nameLaunched(session: ClaudeSession, payload: HookPayload, call: SessionStep | null): boolean {
  const id = payload.launched_agent;
  if (!id) return false;
  const words = callWords(payload.tool_input ?? {});
  let agent = metSubagent(session, id);
  if (!agent) {
    agent = addSubagent(session, id, words.type ?? "", call, false);
    // It waited for its subagent, and is back: the subagent has stopped.
    if (!payload.launched_async) {
      agent.state = "done";
      agent.endedAt = Date.now();
    }
  }
  nameSubagent(agent, words);
  // The model it was really given, when the call's response said.
  const model = readModel(payload.launched_model);
  if (model) agent.model = model;
  return true;
}

/** A subagent has stopped: nothing of it is going or waiting any more, and it has said its last. */
function closeSubagent(island: Island, session: ClaudeSession, agent: Subagent, state: "done" | "failed", result: string | null) {
  if (agent.state === "running") agent.endedAt = Date.now();
  agent.state = state;
  if (result) agent.result = result;
  settle(agent.steps);
  for (const request of requestsOf(session)) {
    if (request.agentId === agent.id) dropRequest(island, session, request.requestId);
  }
}

/**
 * A subagent the island saw stop is heard from again — it was resumed, or what
 * stopped was not all of it: it is at work, as its tool says.
 */
function reopenSubagent(agent: Subagent) {
  if (agent.state === "running") return;
  agent.state = "running";
  agent.endedAt = null;
}

/** A subagent among the background tasks a Stop or a SubagentStop lists. */
interface BackgroundAgent {
  id: string;
  running: boolean;
  failed: boolean;
  description: string | null;
  type: string | null;
}

/**
 * The subagents among an event's `background_tasks` — null when the event
 * carries no such list (an older Claude Code), which is not the same as an
 * empty one. A command left running in the background is a task too, and is
 * none of the island's business: it does not keep a turn from being over.
 */
function backgroundAgents(payload: HookPayload): BackgroundAgent[] | null {
  if (!Array.isArray(payload.background_tasks)) return null;
  const agents: BackgroundAgent[] = [];
  for (const task of payload.background_tasks as Record<string, unknown>[]) {
    if (!task || typeof task.id !== "string" || !task.id) continue;
    const text = (key: string) => (typeof task[key] === "string" && (task[key] as string).trim() ? (task[key] as string).trim() : null);
    if (text("type") ? text("type") !== "subagent" : text("agent_type") == null) continue;
    const status = (text("status") ?? "").toLowerCase();
    agents.push({
      id: task.id, running: status === "running", failed: /fail|error|kill|cancel|abort/.test(status),
      description: text("description"), type: text("agent_type"),
    });
  }
  return agents;
}

/**
 * What a list of background tasks says of the session's subagents: what each
 * was launched to do, and that one has stopped that the island thought running.
 * It never says one runs that the island saw stop: a subagent still lists
 * itself as running on its own SubagentStop. One the island never saw launched
 * is taken from the list only when the list says all of it — that it runs, its
 * type and what it is for: a subagent launched before Nook was looking.
 */
function heedTasks(island: Island, session: ClaudeSession, tasks: BackgroundAgent[]) {
  for (const task of tasks) {
    let agent = metSubagent(session, task.id);
    if (!agent) {
      if (!task.running || !task.type || !task.description) continue;
      agent = addSubagent(session, task.id, task.type, null, false);
    }
    if (task.description && !agent.description) agent.description = task.description;
    tellType(agent, task.type ?? "");
    if (agent.state === "running" && !task.running) closeSubagent(island, session, agent, task.failed ? "failed" : "done", null);
    else if (task.failed) agent.state = "failed";
  }
}

/** True while one of the session's subagents is between its start and its stop. */
const subagentsRunning = (session: ClaudeSession) => session.subagents.some((a) => a.state === "running");

/** One more line of what the session did. */
function say(session: ClaudeSession, line: string) {
  session.lines.push(line);
  if (session.lines.length > MAX_LINES) session.lines.splice(0, MAX_LINES / 2);
}

/** How the Agent SDK names itself as an entry point: "sdk-ts", "sdk-py", "sdk-cli". */
const SDK_ENTRYPOINT = "sdk";

/**
 * A session started by a program rather than a person — a review a plugin runs
 * on each commit, a script. It sends the same hooks from the same folder, and
 * followed like any other it would take the island away from the conversation
 * the user is in, steps, title and all.
 */
function isAutomated(payload: HookPayload): boolean {
  return (payload.entrypoint ?? "").toLowerCase().startsWith(SDK_ENTRYPOINT);
}

const waits = (session: ClaudeSession) => session.approval != null || session.question != null;

/**
 * A session heard from is at work — unless a request of its is waiting: with
 * subagents, the others go on while one asks, and their steps must not take
 * the session out of "needs you".
 */
function atWork(session: ClaudeSession, state: "working" | "thinking" = "working") {
  session.state = session.question ? "question" : session.approval ? "approval" : state;
}

/** No turn under way, and nothing asked: the session is where its last turn left it. */
const AT_REST: ReadonlySet<string> = new Set(["idle", "finished", "error", "sleeping"]);
const resting = (session: ClaudeSession) => AT_REST.has(session.state) && !waits(session);

/** The session an event comes from, told what the event says of it. A new one gets a place. */
function sessionOf(island: Island, payload: HookPayload): ClaudeSession {
  const id = payload.session_id || ANONYMOUS;
  let session = State.sessions.find((s) => s.id === id);
  if (!session) {
    session = newSession(id, payload.nook_tool === "cursor" ? "cursor" : payload.nook_tool === "codex" ? "codex" : "claude");
    State.sessions.push(session);
    makeRoom(island, session);
  }
  // Where it runs: Nook says it on every event of the session. An event that
  // says nothing of it leaves what is known alone.
  const target = readTarget(payload.target);
  if (target) session.target = target;
  if (payload.session_title) session.title = payload.session_title;
  // The model it runs on, on the events that say it — and only the session's
  // own: an event from inside a subagent would name the subagent's.
  if (!payload.agent_id) session.model = readModel(payload.model) ?? session.model;
  // How full its context is, on the events that read the transcript; the others keep what was known.
  if (typeof payload.context_tokens === "number" && payload.context_tokens > 0 && !payload.agent_id) session.contextTokens = payload.context_tokens;
  if (payload.cwd) {
    session.cwd = payload.cwd;
    session.project = lastPathComponent(payload.cwd) || SESSION_UNNAMED;
    // The Shelf's Projects widget keeps the folders sessions have run in (said once per folder).
    rememberProject(payload.cwd);
  }
  session.heardAt = Date.now();
  return session;
}

/**
 * One session too many: the one that goes is at rest if any is, and the one
 * heard from longest ago. Never the one in front, the one that just came, or
 * one that is waiting for an answer.
 */
function makeRoom(island: Island, newcomer: ClaudeSession) {
  while (State.sessions.length > MAX_SESSIONS) {
    const old = State.sessions
      .filter((s) => s !== newcomer && s.id !== State.frontId && !waits(s))
      .sort((a, b) => Number(resting(b)) - Number(resting(a)) || a.heardAt - b.heardAt)[0];
    if (!old) return;
    forget(island, old);
  }
}

/** A session is over, or gave its place: nothing of it is kept. */
function forget(island: Island, session: ClaudeSession) {
  const at = State.sessions.indexOf(session);
  if (at < 0) return;
  for (const request of requestsOf(session)) {
    void Bridge.approvalDecline(request.requestId);
    stopWaiting(request.requestId);
  }
  State.sessions.splice(at, 1);
  State.changes.delete(session.id);
  if (session.id !== State.frontId) return;
  // It was in front: the one heard from last takes its place.
  const next = [...State.sessions].sort((a, b) => b.heardAt - a.heardAt)[0];
  State.bringForward(next?.id ?? "");
  island.afterRequest(onCard());
}

/** True while the island shows a request's card. */
const onCard = () => State.view === "approval" || State.view === "question";

/** The views that are about the session in front: it is not changed under them. */
const ABOUT_FRONT: ReadonlySet<IslandViewName> = new Set(["session", "finished", "error", "approval", "question"]);
/** The events that say a session is being worked in. */
const WORK_EVENTS: ReadonlySet<string> = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse"]);

/**
 * Whether the session an event comes from takes the front. The island stays on
 * the session it shows for as long as that one is at work or being looked at:
 * another one takes its place when it has nothing going on, or to ask for
 * something — unless the one in front is itself waiting for an answer, and
 * then the request waits its turn.
 */
function takesFront(session: ClaudeSession, event: string): boolean {
  const front = State.session;
  if (!front.id) return true;
  if (front === session || waits(front)) return false;
  if (event === "PermissionRequest") return true;
  const watched = State.mode === "expanded" && ABOUT_FRONT.has(State.view);
  return WORK_EVENTS.has(event) && resting(front) && !watched;
}

/** "C:\\work\\app\\src\\a.ts" in "C:\\work\\app" → "src/a.ts". Outside the folder, the whole path. */
function sessionPath(file: string, cwd: string): string {
  const path = file.replace(/\\/g, "/");
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? path.slice(root.length + 1) : path;
}

/** One more edit to a file: the file moves to the top of the session's changes. */
function recordChange(session: ClaudeSession, payload: HookPayload) {
  const change = payload.change;
  const file = payload.tool_input?.file_path;
  if (!change || typeof file !== "string") return;
  const path = sessionPath(file, payload.cwd ?? "");
  const files = State.changes.get(session.id) ?? [];
  const at = files.findIndex((f) => f.path === path);
  const entry: ChangedFile =
    at >= 0 ? files.splice(at, 1)[0] : { path, created: change.created, additions: 0, deletions: 0, edits: [], at: 0 };
  entry.edits.push({
    patch: change.patch, additions: change.additions, deletions: change.deletions,
    truncated: change.truncated, at: Date.now(),
  });
  if (entry.edits.length > MAX_EDITS) entry.edits.shift();
  entry.additions += change.additions;
  entry.deletions += change.deletions;
  entry.at = Date.now();
  files.unshift(entry);
  if (files.length > MAX_FILES) files.pop();
  State.changes.set(session.id, files);
}

/** The question tool's input as the island shows it — null when it is not one it can answer. */
function questionsOf(input: Record<string, unknown>): Question[] | null {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: Question[] = [];
  for (const q of raw as Record<string, unknown>[]) {
    const options = Array.isArray(q?.options) ? (q.options as Record<string, unknown>[]) : [];
    if (typeof q?.question !== "string" || options.some((o) => typeof o?.label !== "string")) return null;
    questions.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : null,
      options: options.map((o) => ({
        label: o.label as string,
        description: typeof o.description === "string" ? o.description : null,
      })),
      multiSelect: q.multiSelect === true,
    });
  }
  return questions;
}

/** The relay's wait for this request is no longer the island's to time. */
function stopWaiting(requestId: string) {
  const timeout = pendingTimeouts.get(requestId);
  if (timeout != null) window.clearTimeout(timeout);
  pendingTimeouts.delete(requestId);
}

/**
 * A request is no longer needed: it was answered in Claude Code itself, the
 * relay stopped waiting, or whoever asked has stopped. The island lets go of
 * it — the one on the card, and the next in line takes the card, or one that
 * was waiting behind it. The relay is told too: it may still be holding
 * the connection.
 */
function dropRequest(island: Island, session: ClaudeSession, requestId: string) {
  stopWaiting(requestId);
  const queued = session.queued.findIndex((request) => request.requestId === requestId);
  const held = (session.approval ?? session.question)?.requestId === requestId;
  if (!held && queued < 0) return;
  // Rust is told even of one answered elsewhere: it frees the relay, and an island
  // that came up for the request can go away again (visibility.rs).
  void Bridge.approvalDecline(requestId);
  if (!held) {
    session.queued.splice(queued, 1);
    return;
  }
  nextRequest(session);
  if (!waits(session) && session.news === "approval") session.news = null;
  if (session.id === State.frontId) island.afterRequest(onCard());
}

/** The tool a request is about. */
const requestTool = (request: SessionRequest) => (isQuestion(request) ? QUESTION_TOOL : request.tool);

/**
 * The request this event says was answered elsewhere: the tool it is about has
 * run, so someone decided — in Claude Code's own window. With several waiting,
 * it is the one of the same tool from the same subagent; on a version where
 * events do not say which subagent they come from, the first of that tool.
 */
function answeredElsewhere(session: ClaudeSession, payload: HookPayload): SessionRequest | null {
  const from = payload.agent_id ?? null;
  const about = requestsOf(session).filter((request) => requestTool(request) === payload.tool_name);
  return about.find((request) => request.agentId === from) ?? (session.attributed === true ? null : (about[0] ?? null));
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * What a tool does, in a word — the macOS app's frenchStep(), in English like
 * the rest of the island here.
 */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Runs",
  Read: "Reads",
  Write: "Writes",
  Edit: "Edits",
  Glob: "Finds",
  Grep: "Searches",
  WebSearch: "Searches the web",
  WebFetch: "Fetches",
  TodoWrite: "Todos",
  Task: "Agent",
  LS: "Lists",
  MultiEdit: "Edits",
  NotebookEdit: "Notebook",
  PowerShell: "Runs",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  void onEvent<SessionModelPayload>("session_model", tellModel);
}

/**
 * The status line's relay says which model a session runs on. Only a session
 * already followed takes it: this is no event of a session's, and makes none.
 * Exported for the dev preview.
 */
export function tellModel(payload: SessionModelPayload) {
  const session = State.sessions.find((s) => s.id === payload?.sessionId);
  const model = readModel(payload?.model);
  if (!session || !model) return;
  const window = typeof payload.contextWindow === "number" ? payload.contextWindow : session.contextWindow;
  if (session.model?.id === model.id && session.model.label === model.label && session.contextWindow === window) return;
  session.model = model;
  session.contextWindow = window;
  State.notify();
}

/**
 * An event from a third-party agent (docs/AGENTS.md): it has a pill of its
 * own, "agent_<name>", created on its first event and gone when it is done.
 * None of what follows a Claude Code session — its journal, its questions —
 * applies to it: the pill wears the agent's state and its last steps.
 */
function handleAgent(island: Island, payload: HookPayload, agent: string) {
  const agentId = `agent_${agent}`;
  const name = payload.hook_event_name ?? "";
  const focused = State.focusId === agentId;
  const ensurePill = () => State.upsertExternalAgent(agentId, agent, agentColor(agent));
  const reveal = () => {
    if (State.mode === "hidden") island.reveal();
  };
  const alert = (view: IslandViewName) => (State.mode === "expanded" ? island.setView(view) : island.alert(view));

  switch (name) {
    case "SessionStart":
      ensurePill();
      reveal();
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      State.updateTask(agentId, "thinking");
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, asked.slice(0, LINE_CHARS));
      reveal();
      break;
    }

    case "PreToolUse":
      ensurePill();
      State.updateTask(agentId, "working");
      State.appendStep(agentId, stepLabel(payload.tool_name ?? "Tool", payload.tool_input ?? {}));
      reveal();
      break;

    case "PostToolUse":
      State.updateTask(agentId, "working");
      break;

    case "PostToolUseFailure":
      State.updateTask(agentId, "working");
      State.appendStep(agentId, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
      }
      break;
    }

    case "Stop":
      State.updateTask(agentId, "finished");
      if (payload.message) State.appendStep(agentId, payload.message.slice(0, LINE_CHARS));
      Sound.play("finish");
      if (focused) alert("finished");
      else State.setPillBadge(agentId, "finished");
      window.setTimeout(() => State.removeTask(agentId), FINISHED_MS);
      break;

    case "StopFailure":
      State.updateTask(agentId, "error");
      Sound.play("error");
      if (focused) alert("error");
      else State.setPillBadge(agentId, "error");
      break;

    case "SessionEnd":
      State.removeTask(agentId);
      break;

    case "SubagentStart":
      State.appendStep(agentId, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(agentId, "• subagent done");
      break;

    case "PermissionRequest":
      // External agents do not get an approval card — showing one would look like
      // a Claude Code request. Decline immediately so the agent re-asks in its
      // terminal. Approval support for other agents will come with Codex support.
      if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
      break;

    default:
      break;
  }
  State.notify();
}

/** Exported for the dev preview, which plays a session without Claude Code. */
export function handleHook(island: Island, payload: HookPayload) {
  // Route to the right pill. Valid nook_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code, as before.
  const agent = validateAgent(payload.nook_agent);
  if (agent && !State.paused) return handleAgent(island, payload, agent);

  // Cursor's agent is followed for its status only: never a card to answer, and
  // not at all when the user turned it off (Settings → Cursor).
  const cursor = payload.nook_tool === "cursor";
  if (cursor && (payload.hook_event_name === "PermissionRequest" || !State.settings.showCursorSessions)) {
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }
  // Codex's sessions are followed as Claude Code's are, requests and all — unless
  // the user turned them off (Settings → Codex): Codex then asks in its own window.
  if (payload.nook_tool === "codex" && !State.settings.showCodexSessions) {
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  // Paused, or a session nobody is sitting in front of: the island does not look.
  if (State.paused || isAutomated(payload)) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";

  if (name === "SessionEnd") {
    const over = State.sessions.find((s) => s.id === (payload.session_id || ANONYMOUS));
    if (over) forget(island, over);
    State.notify();
    return;
  }

  const session = sessionOf(island, payload);
  // Cursor says its last words in events of their own; the turn ends on the latest.
  if (cursor && name === "Stop" && !payload.last_message && session.answer) payload.last_message = session.answer;
  if (takesFront(session, name)) State.bringForward(session.id);
  /** The session the island shows; the others go on behind their tabs. */
  const front = session.id === State.frontId;
  const focused = front && State.focusId === CLAUDE_ID;
  const cwd = payload.cwd ?? "";
  // A tool event from inside a subagent goes to that subagent's own journal,
  // not to the session's: the main journal keeps one line for it, where it was
  // launched. Its start and its stop are not tool events, and are met below.
  const lifecycle = name === "SubagentStart" || name === "SubagentStop";
  const from = !lifecycle && payload.agent_id ? payload.agent_id : null;
  const subagent = metSubagent(session, from);
  const journal = subagent?.steps ?? session.steps;
  if (subagent) {
    session.attributed = true;
    tellType(subagent, typeOf(payload.agent_type));
  }
  // A tool event from inside something the session never launched — one of
  // Claude Code's own side agents, or a subagent started before Nook was
  // looking: its steps are nobody's the island knows, and are no line of the
  // session's own journal either. What it asks permission for is still asked.
  const stranger = from != null && !subagent;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: IslandViewName, isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /**
   * Something of this session ended — a turn, a subagent — while its panel is
   * being read (`core/reading.ts`): nothing is taken from the reader, not the
   * panel's session, not its place. The panel is told to signal it instead:
   * the jump button for the session in front, the line of the sidebar (and a
   * mark that stays until it is opened) for another. Never for a request: that
   * one has Claude Code waiting, and always shows.
   */
  const hold = (): boolean => {
    if (State.mode !== "expanded" || State.view !== "session" || !Reader.reading()) return false;
    session.nudges++;
    if (!front) session.attention = true;
    return true;
  };

  /**
   * A turn's end, good or bad: its card when the session is in front, a mark
   * on its tab when it is behind, a badge on the pill when Claude's is not
   * the one in front.
   */
  const tell = (what: "finished" | "error") => {
    if (focused) {
      // Someone is reading the panel: the card would take it from under them,
      // so it does not come up. The panel wiggles, and the result stays unseen.
      if (hold()) return;
      // Its card comes up: what the turn ended on has been shown.
      session.unseen = false;
      return surface(what, true);
    }
    if (!front) {
      session.news = what;
      hold();
    }
    if (State.focusId !== CLAUDE_ID) State.setPillBadge(CLAUDE_ID, what);
  };

  switch (name) {
    case "SessionStart":
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      // A turn is under way again — the user's, or the one Claude Code starts
      // itself to hear what a subagent came back with.
      session.parked = false;
      atWork(session, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      // Cursor sends no title: the first thing it was asked is the conversation's name.
      if (cursor && !session.title && asked?.trim()) session.title = asked.trim().split(/\r?\n/)[0].slice(0, 80);
      // What Claude Code feeds itself as a prompt — a task's notification, a
      // reminder — comes as markup, and is nobody's words to show.
      if (asked && !asked.trimStart().startsWith("<")) {
        session.asked = asked;
        session.answer = null;
        session.toldReply = null;
        // Whatever the last reply was waiting on, the user has spoken: the next turn has started.
        session.decision = false;
        log(session.steps, newStep("Prompt", "prompt", asked));
        say(session, asked.slice(0, LINE_CHARS));
      }
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      if (stranger) break;
      atWork(session);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      const step = startStep(journal, tool, input, cwd);
      if (subagent) {
        step.agentId = subagent.id;
        // One that had stopped, as far as the island knew, and runs a tool: it is at work.
        reopenSubagent(subagent);
      }
      // The session launches a subagent: its start comes next, and is named by this call.
      else if (AGENT_TOOLS.has(tool)) {
        session.launching.push({ step, ...callWords(input) });
        if (session.launching.length > MAX_SUBAGENTS) session.launching.shift();
      }
      // A tool that says nothing of who runs it, after the session's own turn
      // has stopped: a subagent's, on a version of Claude Code that does not say so.
      else if (session.attributed !== true) {
        if (session.parked && subagentsRunning(session)) session.attributed = false;
        // Before that is plain: it may be any running subagent's, and each is told so.
        for (const sub of session.subagents) if (sub.state === "running") sub.strays++;
      }
      say(session, stepLabel(tool, input));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
    case "PostToolUseFailure": {
      const failed = name === "PostToolUseFailure";
      const answered = answeredElsewhere(session, payload);
      if (answered) dropRequest(island, session, answered.requestId);
      // An `Agent` call that launched a subagent names it. The session's own
      // call has no step of its own left to end: its line is the launch's. A
      // subagent's call (it launched one of its own) stays a step of its journal.
      const calls = !failed && AGENT_TOOLS.has(payload.tool_name ?? "");
      const words = calls ? callWords(payload.tool_input ?? {}) : null;
      // The call this is the end of, while it still waits for its subagent's start: the one that says the same.
      const waiting = words && !from
        ? (session.launching.find((call) => call.type === words.type && call.description === words.description) ?? null)
        : null;
      const launched = calls && nameLaunched(session, payload, waiting?.step ?? null);
      if (launched && waiting) session.launching = session.launching.filter((call) => call !== waiting);
      if (stranger) break;
      if (!launched || subagent) {
        const ended = endStep(journal, payload, failed ? "failed" : "done");
        session.launching = session.launching.filter((call) => call.step !== ended);
      }
      if (!failed) recordChange(session, payload);
      else say(session, "⚠ failed");
      atWork(session);
      break;
    }

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        session.state = "ratelimit";
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        session.state = "question";
        say(session, message);
      }
      if (message) log(session.steps, newStep("Notification", "note", message));
      break;
    }

    case "Stop": {
      // What still runs in the background says whether the turn is really over.
      // Subagents launched in the background outlive the turn that launched
      // them: Claude Code fires Stop while they are still at work, and again
      // once it has heard from the last of them. Only that one is the end.
      const tasks = backgroundAgents(payload);
      if (tasks) heedTasks(island, session, tasks);
      // The list is the word on it. Without one (an older Claude Code), a
      // subagent between its start and its stop is.
      const busy = tasks
        ? tasks.some((task) => task.running && session.subagents.some((a) => a.id === task.id && a.state === "running"))
        : subagentsRunning(session);
      if (busy) {
        // The session's own tools are done; its subagents' are not, and it is
        // still at work: no "finished", no sound, no card.
        settle(session.steps);
        session.launching = [];
        session.parked = true;
        atWork(session);
        say(session, "… waiting for its subagents");
        // It said something to end its own turn: that is an answer, and the
        // user is told — once — though the session is not finished: the
        // finish sound, and the card or the mark a finished turn gets, worded
        // "Replied · N subagents still running". With nothing said, nothing is told.
        const reply = payload.last_message?.trim() ? payload.last_message : null;
        if (reply) {
          log(session.steps, newStep(TURN_PARKED, "reply", reply));
          session.answer = reply;
          session.answeredAt = Date.now();
          session.decision = needsDecision(reply);
          if (reply !== session.toldReply) {
            session.toldReply = reply;
            Sound.play("finish");
            tell("finished");
          }
        }
        break;
      }
      // Really over: nothing of it runs, nothing of it waits, and its
      // subagents leave the sidebar.
      session.parked = false;
      session.launching = [];
      for (const request of requestsOf(session)) dropRequest(island, session, request.requestId);
      for (const sub of session.subagents) {
        if (sub.state === "running") closeSubagent(island, session, sub, "done", null);
        sub.past = true;
      }
      // The reply the user was told of while subagents ran, with nothing new
      // said since: the turn ends on it, and it is not told a second time.
      const said = payload.last_message?.trim() ? payload.last_message : null;
      const told = session.toldReply != null && (said == null || said === session.toldReply);
      const parkedReply = told ? [...session.steps].reverse().find((s) => s.tool === TURN_PARKED && s.target === session.toldReply) : null;
      if (said) {
        session.answer = said;
        session.answeredAt = Date.now();
        // The same words as the reply already told of keep the mark as it stands: read, it stays read.
        if (!told) session.decision = needsDecision(said);
      }
      if (parkedReply) {
        settle(session.steps);
        parkedReply.tool = TURN_DONE;
      } else closeSteps(session, said);
      session.toldReply = null;
      session.state = "finished";
      // What the home view counts from, to let it go; and its result is new
      // until its card shows it (`tell`) or the session is opened.
      session.restedAt = Date.now();
      session.unseen = true;
      if (payload.message) say(session, payload.message.slice(0, LINE_CHARS));
      if (!told) {
        Sound.play("finish");
        tell("finished");
      }
      window.setTimeout(() => {
        // Still where its turn left it: back to rest. Its tab keeps its mark.
        if (session.state === "finished") session.state = "idle";
        if (session.id === State.frontId) State.setPillBadge(CLAUDE_ID, null);
        State.present();
      }, FINISHED_MS);
      break;
    }

    // Cursor's own events: what it said, what it thought, and a word of its
    // own. Words and status, nothing to answer.
    case "AgentMessage": {
      const said = payload.last_message?.trim();
      if (!said) break;
      log(session.steps, newStep("Cursor said", "reply", said));
      session.answer = said;
      session.answeredAt = Date.now();
      say(session, said.slice(0, LINE_CHARS));
      break;
    }

    case "AgentThought": {
      const thought = payload.message?.trim();
      if (!thought) break;
      atWork(session, "thinking");
      // A run of thoughts is one line, kept up to date.
      const last = session.steps[session.steps.length - 1];
      if (last?.tool === "Thinking") last.target = thought;
      else log(session.steps, newStep("Thinking", "note", thought));
      say(session, "Thinking…");
      break;
    }

    case "AgentNote":
      if (payload.message) log(session.steps, newStep("Note", "note", payload.message));
      break;

    case "StopFailure":
      log(session.steps, newStep("Error", "note", "The session stopped on an error.")).state = "failed";
      session.state = "error";
      Sound.play("error");
      tell("error");
      break;

    case "SubagentStart":
      if (startSubagent(session, payload)) say(session, "+ subagent");
      break;

    case "SubagentStop": {
      // The one the event names — and only one the session launched: Claude
      // Code's own side agents stop too, by the dozen, and are nothing to show.
      // With no name to go by (an older Claude Code), the one that has run longest.
      const stopped = payload.agent_id
        ? metSubagent(session, payload.agent_id)
        : (session.subagents.find((a) => a.state === "running") ?? null);
      if (stopped) {
        tellType(stopped, typeOf(payload.agent_type));
        // A second stop of one that has stopped changes nothing of how it ended.
        if (stopped.state === "running") {
          closeSubagent(island, session, stopped, "done", payload.last_message ?? null);
          say(session, "• subagent done");
        } else if (payload.last_message) stopped.result = payload.last_message;
      }
      const tasks = backgroundAgents(payload);
      if (tasks) heedTasks(island, session, tasks);
      break;
    }

    case "PermissionRequest": {
      const requestId = payload.request_id ?? "";
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      // One card at a time. A second request must never quietly replace the
      // first — that would leave a human staring at request B while request A
      // waits for a decision nobody can give. With subagents two can ask at
      // once: the second waits behind the first, and gets the card next.
      const held = session.approval ?? session.question;
      const behind = held != null && held.requestId !== requestId;
      // A line with no room left goes back to the terminal, as a second request always used to.
      if (behind && session.queued.length >= MAX_QUEUED) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      // The journal says the tool had to ask, and later what it was told: the
      // subagent's own journal, when it is a subagent that asks.
      const asking = stranger ? null : goingStep(journal, tool);
      if (asking) asking.permission = "asked";
      // Whoever asks, by the id its events carry: the tool's end is matched to the request by it.
      const agentId = from;
      // Claude's question tool asks for permission like any other: allowing it
      // with the answers is how a question gets answered from here.
      const questions = tool === QUESTION_TOOL ? questionsOf(input) : null;
      // A click must never allow more than the card shows. A command the relay
      // had to cut, or an edit whose diff was cut, is not offered here at all.
      let tooLong = false;
      let request: SessionRequest;
      const askedAt = Date.now();
      if (questions) request = { requestId, sessionId: session.id, questions, agentId, step: asking, askedAt };
      else {
        const file = input.file_path;
        const proposal =
          payload.proposal && typeof file === "string" ? { path: sessionPath(file, cwd), ...payload.proposal } : null;
        tooLong = payload.target_truncated === true || proposal?.truncated === true;
        request = { requestId, sessionId: session.id, tool, command: approvalTarget(tool, input), proposal, tooLong, agentId, step: asking, askedAt };
      }
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands —
      // or, for a request that waits behind another, the card that says so
      // ("1 of 2"): a human can see it and will get to it, and its own 108 s
      // to be answered in run from now.
      // A request too long to show goes straight back: Claude Code asks in its
      // own window, which shows all of it, and the card only says where to look.
      if (requestId) void (tooLong ? Bridge.approvalDecline(requestId) : Bridge.approvalAck(requestId));
      stopWaiting(requestId);
      pendingTimeouts.set(requestId, window.setTimeout(() => {
        dropRequest(island, session, requestId);
        State.present();
      }, PENDING_MS));
      Sound.play(questions ? "question" : "approval");
      // The island was folded with a request still waiting — the user went to
      // its window — and another one comes: it opens again, on the card of the
      // request that waits in front, which counts this one.
      const reopen = () => {
        const waiting = State.session;
        if (State.mode === "expanded" || State.focusId !== CLAUDE_ID || !waits(waiting)) return;
        State.isPinned = true;
        island.alert(waiting.question ? "question" : "approval");
      };
      // Behind the card already up: nothing moves, the card counts one more.
      if (behind) {
        session.queued.push(request);
        reopen();
        break;
      }
      session.approval = isQuestion(request) ? null : request;
      session.question = isQuestion(request) ? request : null;
      session.state = questions ? "question" : "approval";
      if (!front) {
        // The session in front is waiting for an answer of its own: this one
        // waits its turn behind its tab, and gets the card next.
        session.news = "approval";
        reopen();
      } else if (focused) {
        State.isPinned = true;
        island.alert(questions ? "question" : "approval");
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.isPinned = true;
        State.setPillBadge(CLAUDE_ID, "approval");
        island.reveal();
      }
      break;
    }

    default:
      break;
  }
  State.present();
}
