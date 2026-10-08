// A reply to a session at rest, typed in the island.
//
// It goes where the session runs (src-tauri/src/reply_here.rs): typed into its
// terminal and sent, or put in the prompt of its editor's Claude Code panel.
// The conversation carries on in the window it was started in. Where that
// window cannot be found there is no box to type in; and a reply Nook cannot
// be sure of the place for — another tab is showing — is not sent anywhere:
// what was typed stays in the box, with the reason.
//
// Kept here, per session: what is being typed (a draft outlives a redraw, a
// fold, another session coming in front), whether its window was there when
// last looked for, and why the last reply could not be sent.
import { Bridge, IS_TAURI, type ReplyEnded, type ReplyTool } from "./bridge";
import { State, type ClaudeSession } from "./state";

/** The longest a reply may be: Rust refuses a longer one. */
export const MAX_REPLY_CHARS = 8000;

/** No turn under way: the states a reply can be typed in. */
const AT_REST: ReadonlySet<string> = new Set(["idle", "finished", "error", "sleeping"]);
/** A session id Rust takes: the tool's own, never the island's placeholder for a session without one. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CODEX_PREFIX = "codex:";

/** How long what was found of a session's window is believed before it is looked for again. */
const REACH_FRESH_MS = 4000;
/** Whether each session's own window was there, and when that was asked. */
const reach = new Map<string, { there: boolean; at: number; asking: boolean }>();
const drafts = new Map<string, string>();
/** The sessions a reply of ours is running for. */
const running = new Set<string>();
const errors = new Map<string, string>();
const notes = new Map<string, string>();
const background = new Map<string, string>();
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
  /**
   * The session's own window is there to take a reply. What was last found is
   * said at once, and looked for again when it is a few seconds old: the island
   * is told when the answer has changed. Outside the app — a preview page, the
   * screenshot stage — every window is taken to be there.
   */
  reachable(session: ClaudeSession): boolean {
    if (!IS_TAURI) return true;
    const id = session.id;
    const known = reach.get(id) ?? { there: false, at: 0, asking: false };
    reach.set(id, known);
    if (!known.asking && Date.now() - known.at > REACH_FRESH_MS) {
      known.asking = true;
      void Bridge.sessionReplyReachable(id).then((there) => {
        const changed = known.there !== (there === true);
        Object.assign(known, { there: there === true, at: Date.now(), asking: false });
        if (changed) State.notify();
      });
    }
    return known.there;
  },

  /** A reply can reach this session: its tool takes one, it has an id of its own, and its window is there. */
  offered(session: ClaudeSession): boolean {
    return toolOf(session) != null && SESSION_ID.test(rawId(session)) && Reply.reachable(session);
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
  /** Something to know about the last reply that is no error: where it was put, and what is left to do. */
  note: (session: ClaudeSession) => notes.get(session.id) ?? null,
  /** Why the reply under way runs in the background and not in the session's window: Rust's own sentence, or "". */
  background: (session: ClaudeSession) => background.get(session.id) ?? "",
  draft: (session: ClaudeSession) => drafts.get(session.id) ?? "",
  setDraft(session: ClaudeSession, text: string) {
    if (text) drafts.set(session.id, text);
    else drafts.delete(session.id);
    // Typing again is the answer to an error, or to a note: it goes.
    errors.delete(session.id);
    notes.delete(session.id);
  },

  /** Sends what was typed, in the session's own window. True once it is there; the draft is kept when it is not. */
  async send(session: ClaudeSession, typed: string): Promise<boolean> {
    const text = typed.trim();
    if (!text || !Reply.open(session)) return false;
    const id = session.id;
    running.add(id);
    errors.delete(id);
    notes.delete(id);
    State.notify();
    try {
      const place = await Bridge.sessionReplyHere(id, session.title ?? null, text.slice(0, MAX_REPLY_CHARS));
      if (place === "interrupted") {
        notes.set(id, "You changed windows while Nook was typing. Part of your reply is in the terminal, and it was not sent.");
        return false;
      }
      drafts.delete(id);
      if (place === "prefilled") notes.set(id, `Your reply is in ${session.target?.label || "the editor"}'s Claude prompt. Press Enter there to send it.`);
      return true;
    } catch (err) {
      // Rust refused with nothing typed anywhere: said, and what was typed stays to send again.
      errors.set(id, `${words(err)} Your reply was not sent.`);
      // Its window may be gone: looked for again at once.
      reach.delete(id);
      return false;
    } finally {
      running.delete(id);
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
    background.delete(id);
    const byHand = stopped.delete(id);
    if (ok !== true && !byHand) errors.set(id, typeof error === "string" && error.trim() ? error.trim() : "The reply could not be sent.");
    // A run that ended without its session saying so (stopped, or failed before its first event): at rest again.
    const session = State.sessions.find((s) => s.id === id);
    if (session && !AT_REST.has(session.state) && subagentsGoing(session) === 0 && session.approval == null && session.question == null && (ok !== true || byHand)) session.state = "idle";
    State.notify();
  },
};
