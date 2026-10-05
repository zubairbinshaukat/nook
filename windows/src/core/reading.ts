// Whether someone is reading the session panel, so that a turn's end does not
// take it from under them (hooks.ts `tell`, views/session.ts).
//
// A reader is one who scrolled up from the journal's end, or who touched the
// panel — wheel, key, pointer — in the last few seconds. The clock is a
// parameter so that it can be run without waiting.

/** Input this recent says the panel is being read. */
export const READING_MS = 10_000;

export interface Reading {
  /** The panel was touched: wheel, key, pointer. */
  touch(): void;
  /** Whether the journal is scrolled away from its end. */
  away: boolean;
  /** Touched within `READING_MS`. */
  active(): boolean;
  /** Away from the end, or touched within `READING_MS`. */
  reading(): boolean;
}

export function createReading(now: () => number = Date.now): Reading {
  let last = -Infinity;
  return {
    away: false,
    touch() {
      last = now();
    },
    active() {
      return now() - last < READING_MS;
    },
    reading() {
      return this.away || this.active();
    },
  };
}

/** The one the app shares: the session panel feeds it, the hooks ask it. */
export const Reader = createReading();
