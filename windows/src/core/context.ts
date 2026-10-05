// How full a session's context window is: a number of tokens, read by the
// relay from the end of the session's transcript (the last answer of the main
// conversation, hook/src/main.rs), over the size of the window.
//
// The size is the one thing a transcript does not say, so it comes, best first,
// from: what Claude Code's status line reports (`context_window_size`, exact —
// only when Nook is installed as the status line); a model id that names the
// 1M variant (`[1m]`); the tokens themselves — a context holds more than 200k
// only in a 1M window; and 200k otherwise. Without the status line, a session
// in a 1M window with no `[1m]` in its id reads five times too full until it
// passes 200k, because below that it cannot be told from a 200k one.

const WINDOW = 200_000;
const WINDOW_1M = 1_000_000;
/** Green below the first, amber below the second, red from there. */
const AMBER_AT = 60;
const RED_AT = 85;

export type ContextLevel = "ok" | "warn" | "full";

export interface ContextUse {
  /** 0 to 100, whole. */
  percent: number;
  level: ContextLevel;
}

/** The window a session's tokens fill. */
export function contextWindowOf(tokens: number, reported: number | null, modelId: string | undefined): number {
  // The reported size is exact: never second-guessed. Only a guess is widened to 1M.
  if (reported != null && reported > 0) return reported;
  const window = modelId && /\[1m\]|-1m\b/i.test(modelId) ? WINDOW_1M : WINDOW;
  return tokens > window ? Math.max(window, WINDOW_1M) : window;
}

export function contextLevel(percent: number): ContextLevel {
  return percent >= RED_AT ? "full" : percent >= AMBER_AT ? "warn" : "ok";
}

/** What the meter shows; null — no meter — until an answer has been counted. */
export function contextUse(tokens: number | null, reported: number | null, modelId?: string): ContextUse | null {
  if (tokens == null || !Number.isFinite(tokens) || tokens <= 0) return null;
  const percent = Math.min(100, Math.round((tokens / contextWindowOf(tokens, reported, modelId)) * 100));
  return { percent, level: contextLevel(percent) };
}
