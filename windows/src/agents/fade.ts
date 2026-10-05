// When the agents list fades: a plain function of what is known, so the page has
// only to say what it sees and to set one timer. It fades once nothing has asked
// for the user's eyes for FADE_AFTER_MS; it never fades while the pointer is on
// it, an edge is held, or a row waits for the user.

/** How long the list is left alone before it dims. */
export const FADE_AFTER_MS = 3000;

export interface FadeInput {
  /** The setting: off means always at full strength. */
  enabled: boolean;
  /** The pointer is over the window, edges included. */
  inside: boolean;
  /** An edge or the header is held. */
  held: boolean;
  /** Some row is waiting for the user. */
  waiting: boolean;
  /** The last time anything asked for a look: shown, the pointer leaving, an edge let go, a row changing status. */
  calmSince: number;
  now: number;
}

export interface Fade {
  faded: boolean;
  /** When it is not faded yet but will be, if nothing happens: the wait in ms. Null when only an event can change it. */
  recheckIn: number | null;
}

export function fadeOf({ enabled, inside, held, waiting, calmSince, now }: FadeInput): Fade {
  if (!enabled || inside || held || waiting) return { faded: false, recheckIn: null };
  const left = FADE_AFTER_MS - (now - calmSince);
  return left <= 0 ? { faded: true, recheckIn: null } : { faded: false, recheckIn: left };
}
