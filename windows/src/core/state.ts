// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, Dock, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../bot/engine";

export type AgentSource = "claudeCode" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
  /** For an edit: what it would do to its file, to read before allowing it. */
  proposal: FileProposal | null;
  /**
   * What it asks is longer than the card can show whole. Its card says so and
   * has no Allow: the request is already back with Claude Code's own prompt.
   */
  tooLong: boolean;
  /** The subagent that asks; null for the session itself. */
  agentId: string | null;
  /** The journal's step it is about, where what was decided is written. */
  step: SessionStep | null;
  /** When it was asked: among several sessions waiting, the one that has waited longest is gone to first. */
  askedAt?: number;
}

/** An edit that has not happened yet, as the diff it would make. */
export interface FileProposal {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
  truncated: boolean;
  /** The file does not exist yet. */
  created: boolean;
}

/** One thing Claude asks with its question tool, as the tool words it. */
export interface Question {
  question: string;
  /** A word or two saying what the question is about. */
  header: string | null;
  options: { label: string; description: string | null }[];
  multiSelect: boolean;
}

/** A question Claude is waiting on — up to four at once, answered together. */
export interface QuestionInfo {
  requestId: string;
  sessionId: string;
  questions: Question[];
  /** The subagent that asks; null for the session itself. */
  agentId: string | null;
  /** The journal's step it is about, where what was answered is written. */
  step: SessionStep | null;
  /** When it was asked. */
  askedAt?: number;
}

/** What a session waits on a human for: a permission, or a question. */
export type SessionRequest = ApprovalInfo | QuestionInfo;

export const isQuestion = (request: SessionRequest): request is QuestionInfo => "questions" in request;

/**
 * Where a Claude Code session runs, and so where its ↗ goes: an editor's
 * window, a terminal's, the Claude app — or nowhere the island knows of.
 * Decided once, in Rust, from what nook-hook reports (src-tauri/src/target.rs
 * has the table); every event carries its session's as `target`.
 */
export type TargetKind = "vscode" | "cursor" | "terminal" | "claude" | "unknown";

export interface SessionTarget {
  kind: TargetKind;
  /** What the app is called: "VS Code", "Cursor", "Windows Terminal", "PowerShell", "Claude". */
  label: string;
  /** A terminal with tabs: its window comes forward, the session's tab has to be picked by hand. */
  tabbed: boolean;
}

/** A session nothing says the place of: it has no ↗. */
export const NO_TARGET: SessionTarget = { kind: "unknown", label: "", tabbed: false };

const TARGET_KINDS: ReadonlySet<string> = new Set<TargetKind>(["vscode", "cursor", "terminal", "claude", "unknown"]);

/** An event's `target`, if it is one. */
export function readTarget(value: unknown): SessionTarget | null {
  if (!value || typeof value !== "object") return null;
  const { kind, label, tabbed } = value as Record<string, unknown>;
  if (typeof kind !== "string" || !TARGET_KINDS.has(kind) || typeof label !== "string") return null;
  return { kind: kind as TargetKind, label: label.slice(0, TARGET_LABEL_CHARS), tabbed: tabbed === true };
}

const TARGET_LABEL_CHARS = 40;
/** How much of a session's name the ↗ says, to tell which tab it is in. */
const TAB_NAME_CHARS = 36;

/** What a session's tab is likely called in its terminal: Claude Code titles it after the conversation. */
function tabName(session: Pick<ClaudeSession, "title" | "project">): string {
  const name = session.title ?? session.project;
  return name.length > TAB_NAME_CHARS ? `${name.slice(0, TAB_NAME_CHARS - 1)}…` : name;
}

/**
 * What a session's ↗ does, as its tooltip says it — null when there is
 * nowhere to go, and no button. A terminal with tabs is said as it is: its
 * window opens, and the tab named is the one to pick.
 */
export function targetTip(session: Pick<ClaudeSession, "target" | "title" | "project">): string | null {
  const { kind, label, tabbed } = session.target;
  switch (kind) {
    case "claude": return "Open Claude";
    case "vscode":
    case "cursor": return `Focus ${label}`;
    case "terminal": return tabbed ? `Opens ${label}, tab: ${tabName(session)}` : `Focus ${label} window`;
    default: return null;
  }
}

/** The same, in the two words of a card's button. */
export function targetWords(target: SessionTarget): string | null {
  switch (target.kind) {
    case "claude": return "Open Claude";
    case "vscode":
    case "cursor": return `Open ${target.label}`;
    case "terminal": return "Open terminal";
    default: return null;
  }
}

/** What the Claude pill is called until a session says where it runs. */
export const CLIENT_UNKNOWN = "Claude Code";

/** One edit Claude made to a file: its unified diff, as nook-hook built it. */
export interface FileEdit {
  patch: string;
  additions: number;
  deletions: number;
  /** The diff was longer than the relay forwards. */
  truncated: boolean;
  at: number;
}

