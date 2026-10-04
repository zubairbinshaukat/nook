// Shelf preview — one tab per two-finger swipe (plans/tabs-plan.md §1).
//
// A trackpad swipe arrives as a run of `wheel` events with a horizontal delta,
// and keeps arriving after the fingers lift (momentum). The detector adds the
// deltas up; past the threshold it fires once, then ignores everything for the
// cooldown, so one gesture moves one tab.

export type SwipeVerdict =
  | "idle"
  | "vertical: ignored"
  | "cooldown: ignored"
  | "scrolled the row"
  | "accumulating"
  | "fired";

/** A pause this long between two wheel events starts a new gesture. */
const GESTURE_GAP_MS = 180;

export class SwipeDetector {
  threshold = 60;
  cooldownMs = 450;

  /** Horizontal travel added up so far, signed: positive is "to the next tab". */
  acc = 0;
  coolUntil = 0;
  verdict: SwipeVerdict = "idle";
  private lastAt = 0;

  cooling(now = performance.now()): boolean {
    return now < this.coolUntil;
  }

  /**
   * One wheel event. `consume` is given the delta first and says whether it
   * used it (the Shelf's row scrolling): only what nobody used counts towards
   * a tab switch. Returns +1 (next) or -1 (previous) when a switch fires.
   */
  feed(dx: number, dy: number, now: number, consume?: (dx: number) => boolean): -1 | 0 | 1 {
    if (Math.abs(dx) <= Math.abs(dy)) {
      this.verdict = "vertical: ignored";
      return 0;
    }
    if (now < this.coolUntil) {
      this.verdict = "cooldown: ignored";
      return 0;
    }
    if (now - this.lastAt > GESTURE_GAP_MS) this.acc = 0;
    this.lastAt = now;

    if (consume?.(dx)) {
      this.acc = 0;
      this.verdict = "scrolled the row";
      return 0;
    }
    if (Math.sign(dx) !== Math.sign(this.acc)) this.acc = 0;
    this.acc += dx;
    if (Math.abs(this.acc) < this.threshold) {
      this.verdict = "accumulating";
      return 0;
    }
    const dir = this.acc > 0 ? 1 : -1;
    this.acc = 0;
    this.coolUntil = now + this.cooldownMs;
    this.verdict = "fired";
    return dir;
  }
}
