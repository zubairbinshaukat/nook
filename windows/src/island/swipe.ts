// Paging between the island's two tabs, as a trackpad does it everywhere else
// (plans/tabs-plan.md §1). No DOM: it is fed the horizontal travel of each wheel
// event and says where the page is under the fingers, and, when they let go,
// where it should settle.
//
// While the fingers are down the page follows them 1:1 (`drag`). A gesture ends
// when no event has come for SWIPE_RELEASE_MS, or when the events have begun to
// decay (momentum: the fingers have lifted). The decision is then one of: page
// (a fast flick, or past a share of the width), snap back, or rubber-band (the
// push was past an edge). What follows the decision — the decaying tail of the
// momentum — is let go by (`ignore`) until it stops or a new push clearly begins.
//
// A gesture does one thing: one that scrolled a row (the Shelf's) never pages;
// a new gesture begun with the row at its edge does.

/** No wheel event for this long: the fingers are up, the gesture is over. */
export const SWIPE_RELEASE_MS = 80;
/** After a release, events keep being let go until they have stopped for this long. */
export const SWIPE_TAIL_END_MS = 120;
/** Within this long of a release, any event the same way that is smaller than the gesture's peak is tail. */
export const SWIPE_TAIL_STRICT_MS = 300;
/** Velocity, px/ms over the last SWIPE_FLICK_WINDOW_MS, above which a swipe is a flick and pages. */
export const SWIPE_FLICK_PX_MS = 0.6;
export const SWIPE_FLICK_WINDOW_MS = 60;
/** A flick must have moved at least this far (a twitch is not one). */
export const SWIPE_FLICK_MIN_PX = 16;
/** Dragged past this share of the island's width, a swipe pages however slow. */
export const SWIPE_PAGE_SHARE = 0.35;
/** Past an edge with no tab: the page moves by this share of the push, to at most SWIPE_RUBBER_MAX_PX. */
export const SWIPE_RUBBER = 0.3;
export const SWIPE_RUBBER_MAX_PX = 40;
/** Events that keep shrinking, this many in a row and under this share of the peak, are momentum: release. */
export const SWIPE_DECAY_EVENTS = 4;
export const SWIPE_DECAY_BELOW = 0.7;
/** Momentum is only looked for in a gesture whose peak event was at least this big (px). */
export const SWIPE_DECAY_MIN_PEAK = 6;
/** A tail event this much bigger than the one before it (plus a little slack) is a new push. */
export const SWIPE_RISE = 1.5;
export const SWIPE_RISE_SLACK = 2;
/** The Shelf's row comes to rest on a card this long after the events that moved it have paused. */
export const ROW_SETTLE_MS = 180;

/**
 * A new push inside a tail: this many events in a row, each bigger than the one
 * before, and at least `SWIPE_NEW_PUSH_GROWTH` times the quietest the tail has been.
 * Momentum only ever decays; a swipe begun while it still runs ramps up.
 */
export const SWIPE_NEW_PUSH_RUN = 3;
export const SWIPE_NEW_PUSH_GROWTH = 2;
export const SWIPE_NEW_PUSH_SLACK = 3;
/** …and only once the tail has died down to this share of the gesture's peak: until then it is the gesture's own. */
export const SWIPE_NEW_PUSH_AFTER = 0.5;

/**
 * The momentum that follows a gesture, which is to be let go by — and the end of it.
 * Windows' precision touchpad goes on sending wheel events for up to a second
 * after the fingers lift, and stops them the moment the pointer moves. A guard
 * that waited for silence swallowed a swipe begun inside that second (nothing
 * worked until the pointer was nudged). This one lets the tail go and says, as
 * soon as events ramp up again, that what comes now is a new gesture.
 */
export class TailGuard {
  private on = false;
  private dir = 0;
  private peak = 0;
  private prev = 0;
  private low = Infinity;
  private run = 0;
  private lastAt = -Infinity;