/** A file Claude touched in a session, with every edit it made to it, oldest first. */
export interface ChangedFile {
  /** Relative to the session's folder when it is inside it, with forward slashes. */
  path: string;
  /** Written new in this session. */
  created: boolean;
  additions: number;
  deletions: number;
  edits: FileEdit[];
  at: number;
}

/** A few lines of what a tool gave back, as nook-hook forwards them. */
export interface StepResult {
  text: string;
  /** For a file: the number of its first line. */
  start: number | null;
  /** There was more than this. */
  truncated: boolean;
  /** These are the last lines, not the first: what a command ended on. */
  tail: boolean;
}

/** The tool Claude asks its questions with. */
export const QUESTION_TOOL = "AskUserQuestion";

/** The step that closes a turn, in the place of a tool's name. */
export const TURN_DONE = "Done";

/** How many of a session's subagents are still at work. */
export const subagentsGoing = (session: Pick<ClaudeSession, "subagents">) => session.subagents.filter((a) => a.state === "running").length;

/**
 * A session that has replied while subagents it launched still run, in words:
 * "Replied · 1 subagent still running". Null for any other: one at work with
 * nothing said, or one whose turn is really over.
 */
export function repliedWords(session: Pick<ClaudeSession, "parked" | "toldReply" | "subagents">): string | null {
  const going = subagentsGoing(session);
  if (!session.parked || !session.toldReply || going === 0) return null;
  return `Replied · ${going} ${going === 1 ? "subagent" : "subagents"} still running`;
}

/**
 * What a line of a session's journal is: a tool, by what it does as far as
 * showing it goes — or something said: what the user asked (`prompt`), what
 * Claude answered to end its turn (`reply`), a word from Claude Code (`note`).
 * And one that is neither: the place where a subagent was launched (`launch`).
 */
export type StepKind = "read" | "edit" | "command" | "search" | "other" | "prompt" | "reply" | "note" | "launch";

/** The kinds of step that are not a tool at work: words, and where a subagent was launched. */
const SAID: ReadonlySet<StepKind> = new Set<StepKind>(["prompt", "reply", "note", "launch"]);

/** True for a line of the journal that is a tool: what the filter chips count. */
export const isTool = (step: SessionStep) => !SAID.has(step.kind);

/**
 * One line of a session's journal, in the order things happened: a tool by
 * its own name — going, done, or failed — or something that was said.
 */
export interface SessionStep {
  tool: string;
  kind: StepKind;
  state: "running" | "done" | "failed";
  /**
   * What a tool is at: a file by its path in the session's folder, a command,
   * what is looked for. For something said: the words.
   */
  target: string | null;
  /** What it gave back, once it is done. */
  result: StepResult | null;
  /** For an edit: the diff it made. */
  patch: string | null;
  /** For Claude's question tool: what it asks, and once answered, what was picked for each. */
  questions: Question[] | null;
  answers: Record<string, string> | null;
  /** For a tool that had to ask first: where its permission request stands. */
  permission: "asked" | "allowed" | "denied" | null;
  /**
   * The subagent it belongs to: the one whose step it is, or, for the line
   * where a subagent was launched, the one launched. None for the session's own.
   */
  agentId?: string;
  /** When it started; once it has ended, when it ended. */
  at: number;
}

/** A step with nothing in it yet but what it is. */
export function newStep(tool: string, kind: StepKind, target: string | null): SessionStep {
  return {
    tool, kind, state: SAID.has(kind) ? "done" : "running",
    target, result: null, patch: null, questions: null, answers: null, permission: null, at: Date.now(),
  };
}

/** The tools of the turn under way: what the session did since it was last asked something. */
export function turnSteps(session: ClaudeSession): SessionStep[] {
  const asked = session.steps.map((step) => step.kind).lastIndexOf("prompt");
  return session.steps.slice(asked + 1).filter(isTool);
}

/**
 * A subagent a session launched. Everything here comes with the hooks: its id
 * and type from SubagentStart, what it was launched to do from the session's
 * `Agent` call, its steps from the tool events that carry its id, and what it
 * said last from SubagentStop.
 */
export interface Subagent {
  id: string;
  /** `agent_type`: Explore, general-purpose, Plan… Empty when no event said. */
  type: string;
  /** What it was launched to do; null until an event names it. */
  description: string | null;
  /** The start of what it was asked, from the `Agent` call's prompt: what names it when nothing described it. */
  task: string | null;
  state: "running" | "done" | "failed";
  /** When it started — or, when its start went by unseen (`timed` is false), when the island first heard of it. */
  startedAt: number;
  /** Its start was seen — its SubagentStart, or the `Agent` call that launched it: how long it took can be said. */
  timed: boolean;
  endedAt: number | null;
  /** What it said last, once it has stopped. */
  result: string | null;
  /** Its own journal, capped like the session's. */
  steps: SessionStep[];
  /** No event gave it an id: it has one of the island's own, and no step can be told to be its. */
  anonymous: boolean;
  /** Tool events that came while it ran without saying whose they were, before any event of the session had. */
  strays: number;
  /** The turn it was launched in is over: the sidebar no longer lists it. */
  past: boolean;
  /** The model it runs on, when its launch said; never guessed. */
  model?: ModelInfo | null;
}

