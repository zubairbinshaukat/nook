// A reply to a session at rest, typed in the island.
//
// The session's own command line continues the conversation in the background
// (src-tauri/src/reply.rs: `claude -p --resume <id>`, the text on its stdin).
// Its hooks fire as for any turn, so the island follows the run like any
// other — and the window the session was started in does not show it.
//
// Kept here, per session: what is being typed (a draft outlives a redraw, a
// fold, another session coming in front), whether a reply of ours is running,
// and why the last one could not be sent.

import { Bridge, IS_TAURI, type ReplyEnded, type ReplyTool, type ReplyTools } from "./bridge";
import { State, type ClaudeSession } from "./state";

/** The longest a reply may be: Rust refuses a longer one. */
export const MAX_REPLY_CHARS = 8000;

/** No turn under way: the states a reply can be typed in. */
const AT_REST: ReadonlySet<string> = new Set(["idle", "finished", "error", "sleeping"]);
/** A session id Rust takes: the tool's own, never the island's placeholder for a session without one. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CODEX_PREFIX = "codex:";

/** Which command lines are there. Outside the app — a preview page, the screenshot stage — both are taken to be. */
const tools: ReplyTools = { claude: !IS_TAURI, codex: !IS_TAURI };
const drafts = new Map<string, string>();
/** The sessions a reply of ours is running for. */
const running = new Set<string>();
const errors = new Map<string, string>();
/** Runs stopped from the island: their end is no error. */
const stopped = new Set<string>();

const subagentsGoing = (session: ClaudeSession) => session.subagents.filter((agent) => agent.state === "running").length;
/** No turn of the session's own is under way: at rest, or it has replied while its subagents go on (`parked`). */
const turnOver = (session: ClaudeSession) => AT_REST.has(session.state) || (session.parked && subagentsGoing(session) > 0);

const toolOf =(session: ClaudeSession): ReplyTool | null => (session.agent === "claude" || session.agent === "codex" ? session.agent : null);
/** The session's id as its tool knows it. */
const rawId = (session: ClaudeSession) => (session.agent === "codex" && session.id.startsWith(CODEX_PREFIX) ? session.id.slice(CODEX_PREFIX.length) : session.id);
const words = (err: unknown) => (err instanceof Error ? err.message : String(err ?? "")).trim() || "The reply could not be sent.";

export const Reply = {
  /** Asked once, when the island starts: which command lines are there. */
  async load() {
    const found = await Bridge.replyTools();
    if (!found) return;
    tools.claude = found.claude === true;
    tools.codex = found.codex === true;
    State.notify();
  },

  /** A reply can reach this session at all: its tool takes one, its command line is there, and it says where it runs. */
  offered(session: ClaudeSession): boolean {
    const tool = toolOf(session);
    return tool != null && tools[tool] && !!session.cwd && SESSION_ID.test(rawId(session));
  },

  /** The field is there: the session's turn is over, it asks nothing, and no reply of ours is on its way. */
  open(session: ClaudeSession): boolean {
    return Reply.offered(session)
      && turnOver(session)
      && session.approval == null && session.question == null
      && !running.has(session.id);
  },

  /**
   * What to know before sending, or null: the session has replied but its
   * subagents are still at work, and a reply starts a new turn beside them.
   */
  warning(session: ClaudeSession): string | null {
    const going = subagentsGoing(session);
    if (going === 0) return null;
    return `${going === 1 ? "A subagent is" : `${going} subagents are`} still running. Your reply starts a new turn now, and may cross with what ${going === 1 ? "it reports" : "they report"}.`;
  },

  /** A reply of ours is running for this session. */
  running: (session: ClaudeSession) => running.has(session.id),
  /** …and the session has not been heard from since: it is still on its way. */
  starting: (session: ClaudeSession) => running.has(session.id) && turnOver(session),
  /** An event of a run a reply started: never taken for an automated session's. */
  isOurs: (sessionId: string | undefined) => sessionId != null && running.has(sessionId),

  error: (session: ClaudeSession) => errors.get(session.id) ?? null,
  draft: (session: ClaudeSession) => drafts.get(session.id) ?? "",
  setDraft(session: ClaudeSession, text: string) {
    if (text) drafts.set(session.id, text);
    else drafts.delete(session.id);
    // Typing again is the answer to an error: it goes.
    errors.delete(session.id);
  },

  /** Sends what was typed. True once the run has started; the draft is kept when it could not. */
  async send(session: ClaudeSession, typed: string): Promise<boolean> {
    const tool = toolOf(session);
    const text = typed.trim();
    if (!tool || !text || !session.cwd || !Reply.open(session)) return false;
    const id = session.id;
    running.add(id);
    errors.delete(id);
    State.notify();
    try {
      await Bridge.sessionReply(tool, rawId(session), session.cwd, text.slice(0, MAX_REPLY_CHARS));
      drafts.delete(id);
      return true;
    } catch (err) {
      running.delete(id);
      errors.set(id, words(err));
      return false;
    } finally {
      State.notify();
    }
  },

  /** Stops the run a reply started. Its end comes back as `ended`, and is no error. */
  stop(session: ClaudeSession) {
    const tool = toolOf(session);
    if (!tool || !running.has(session.id)) return;
    stopped.add(session.id);
    void Bridge.sessionReplyCancel(tool, rawId(session));
  },

  /** The `reply_ended` event. */
  ended(value: unknown) {
    if (!value || typeof value !== "object") return;
    const { tool, sessionId, ok, error } = value as Partial<ReplyEnded>;
    if (typeof sessionId !== "string") return;
    const id = tool === "codex" ? `${CODEX_PREFIX}${sessionId}` : sessionId;
    running.delete(id);
    const byHand = stopped.delete(id);
    if (ok !== true && !byHand) errors.set(id, typeof error === "string" && error.trim() ? error.trim() : "The reply could not be sent.");
    // A run that ended without its session saying so (stopped, or failed before its first event): at rest again.
    const session = State.sessions.find((s) => s.id === id);
    if (session && !AT_REST.has(session.state) && subagentsGoing(session) === 0 && session.approval == null && session.question == null && (ok !== true || byHand)) session.state = "idle";
    State.notify();
  },
};