  /** A gesture that went `dir` has ended with its biggest event `peak` px: what follows may be its tail. */
  start(dir: number, peak: number, now: number) {
    this.on = true;
    this.dir = Math.sign(dir) || 1;
    this.peak = Math.max(1, peak);
    this.prev = peak;
    this.low = Infinity;
    this.run = 0;
    this.lastAt = now;
  }

  get active() {
    return this.on;
  }

  stop() {
    this.on = false;
  }

  /** The time (ms, on the caller's clock) the tail is over by if no event comes. */
  get endsAt() {
    return this.on ? this.lastAt + SWIPE_TAIL_END_MS : null;
  }

  /** True: this event is tail, let it go. False: it is not — a pause, a turn, or a new push — and the guard is off. */
  absorbs(dx: number, now: number): boolean {
    if (!this.on) return false;
    const mag = Math.abs(dx);
    if (now - this.lastAt >= SWIPE_TAIL_END_MS || (dx !== 0 && Math.sign(dx) !== this.dir)) {
      this.on = false;
      return false;
    }
    if (mag > this.prev * 1.1 + 0.5) this.run++;
    else this.run = 0;
    this.low = Math.min(this.low, mag, this.prev);
    if (
      this.run >= SWIPE_NEW_PUSH_RUN &&
      this.low < this.peak * SWIPE_NEW_PUSH_AFTER &&
      mag >= this.low * SWIPE_NEW_PUSH_GROWTH + SWIPE_NEW_PUSH_SLACK
    ) {
      this.on = false;
      return false;
    }
    this.prev = mag;
    this.lastAt = now;
    return true;
  }
}

export type PanDecision ="page" | "snap-back" | "row-scroll" | "rubber-band";