/** A model, as an event named it: its id, and a short name to show. */
export interface ModelInfo {
  id: string;
  label: string;
}

/** The families a model's id is read for, and how each is written. */
const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;
/** An id nothing is known of is shown as it is, this long at most. */
const MODEL_LABEL_CHARS = 18;

/**
 * A model's id as a short label: its family and, when the id says it, its
 * version — "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" →
 * "Haiku 4.5", "claude-3-5-sonnet-20241022" → "Sonnet 3.5". An id of no known
 * family is shown without its "claude-", cut short.
 */
export function modelLabel(id: string): string {
  const lower = id.trim().toLowerCase();
  const family = MODEL_FAMILIES.find((f) => lower.includes(f));
  if (!family) {
    const bare = id.trim().replace(/^claude-/i, "");
    return bare.length > MODEL_LABEL_CHARS ? `${bare.slice(0, MODEL_LABEL_CHARS - 1)}…` : bare;
  }
  const name = family[0].toUpperCase() + family.slice(1);
  // One or two short numbers beside the family's name, after it or before it: a date (eight digits) is not a version.
  const at = lower.indexOf(family);
  const after = lower.slice(at + family.length).match(/^[-_ .]?(\d{1,2})(?:[-_.](\d{1,2}))?(?!\d)/);
  const before = lower.slice(0, at).match(/(?<!\d)(\d{1,2})(?:[-_.](\d{1,2}))?[-_ .]?$/);
  const found = after ?? before;
  return found ? `${name} ${found[1]}${found[2] ? `.${found[2]}` : ""}` : name;
}

/**
 * A model as an event says it: an id, or `{ id, display_name }` (or
 * `displayName`). A name given wins over the one read from the id. Null when
 * the event names none: a model is never guessed.
 */
export function readModel(value: unknown): ModelInfo | null {
  if (typeof value === "string") return value.trim() ? { id: value.trim(), label: modelLabel(value) } : null;
  if (!value || typeof value !== "object") return null;
  const { id, display_name, displayName } = value as Record<string, unknown>;
  const given = [display_name, displayName].find((n): n is string => typeof n === "string" && n.trim() !== "")?.trim();
  const known = typeof id === "string" && id.trim() ? id.trim() : "";
  if (!known && !given) return null;
  return { id: known || given!, label: given ?? modelLabel(known) };
}

/** What a subagent is called when not even its kind is known. */
export const SUBAGENT_UNTYPED = "Subagent";
/** How much of an `Agent` call's prompt is kept to name a subagent by. */
const TASK_CHARS = 60;

/** The start of what a subagent was asked, in a line: the first one with words in it, cut short. */
export function taskStart(prompt: unknown): string | null {
  if (typeof prompt !== "string") return null;
  const line = prompt.split("\n").find((l) => l.trim())?.trim().replace(/\s+/g, " ") ?? "";
  if (!line) return null;
  return line.length > TASK_CHARS ? `${line.slice(0, TASK_CHARS - 1).trimEnd()}…` : line;
}

type Named = Pick<Subagent, "type" | "description" | "task">;

/** A subagent's kind: its type, or just that it is one. */
export const subagentKind = (agent: Pick<Subagent, "type">) => agent.type || SUBAGENT_UNTYPED;

/** What a subagent is at, beside its kind: what it was launched to do, or the start of what it was asked. Null when neither is known. */
export const subagentTask = (agent: Named) => agent.description ?? agent.task;

/**
 * A subagent in one name, the best there is: its description; else its kind
 * with the start of its task; else its kind; else "Subagent".
 */
export function subagentName(agent: Named): string {
  if (agent.description) return agent.description;
  return agent.task ? `${subagentKind(agent)}: ${agent.task}` : subagentKind(agent);
}

/** How long a subagent took, once it has stopped — null when its start was not seen: no time is made up for it. */
export function subagentTook(agent: Pick<Subagent, "startedAt" | "endedAt" | "timed">): number | null {
  return agent.timed && agent.endedAt != null ? Math.max(0, agent.endedAt - agent.startedAt) : null;
}

/**
 * A session at work that nothing was heard from for this long says so: Claude
 * Code may never have sent the Stop that closes its turn. Its state is left
 * alone — the next event clears it.
 */
export const QUIET_MS = 10 * 60_000;
export const QUIET_WORDS = "No activity for 10 min";
const CAN_GO_QUIET: ReadonlySet<BotStateName> = new Set<BotStateName>(["working", "thinking", "searching"]);

type Heard = Pick<ClaudeSession, "state" | "approval" | "question" | "heardAt">;

/** When a session at work will have been silent for too long; null for one that is not at work, or waits for the user. */
export function quietAt(session: Heard): number | null {
  if (!CAN_GO_QUIET.has(session.state) || session.approval || session.question || session.heardAt <= 0) return null;
  return session.heardAt + QUIET_MS;
}

export function isQuiet(session: Heard, now = Date.now()): boolean {
  const at = quietAt(session);
  return at != null && now >= at;
}

/** What a session is waiting on a human for, the request on its card first. */
export function requestsOf(session: ClaudeSession): SessionRequest[] {
  const head = session.approval ?? session.question;
  return head ? [head, ...session.queued] : [];
}

/** True while one of a subagent's requests waits for its answer. */
export const subagentAsks = (session: ClaudeSession, agent: Subagent) =>
  requestsOf(session).some((request) => request.agentId === agent.id);

/** How a subagent stands, the one thing to show first: waiting for the user comes before running. */
export function subagentStanding(session: ClaudeSession, agent: Subagent): "running" | "done" | "failed" | "asking" {
  return subagentAsks(session, agent) ? "asking" : agent.state;
}

/**
 * Whether a subagent's steps can be told from the session's own. They can when
 * tool events carry `agent_id`; on a version of Claude Code where they do not,
 * they all land in the main journal, and a subagent's view says so. Until one
 * event has said whose it is, a subagent with no step of its own while tools
 * ran that named nobody is taken to be in that case.
 */
export function stepsApart(session: ClaudeSession, agent: Subagent): boolean {
  if (agent.steps.length > 0 || session.attributed === true) return true;
  return session.attributed == null && !agent.anonymous && agent.strays === 0;
}

/**
 * The request on a session's card is done with: the one that has waited
 * longest behind it takes the card.
 */
export function nextRequest(session: ClaudeSession) {
  const next = session.queued.shift() ?? null;
  session.approval = next && !isQuestion(next) ? next : null;
  session.question = next && isQuestion(next) ? next : null;
  session.state = next ? (isQuestion(next) ? "question" : "approval") : "working";
}

/**
 * A Claude Code session the island knows of. There can be several at once —
 * two conversations in the Claude app, one more in a terminal — and one of
 * them is in front: the one the Claude pill, the cards and the panel show.
 */
export interface ClaudeSession {
  id: string;
  /** Which tool it belongs to. A Cursor session is followed for its status only: it never asks anything of the island. */
  agent: SessionAgent;
  /** Where it runs, as far as is known: each session has its own. */
  target: SessionTarget;
  /** The conversation's title, when Claude Code has given it one. */
  title: string | null;
  /** The folder it works in: by its name, and whole. */
  project: string;
  cwd: string | null;
  state: BotStateName;
  /** What it did, a line per step, oldest first: what a card falls back on. */
  lines: string[];
  /** Its journal, oldest first: what was asked, each tool, what Claude said; "Done" closes a turn. */
  steps: SessionStep[];
  /** What the user asked last, and what Claude said to end its turn. */
  asked: string | null;
  answer: string | null;
  /** When that answer came. */
  answeredAt: number;
  /** What it is waiting on a human for: a permission, or a question. One at a time on its card. */
  approval: ApprovalInfo | null;
  question: QuestionInfo | null;
  /**
   * The requests that came while that one was on the card — two subagents can
   * ask at once — the oldest first. Each has its own connection to the relay
   * and its own time to be answered in.
   */
  queued: SessionRequest[];
  /** The subagents it launched, in the order they started. */
  subagents: Subagent[];
  /** `Agent` calls no subagent has started for yet, the oldest first: the next to start are named by them. */
  launching: { step: SessionStep; type: string | null; description: string | null; task: string | null }[];
  /**
   * Its own turn has stopped while subagents it launched still run: it is at
   * work, not finished, until a Stop comes with none of them running.
   */
  parked: boolean;
  /**
   * What Claude said that the user was last told of — a sound, a card: a reply
   * given while subagents still run is told once, and the turn's real end
   * does not tell it again when nothing new was said since.
   */
  toldReply: string | null;
  /**
   * Whether tool events say which subagent they come from: true once one has,
   * false once it is plain they do not, null while neither is known.
   */
  attributed: boolean | null;
  /** What happened here while another session was in front, until it is looked at. */
  news: PillBadge | null;
  /** When it was last heard from. */
  heardAt: number;
  /** When its last turn really ended; 0 while none has. What the home view's fade counts from. */
  restedAt: number;
  /** That turn's result has not been looked at yet: it keeps a green mark on the home view, and stays there longer. */
  unseen: boolean;
  /**
   * A turn of its ended while the panel was being read (`core/reading.ts`), and
   * it was left alone: its line of the sidebar wears a mark until it is opened.
   */
  attention: boolean;
  /** How many such ends there have been: the panel wiggles once for each it has not yet shown. */
  nudges: number;
  /**
   * Its latest reply holds an `[!IMPORTANT]` alert that has not been read in
   * full yet: its line of the sidebar and its mini bot say "Needs your
   * decision". A mark and nothing more — no sound, no card, no pin. It goes
   * when that reply has been on show whole in the panel, and when the next
   * turn starts.
   */
  decision: boolean;
  /** The model it runs on, when an event of its said; never guessed. */
  model: ModelInfo | null;
  /**
   * How many tokens its last answer was given to read, as the relay counts them
   * in the transcript; null until one has been seen — no answer yet is not 0%.
   * Events that read no transcript leave it as it was. See `core/context.ts`.
   */
  contextTokens: number | null;
  /** The size of its context window, when its status line said it. */
  contextWindow: number | null;
}