/** What of a row says whether it can still scroll: an element's own three numbers. */
export interface Scrollable {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/** True while a row has further to go that way: to the right for a positive `dx`. */
export const canScroll = (row: Scrollable, dx: number) =>
  dx > 0 ? row.scrollLeft < row.scrollWidth - row.clientWidth - 1 : row.scrollLeft > 1;

/** A gesture's release: where the page should settle (0 Home, 1 Shelf), and how fast it was going. */
export interface PanEnd {
  decision: PanDecision;
  target: 0 | 1;
  /** Where the page was, px along the axis: 0 is Home, `width` the Shelf. */
  pos: number;
  /** px/ms along the axis, positive towards the Shelf. */
  velocity: number;
}

export type PanStep = { kind: "none" | "scroll" | "ignore" | "drag"; pos: number; ended?: PanEnd };

export interface PanContext {
  /** The Shelf's row is at rest under the pointer and can still scroll this way. */
  scrolls: boolean;
  /** Where the page is now (it may be on its way), px: 0 Home, `width` the Shelf. */
  pos: number;
  width: number;
  deltaMode?: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export class PagePan {
  private phase: "idle" | "drag" | "row" | "tail" = "idle";
  // The gesture's record, for the decision and for the log.
  private events = 0;
  private startAt = 0;
  private lastAt = -Infinity;
  private total = 0;
  private peak = 0;
  private peakV = 0;
  private first: number[] = [];
  private last: number[] = [];
  private mode = 0;
  private samples: { t: number; dx: number }[] = [];
  private raw = 0;
  private pos0 = 0;
  private origin: 0 | 1 = 0;
  private width = 1;
  private pos = 0;
  private prevMag = 0;
  private decayRun = 0;
  private decision: PanDecision = "snap-back";
  // The tail.
  private rowGuard = new TailGuard();
  private tailDir = 0;
  private tailPrev = 0;
  private tailFrom = 0;
  private tailPeak = 0;
  private ignored = 0;

  constructor(private onLog: (line: string) => void = () => {}) {}

  /** A gesture, or the tail of one, is under way: something has to look at the clock. */
  get active() {
    return this.phase !== "idle";
  }

  /** When `poll` next has something to do, or null. */
  due(): number | null {
    if (this.phase === "drag" || this.phase === "row") return this.lastAt + SWIPE_RELEASE_MS;
    if (this.phase === "tail") return this.lastAt + SWIPE_TAIL_END_MS;
    return null;
  }

  /** Drops everything, with no log: a request came in, the island folded. */
  cancel() {
    this.phase = "idle";
    this.lastAt = -Infinity;
    this.rowGuard.stop();
  }

  /** One wheel event that is more sideways than up or down; `dx` positive is towards the Shelf. */
  feed(dx: number, now: number, c: PanContext): PanStep {
    let ended: PanEnd | undefined;
    if ((this.phase === "drag" || this.phase === "row") && now - this.lastAt >= SWIPE_RELEASE_MS) {
      ended = this.release(this.lastAt + SWIPE_RELEASE_MS);
    }
    if (this.phase === "tail") {
      const mag = Math.abs(dx);
      // A gesture that scrolled the row never pages: whatever of it is left when the row
      // has reached its end is its tail, however hard the fingers still push. Only a pause
      // (or a turn) makes what follows another gesture.
      const rowTail = this.decision === "row-scroll";
      // …but a push that ramps up inside that tail is a gesture of its own (`TailGuard`): the
      // touchpad's momentum can run for a second, and a swipe begun in it must not be lost.
      const over = rowTail
        ? !this.rowGuard.absorbs(dx, now)
        : now - this.lastAt >= SWIPE_TAIL_END_MS ||
          Math.sign(dx) !== this.tailDir ||
          (now - this.tailFrom >= SWIPE_TAIL_STRICT_MS && mag > this.tailPrev * SWIPE_RISE + SWIPE_RISE_SLACK) ||
          (now - this.tailFrom < SWIPE_TAIL_STRICT_MS && mag > this.tailPeak);
      if (!over) {
        this.ignored++;
        this.tailPrev = mag;
        this.lastAt = now;
        return { kind: "ignore", pos: this.pos, ended };
      }
      this.finishLog();
    }
    if (this.phase === "idle") this.begin(dx, now, c);
    this.note(dx, now, c.deltaMode ?? 0);

    if (this.phase === "row") {
      if (c.scrolls) return { kind: "scroll", pos: this.pos, ended };
      // The row is at its end: this gesture is done, and the rest of it is tail.
      this.decision = "row-scroll";
      this.enterTail(now, Math.sign(dx));
      return { kind: "ignore", pos: this.pos, ended };
    }

    // Dragging.
    this.raw += dx;
    this.pos = this.place();
    const mag = Math.abs(dx);
    if (mag <= this.prevMag) this.decayRun++;
    else if (mag > this.prevMag * 1.2 + 1) this.decayRun = 0;
    this.prevMag = mag;
    if (this.decayRun >= SWIPE_DECAY_EVENTS && this.peak >= SWIPE_DECAY_MIN_PEAK && mag < this.peak * SWIPE_DECAY_BELOW) {
      const end = this.release(now);
      return { kind: "ignore", pos: this.pos, ended: end };
    }
    return { kind: "drag", pos: this.pos, ended };
  }

  /** The clock moved with no event: a gesture may have ended, or its tail. */
  poll(now: number): PanEnd | null {
    if ((this.phase === "drag" || this.phase === "row") && now - this.lastAt >= SWIPE_RELEASE_MS) return this.release(now);
    if (this.phase === "tail" && now - this.lastAt >= SWIPE_TAIL_END_MS) this.finishLog();
    return null;
  }

  private begin(dx: number, now: number, c: PanContext) {
    this.phase = c.scrolls ? "row" : "drag";
    this.events = 0;
    this.startAt = now;
    this.total = 0;
    this.peak = 0;
    this.peakV = 0;
    this.first = [];
    this.last = [];
    this.samples = [];
    this.ignored = 0;
    this.raw = 0;
    this.width = Math.max(1, c.width);
    this.pos0 = c.pos;
    this.pos = c.pos;
    this.origin = c.pos / this.width >= 0.5 ? 1 : 0;
    this.prevMag = 0;
    this.decayRun = 0;
    this.decision = c.scrolls ? "row-scroll" : "snap-back";
    void dx;
  }

  private note(dx: number, now: number, mode: number) {
    this.events++;
    this.mode = mode;
    this.total += dx;
    this.peak = Math.max(this.peak, Math.abs(dx));
    if (this.first.length < 12) this.first.push(r1(dx));
    this.last.push(r1(dx));
    if (this.last.length > 12) this.last.shift();
    this.samples.push({ t: now, dx });
    if (this.samples.length > 12) this.samples.shift();
    this.lastAt = now;
    const v = this.velocity();
    if (Math.abs(v) > Math.abs(this.peakV)) this.peakV = v;
  }

  /** px/ms over the last SWIPE_FLICK_WINDOW_MS of the gesture, signed. */
  private velocity(): number {
    const from = this.lastAt - SWIPE_FLICK_WINDOW_MS;
    const s = this.samples.filter((x) => x.t >= from);
    if (s.length === 0) return 0;
    const sum = s.reduce((a, x) => a + x.dx, 0);
    if (s.length === 1) return sum / 16;
    const avg = (s[s.length - 1].t - s[0].t) / (s.length - 1);
    return sum / (s.length * Math.max(avg, 1));
  }

  /** The page under the fingers: where the push has taken it, with a rubber band past either edge. */
  private place(): number {
    const t = this.pos0 + this.raw;
    const rub = (over: number) => Math.min(SWIPE_RUBBER_MAX_PX, over * SWIPE_RUBBER);
    if (t < 0) return -rub(-t);
    if (t > this.width) return this.width + rub(t - this.width);
    return t;
  }

  private release(now: number): PanEnd {
    const w = this.width;
    let end: PanEnd;
    if (this.phase === "row") {
      end = { decision: "row-scroll", target: this.origin, pos: this.pos, velocity: 0 };
    } else {
      const toward = this.origin === 0 ? 1 : -1;
      const adv = (this.pos - this.origin * w) * toward;
      const recent = this.velocity() * toward;
      const peak = this.peakV * toward;
      const fast = Math.max(recent, peak);
      const inside = this.pos >= 0 && this.pos <= w;
      let decision: PanDecision;
      let target: 0 | 1 = this.origin;
      if (adv > 0) {
        const flick = fast > SWIPE_FLICK_PX_MS && adv >= SWIPE_FLICK_MIN_PX;
        if ((flick || adv > SWIPE_PAGE_SHARE * w) && recent > -SWIPE_FLICK_PX_MS) {
          decision = "page";
          target = (1 - this.origin) as 0 | 1;
        } else decision = "snap-back";
      } else decision = inside ? "snap-back" : "rubber-band";
      end = { decision, target, pos: this.pos, velocity: this.velocity() };
    }
    this.decision = end.decision;
    this.enterTail(now, Math.sign(this.total) || 1);
    return end;
  }

  private enterTail(now: number, dir: number) {
    this.phase = "tail";
    this.tailDir = dir;
    this.tailPrev = this.prevMag || this.peak;
    this.tailFrom = now;
    this.tailPeak = this.peak;
    if (this.decision === "row-scroll") this.rowGuard.start(dir, this.peak, now);
    else this.rowGuard.stop();
  }

  /** One compact line per completed gesture, once its tail is over. */
  private finishLog() {
    this.phase = "idle";
    const dur = Math.round(this.lastAt - this.startAt);
    this.onLog(
      `swipe n=${this.events} dur=${dur}ms dx=${r1(this.total)} peak=${r1(this.peak)} vpk=${Math.abs(r1(this.peakV))}px/ms ` +
      `first=[${this.first.join(",")}] last=[${this.last.join(",")}] mode=${this.mode} tail=${this.ignored} -> ${this.decision}`,
    );
  }
}