/** What the mark of a reply that waits on a decision says. */
export const DECISION_WORDS = "Needs your decision";

/** What a session is called before its folder is known. */
export const SESSION_UNNAMED = "Session";

/** The tool a session runs in: its id, for Cursor, is `cursor:<conversation>` (set by the relay). */
export type SessionAgent = "claude" | "cursor" | "codex";

export function newSession(id: string, agent: SessionAgent = "claude"): ClaudeSession {
  return {
    id, agent, target: NO_TARGET, title: null, project: SESSION_UNNAMED, cwd: null, state: "idle",
    lines: [], steps: [], asked: null, answer: null, answeredAt: 0,
    approval: null, question: null, queued: [], subagents: [], launching: [], parked: false, toldReply: null, attributed: null,
    news: null, heardAt: 0, restedAt: 0, unseen: false, attention: false, nudges: 0, decision: false, model: null,
    contextTokens: null, contextWindow: null,
  };
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** The pill that follows Claude Code sessions. */
export const CLAUDE_ID = "integration_claude";

/** The built-in pills: the one that follows Claude Code. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task(CLAUDE_ID, CLIENT_UNKNOWN, "#F5F6F8", "claudeCode"),
];

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  screen: "primary" | "cursor";
  /** The edge of the display the island hangs from. */
  dock: Dock;
  autostart: boolean;
  hooksInstalled: boolean;
  /**
   * The two global shortcuts, as Rust reads them, and whether each is on: the
   * one that opens the session panel large from anywhere, or shrinks it
   * ("Ctrl+Alt+Space"), and the one that goes to the session that needs the
   * user ("Ctrl+Alt+Enter"). Changed only through `Bridge.setShortcut`, which
   * registers one before it saves it.
   */
  expandShortcut: string;
  expandShortcutEnabled: boolean;
  gotoShortcut: string;
  gotoShortcutEnabled: boolean;
  panelShortcut: string;
  panelShortcutEnabled: boolean;
  hideShortcut: string;
  hideShortcutEnabled: boolean;
  /** The agents list's: shows it or hides it. Only registered while showAgentsList is on. */
  agentsShortcut: string;
  agentsShortcutEnabled: boolean;
  /** Settings → General → Agents list: the small always-on-top window with a row per project. Off until asked for. */
  showAgentsList: boolean;
  /** Where the list was left, in physical pixels: Rust's to write, never the page's. */
  agentsListX: number | null;
  agentsListY: number | null;
  /** How wide the list was made, in logical pixels; null until it was. Rust's, as the edge is dragged. */
  agentsListW: number | null;
  /** The most the list may be tall, in logical pixels; null until the bottom edge was dragged (then 520). Rust's too. */
  agentsListH: number | null;
  /** The list fades to `agentsListFadeOpacity` percent while the pointer is away and nothing needs the user. */
  agentsListFade: boolean;
  agentsListFadeOpacity: number;
  /**
   * What the folded island shows beside its session dots: at most three of
   * `COMPACT_METRICS`, in the order they are drawn. Picked in the settings window.
   */
  compactMetrics: string[];
  // ── Picked in the settings window (src/settings) ──
  /** The settings window's colours. The island is dark whatever this says. */
  theme: "light" | "dark" | "system";
  /** "system" follows the OS; "on": nothing travels or fades; "off": full motion. */
  reduceMotion: "system" | "on" | "off";
  /** The bot's colours: a key of bot/engine.ts `BOT_THEMES`. */
  botTheme: string;
  /** Gullu reacts to the mouse and to clicks (bot/reactions.ts). Off: the status faces, and nothing else. */
  playfulReactions: boolean;
  /** The Shelf's widgets, all six, in their order; and the ones switched off. */
  shelfOrder: string[];
  shelfHidden: string[];
  // ── Settings → Island → Visibility ──
  /** The folded island hides after this many seconds left alone: one of `FOLDED_AUTO_HIDE`. 0 is never. */
  foldedAutoHide: number;
  /** While a session is working, thinking or asking, the folded island does not hide: the time starts once none is. */
  hideOnlyWhenIdle: boolean;
  /** With a full-screen app in front on its display the island stays hidden — but for a request, which always shows. */
  hideInFullscreen: boolean;
  /** Cursor's agent sessions are shown beside Claude Code's (Settings → Cursor). */
  showCursorSessions: boolean;
  /** Settings → Codex: Codex's sessions are shown beside Claude Code's. */
  showCodexSessions: boolean;
  /** Settings → About: once a day, ask GitHub whether a newer Nook is out. Off unless the user switches it on. */
  checkUpdates: boolean;
}

/** The choices of "Auto-hide the folded island after", in seconds; 0 is "never". 60 is what it always was. */
export const FOLDED_AUTO_HIDE = [5, 10, 30, 60, 0] as const;
export const DEFAULT_FOLDED_AUTO_HIDE = 60;

/** The delay as the island uses it: one of the choices, or the default for anything else. */
export function foldedAutoHide(settings: Pick<Settings, "foldedAutoHide">): number {
  const said = Number(settings.foldedAutoHide);
  return (FOLDED_AUTO_HIDE as readonly number[]).includes(said) ? said : DEFAULT_FOLDED_AUTO_HIDE;
}

/** What a cell of the folded island can show. */
export const COMPACT_METRICS = ["cpu", "gpu", "ram", "usage5h", "usage7d", "waiting"] as const;
export type CompactMetric = (typeof COMPACT_METRICS)[number];
/** Cells the folded island has room for. */
export const MAX_COMPACT_METRICS = 3;

/** The cells picked, as far as they are ones the island knows: each once, three at most. */
export function compactMetrics(settings: Pick<Settings, "compactMetrics">): CompactMetric[] {
  const picked = Array.isArray(settings.compactMetrics) ? settings.compactMetrics : [];
  const known = picked.filter((m): m is CompactMetric => (COMPACT_METRICS as readonly string[]).includes(m));
  return [...new Set(known)].slice(0, MAX_COMPACT_METRICS);
}

/**
 * The machine, as Rust samples it every 2.5 s while the island is on show (the
 * `metrics` event). `cpu` is a percentage, and null until the first real sample
 * after each wake: it takes two readings to make one. `gpu` is one too — the
 * busiest graphics adapter's — and null as well on a machine that does not
 * report it. RAM is in bytes.
 */
export interface Metrics {
  cpu: number | null;
  gpu: number | null;
  ramUsed: number;
  ramTotal: number;
  /** Which of the two is the sample before's, kept because this one could not say (`keepKnown`). */
  kept?: { cpu: boolean; gpu: boolean };
}

/** One window of Claude's usage limits: how much of it is used, and when it starts again (Unix ms). */
export interface UsageWindow {
  usedPercent: number;
  resetsAt: number;
}

/** Claude's usage limits, as Claude Code last reported them (the `usage` event). */
export interface Usage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  updatedAt: number;
}

/**
 * Usage is only as new as Claude Code's last request: it is not dimmed for
 * being a few minutes old. Older than this, it is — and a window whose reset
 * time has passed is, at once, whatever its age.
 */
export const USAGE_OLD_MS = 2 * 60 * 60_000;

/** What a window says once its reset time has passed, until Claude Code reports again. */
export const USAGE_RESET_WORDS = "reset, waiting for new data";
/** Why the numbers are as old as they are: the tooltip of the usage block, and of a usage cell. */
export const USAGE_SOURCE_WORDS =
  "Usage only updates while Claude Code runs. Usage from claude.ai and the desktop app counts toward the same limits but isn't visible to Nook.";

/** "resets in 2h 14m", "resets in 3d 4h", "resets in 14m", "resets in <1m": how long until a window starts again. */
export function resetCountdown(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "resets in <1m";
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * A usage window as it is shown: "fresh" — the number Claude Code last gave;
 * "old" — the same, from more than `USAGE_OLD_MS` ago, dimmed; "reset" — its
 * reset time has passed, so that number is of a window that is over: 0 %,
 * dimmed, until new data comes.
 */
export type UsageState = "fresh" | "old" | "reset";

export interface UsageShown {
  /** Whole percent; 0 once the window has reset. */
  percent: number;
  state: UsageState;
  /** "resets in 2h 14m" — or the reset's words; empty when the window never said when it resets. */
  countdown: string;
}

/** What a window shows now: from what was last reported, and the time. Nothing here asks anybody anything. */
export function usageShown(win: UsageWindow | null | undefined, updatedAt: number, now: number): UsageShown | null {
  if (!win) return null;
  if (win.resetsAt > 0 && now >= win.resetsAt) return { percent: 0, state: "reset", countdown: USAGE_RESET_WORDS };
  return {
    percent: Math.round(win.usedPercent),
    state: now - updatedAt > USAGE_OLD_MS ? "old" : "fresh",
    countdown: win.resetsAt > 0 ? resetCountdown(win.resetsAt - now) : "",
  };
}

/** The next moment a window's reset passes (Unix ms), or null: when what is shown changes with nobody saying so. */
export function nextUsageReset(usage: Usage | null, now: number): number | null {
  const times = [usage?.fiveHour?.resetsAt, usage?.sevenDay?.resetsAt].filter((at): at is number => at != null && at > now);
  return times.length ? Math.min(...times) : null;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A `metrics` payload, if it is one. */
export function readMetrics(value: unknown): Metrics | null {
  if (!value || typeof value !== "object") return null;
  const { cpu, gpu, ramUsed, ramTotal } = value as Record<string, unknown>;
  if (!finite(ramUsed) || !finite(ramTotal)) return null;
  const percent = (v: unknown) => (finite(v) ? Math.max(0, Math.min(100, v)) : null);
  return { cpu: percent(cpu), gpu: percent(gpu), ramUsed: Math.max(0, ramUsed), ramTotal: Math.max(0, ramTotal) };
}

/**
 * A new sample, with what the one before knew and this one cannot say yet.
 * Processor and graphics use take two readings, so the first sample after
 * every wake of the island has neither: the last numbers known stay in their
 * cells for those 2.5 s rather than going blank, and "—" is only ever shown
 * before the very first reading. The memory is always the new sample's.
 */
export function keepKnown(before: Metrics | null, next: Metrics): Metrics {
  if (!before) return next;
  // Once only: a number that is still missing on the sample after is not known any more.
  const cpu = next.cpu == null && before.cpu != null && !before.kept?.cpu;
  const gpu = next.gpu == null && before.gpu != null && !before.kept?.gpu;
  if (!cpu && !gpu) return next;
  return { ...next, cpu: cpu ? before.cpu : next.cpu, gpu: gpu ? before.gpu : next.gpu, kept: { cpu, gpu } };
}

/** Memory in use as a share of what is installed, 0–100; null while nothing is known. */
export function ramPercent(m: Metrics | null): number | null {
  return m && m.ramTotal > 0 ? Math.min(100, (m.ramUsed / m.ramTotal) * 100) : null;
}

/** "11.2 of 16.0 GB": the figures behind the percentage, for a tooltip. Whole numbers past 100 GB. */
export function ramWords(m: Metrics | null): string {
  if (!m || m.ramTotal <= 0) return "";
  const GB = 1024 ** 3;
  const digits = m.ramTotal / GB >= 100 ? 0 : 1;
  return `${(m.ramUsed / GB).toFixed(digits)} of ${(m.ramTotal / GB).toFixed(digits)} GB`;
}

/** How much of a usage window is gone, as it is coloured: calm under 60 %, warm to 85 %, hot past it. */
export type UsageLevel = "calm" | "warm" | "hot";
export const usageLevel = (percent: number): UsageLevel => (percent > 85 ? "hot" : percent >= 60 ? "warm" : "calm");

function readWindow(value: unknown): UsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const { usedPercent, resetsAt } = value as Record<string, unknown>;
  if (!finite(usedPercent)) return null;
  return { usedPercent: Math.max(0, Math.min(100, usedPercent)), resetsAt: finite(resetsAt) ? resetsAt : 0 };
}

/** A `usage` payload, if it is one with something in it. */
export function readUsage(value: unknown): Usage | null {
  if (!value || typeof value !== "object") return null;
  const { fiveHour, sevenDay, updatedAt } = value as Record<string, unknown>;
  const usage: Usage = { fiveHour: readWindow(fiveHour), sevenDay: readWindow(sevenDay), updatedAt: finite(updatedAt) ? updatedAt : Date.now() };
  return usage.fiveHour || usage.sevenDay ? usage : null;
}

/**
 * The global shortcuts out of the box. Neither is Ctrl+Alt with a letter: on
 * many keyboard layouts Ctrl+Alt is AltGr, which types a character with one.
 */
export const DEFAULT_EXPAND_SHORTCUT = "Ctrl+Alt+Space";
export const DEFAULT_GOTO_SHORTCUT = "Ctrl+Alt+Enter";
export const DEFAULT_PANEL_SHORTCUT = "Ctrl+Shift+Space";
/** The idle opacity of the agents list, in percent: the least and most the setting can be (settings.rs holds the same). */
export const FADE_MIN = 20;
export const FADE_MAX = 90;
export const DEFAULT_HIDE_SHORTCUT = "Ctrl+Alt+N";
export const DEFAULT_AGENTS_SHORTCUT = "Ctrl+Shift+L";

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  screen: "primary",
  dock: "top",
  autostart: false,
  hooksInstalled: false,
  expandShortcut: DEFAULT_EXPAND_SHORTCUT,
  expandShortcutEnabled: true,
  gotoShortcut: DEFAULT_GOTO_SHORTCUT,
  gotoShortcutEnabled: true,
  panelShortcut: DEFAULT_PANEL_SHORTCUT,
  panelShortcutEnabled: true,
  hideShortcut: DEFAULT_HIDE_SHORTCUT,
  hideShortcutEnabled: true,
  agentsShortcut: DEFAULT_AGENTS_SHORTCUT,
  agentsShortcutEnabled: true,
  showAgentsList: false,
  agentsListX: null,
  agentsListY: null,
  agentsListW: null,
  agentsListH: null,
  agentsListFade: true,
  agentsListFadeOpacity: 50,
  compactMetrics: ["cpu", "ram", "usage5h"],
  theme: "system",
  reduceMotion: "system",
  botTheme: "cream",
  playfulReactions: true,
  shelfOrder: ["media", "todo", "timer", "reminders", "mirror", "projects"],
  shelfHidden: [],
  foldedAutoHide: DEFAULT_FOLDED_AUTO_HIDE,
  hideOnlyWhenIdle: false,
  hideInFullscreen: true,
  showCursorSessions: true,
  showCodexSessions: true,
  checkUpdates: false,
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;
  /** The session panel is at its large size. Only ever while it is the view on show. */
  large = false;

  /** Every session the island knows of, in the order they were first heard. */
  sessions: ClaudeSession[] = [];
  /** The session in front; empty when there is none. */
  frontId = "";
  /** What stands for the session in front while there is none. */
  private readonly noSession = newSession("");
  /** What each session changed, by session id. */
  changes = new Map<string, ChangedFile[]>();

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  /** The machine's last sample; null until one has come. */
  metrics: Metrics | null = null;
  /** Claude's usage limits; null while none has ever arrived. */
  usage: Usage | null = null;
  /**
   * Whether usage limits are switched on in Settings (Claude Code's status
   * line relays them): null while nothing has said. Only words the reason
   * given when no usage has arrived.
   */
  usageInstalled: boolean | null = null;

  private listeners = new Set<Listener>();
  private gaugeListeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Told of a new sample of the machine, or of new usage — and of nothing
   * else. Apart from `subscribe` on purpose: a number that changes every 2.5 s
   * is written where it shows, and must not wake the island's frame loop.
   */
  onGauges(fn: Listener): () => void {
    this.gaugeListeners.add(fn);
    return () => this.gaugeListeners.delete(fn);
  }

  /** A sample of the machine came. */
  setMetrics(metrics: Metrics) {
    this.metrics = keepKnown(this.metrics, metrics);
    for (const fn of this.gaugeListeners) fn();
  }

  /** Claude's usage limits came, or — null — none is known. */
  setUsage(usage: Usage | null) {
    this.usage = usage;
    for (const fn of this.gaugeListeners) fn();
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  /** The session in front: the one the Claude pill, the cards and the panel show. */
  get session(): ClaudeSession {
    return this.sessions.find((s) => s.id === this.frontId) ?? this.noSession;
  }

  /** What the session in front is waiting on a human for. */
  get pendingApproval(): ApprovalInfo | null {
    return this.session.approval;
  }

  get pendingQuestion(): QuestionInfo | null {
    return this.session.question;
  }

  /** The other sessions waiting on a human, the one that has waited longest first. */
  get waiting(): ClaudeSession[] {
    return this.sessions.filter((s) => s.id !== this.frontId && (s.approval != null || s.question != null));
  }

  /**
   * Puts a session in front. The one it takes the place of keeps going where
   * it runs; if it was waiting for an answer, its tab says so.
   */
  bringForward(id: string) {
    const from = this.session;
    if (from.id && from.id !== id && (from.approval || from.question)) from.news = "approval";
    this.frontId = id;
    this.session.news = null;
    this.session.attention = false;
    this.present();
  }

  /** The Claude pill wears the session in front: its project, its state, its steps. */
  present() {
    const t = this.tasks.find((x) => x.id === CLAUDE_ID);
    if (!t) return;
    const s = this.session;
    t.name = s.id ? s.project : this.clientName;
    t.state = s.state;
    t.steps = s.lines;
    t.stepIndex = Math.max(0, s.lines.length - 1);
    t.sessionCwd = s.cwd;
    this.notify();
  }

  /** The Claude pill's name, and where an answer is sent back to: the app the session in front runs in. */
  get clientName(): string {
    return this.session.target.label || CLIENT_UNKNOWN;
  }

  /** The files the session being followed has changed, the last touched first. */
  get sessionFiles(): ChangedFile[] {
    return this.changes.get(this.session.id) ?? [];
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** Puts the Claude pill in place, first: the agent_* pills come after it. */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      if (!this.tasks.some((t) => t.id === proto.id)) this.tasks.unshift({ ...proto, steps: [] });
    }
    if (!this.focusId) this.focusId = "integration_claude";
    this.notify();
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? "integration_claude";
    this.notify();
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
