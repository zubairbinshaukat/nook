// A self-check of the folded island: what its slots show is a plain function
// of the state (src/island/compact.ts `compactSlots`), and the island coming
// back from hidden must show all of it at once — the bot awake, a dot per
// session, every metric cell. There is no test runner on this side, so it is
// checked here, where a preview page loads: the console says how many held,
// and names each one that did not. Preview only.

import { compactPlan, compactSlots, reading, type Gauges } from "../../src/island/compact";
import {
  FOLDED_AUTO_HIDE, State, USAGE_OLD_MS, USAGE_RESET_WORDS, foldedAutoHide, keepKnown, nextUsageReset, resetCountdown, usageShown,
  type Metrics, type Usage,
} from "../../src/core/state";
import { IslandStateMachine, type FsmTimers } from "../../src/island/fsm";
import {
  PagePan, SWIPE_PAGE_SHARE, SWIPE_RELEASE_MS, SWIPE_RUBBER, SWIPE_RUBBER_MAX_PX, SWIPE_TAIL_END_MS, TailGuard, canScroll, type PanEnd, type Scrollable,
} from "../../src/island/swipe";
import type { Island } from "../../src/island/island";
import { overallState, roster, waitingCount } from "../../src/views/roster";

interface Tally {
  passed: number;
  failed: string[];
}

function tally(): Tally & { check(what: string, held: boolean): void; same(what: string, got: unknown, wanted: unknown): void } {
  const t = { passed: 0, failed: [] as string[] };
  const check = (what: string, held: boolean) => {
    if (held) t.passed++;
    else t.failed.push(what);
  };
  const same = (what: string, got: unknown, wanted: unknown) =>
    check(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`, JSON.stringify(got) === JSON.stringify(wanted));
  return Object.assign(t, { check, same });
}

function report(name: string, t: Tally) {
  if (t.failed.length > 0) console.error(`[${name} self-check] ${t.failed.length} failed:\n${t.failed.join("\n")}`);
  else console.info(`[${name} self-check] ${t.passed} checks passed`);
  return { passed: t.passed, failed: t.failed };
}

const GB = 1024 ** 3;

/** The cells, and what a wake does to the numbers: plain functions, no island. */
export function checkSlots() {
  const t = tally();
  const none: Gauges = { metrics: null, usage: null, waiting: 0 };
  const sample: Metrics = { cpu: 31.4, gpu: 18, ramUsed: 8 * GB, ramTotal: 16 * GB };
  const usage = { fiveHour: { usedPercent: 70, resetsAt: 0 }, sevenDay: { usedPercent: 12, resetsAt: 0 }, updatedAt: 0 };

  // Nothing known: every cell is there, and says "—" (the count of sessions waiting is always known).
  for (const kind of ["cpu", "gpu", "ram", "usage5h", "usage7d"] as const) t.same(`nothing known: ${kind}`, reading(kind, none).text, "—");
  t.same("nothing known: waiting", reading("waiting", none).text, "0");
  const known: Gauges = { metrics: sample, usage, waiting: 3 };
  t.same("cpu", reading("cpu", known).text, "31%");
  t.same("ram", reading("ram", known), { text: "50%", more: "8.0 of 16.0 GB" });
  t.same("5-hour usage, coloured", reading("usage5h", known), { text: "70%", level: "warm" });
  t.same("7-day usage", reading("usage7d", known).text, "12%");
  t.same("waiting", reading("waiting", known).text, "3");

  // The first sample after a wake has no processor and no graphics use: the last known stay.
  const wake: Metrics = { cpu: null, gpu: null, ramUsed: 9 * GB, ramTotal: 16 * GB };
  const kept = keepKnown(sample, wake);
  t.same("after a wake the last CPU stays", [kept.cpu, kept.gpu, kept.ramUsed], [31.4, 18, 9 * GB]);
  t.same("…and its cell is not blank", reading("cpu", { ...known, metrics: kept }).text, "31%");
  // Once only: still missing on the sample after, it is not known any more.
  const again = keepKnown(kept, wake);
  t.same("a number missing twice is gone", [again.cpu, again.gpu], [null, null]);
  // The very first sample of all: "—" for the processor, the memory at once.
  const first = keepKnown(null, wake);
  t.same("the first sample ever", [reading("cpu", { ...none, metrics: first }).text, reading("ram", { ...none, metrics: first }).text], ["—", "56%"]);
  // A real reading always wins, and a machine with no graphics counters never gets one made up.
  t.same("a reading replaces what was kept", keepKnown(kept, { ...sample, cpu: 5 }).cpu, 5);
  t.same("no GPU stays no GPU", keepKnown({ ...sample, gpu: null }, wake).gpu, null);

  // The slots of the state as it is now: one dot per session on show, one cell per metric picked that fits.
  const plan = compactPlan();
  const slots = compactSlots(plan, known);
  t.same("a dot per session on show", slots.dots.length, plan.dots);
  t.same("the rest behind +N", slots.more?.count ?? 0, plan.live.length - plan.dots);
  t.same("a cell per metric", slots.cells.map((c) => c.kind), plan.kinds);
  t.check("every cell says something", slots.cells.every((c) => c.text.length > 0));
  return report("folded slots", t);
}

/**
 * The paging model (src/island/swipe.ts) under made-up wheel events on a clock
 * moved by hand: what island.ts does with each step, without the island. A
 * gesture is a run of events 16 ms apart; `flick` adds the momentum that goes
 * on after the fingers lift. The page is `pos`, 0 Home and `W` the Shelf, as the
 * island has it: it follows `drag` steps, and an `ended` sets where it goes.
 */
const W = 440;

function swipeModel() {
  const lines: string[] = [];
  const pan = new PagePan((line) => lines.push(line));
  const row: Scrollable = { scrollLeft: 0, scrollWidth: 1120, clientWidth: 600 };
  const max = row.scrollWidth - row.clientWidth;
  let page: 0 | 1 = 0;
  let pos = 0;
  let now = 1000;
  const pages: string[] = [];
  const ended = (end: PanEnd | undefined) => {
    if (!end) return;
    if (end.decision === "row-scroll") return;
    if (end.target !== page) pages.push(end.target === 1 ? "shelf" : "home");
    page = end.target;
    pos = page * W;
  };
  const event = (dx: number) => {
    const scrolls = page === 1 && pos === W && canScroll(row, dx);
    const step = pan.feed(dx, now, { scrolls, pos, width: W });
    ended(step.ended);
    if (step.kind === "scroll") row.scrollLeft = Math.max(0, Math.min(max, row.scrollLeft + dx));
    else if (step.kind === "drag") pos = step.pos;
    now += 16;
  };
  return {
    row, max, pages, lines, pan,
    get page() { return page; },
    get pos() { return pos; },
    get now() { return now; },
    /** `travel` px that way, in steps of `step`. */
    swipe(travel: number, step = 12) {
      for (let gone = 0; gone < Math.abs(travel); gone += step) event(Math.sign(travel) * step);
    },
    /** The momentum after the fingers lift: decaying events, no pause in them. */
    momentum(sign: number, from = 24) {
      for (let speed = from; speed >= 1; speed *= 0.9) event(sign * speed);
    },
    /** Time passes with no event: the island's timer polls the model. */
    pause(ms: number) {
      now += ms;
      ended(pan.poll(now) ?? undefined);
    },
    release() { this.pause(SWIPE_RELEASE_MS + 10); },
    rest() { this.pause(SWIPE_TAIL_END_MS + SWIPE_RELEASE_MS + 400); },
  };
}

/** One gesture, one thing: a page, a snap back, the row — on a clock moved by hand. */
export function checkSwipe() {
  const t = tally();

  // A slow, short drag: it follows 1:1, and on release snaps back.
  const a = swipeModel();
  a.swipe(60, 4);
  t.same("the page follows the fingers 1:1", a.pos, 60);
  a.release();
  t.same("a slow short drag snaps back", [a.page, a.pages], [0, []]);
  a.rest();
  t.check("…and logs one line saying so", a.lines.length === 1 && a.lines[0].startsWith("swipe ") && a.lines[0].endsWith("snap-back"));

  // Past 35 % of the width, however slowly: a page.
  const b = swipeModel();
  b.swipe(W * SWIPE_PAGE_SHARE + 12, 4);
  b.release();
  t.same("past the share: pages", [b.page, b.pages], [1, ["shelf"]]);
  b.rest();
  t.check("…logged as a page", b.lines.length === 1 && b.lines[0].endsWith("page"));

  // A fast flick, short of the share.
  const c = swipeModel();
  c.swipe(60, 30);
  t.check("a flick is short of the share", c.pos < W * SWIPE_PAGE_SHARE);
  c.release();
  t.same("a fast flick pages", [c.page, c.pages], [1, ["shelf"]]);

  // Inertia: the decaying tail after a flick does not drag the page again, nor page twice.
  const d = swipeModel();
  d.swipe(90, 30);
  d.momentum(1, 28);
  t.same("a flick with momentum pages once", [d.page, d.pages], [1, ["shelf"]]);
  t.same("its momentum does not re-drag the page", d.pos, W);
  d.rest();
  t.same("…and does not scroll the row", d.row.scrollLeft, 0);
  t.check("its tail is counted in the log", /tail=([1-9]\d*)/.test(d.lines[0] ?? ""));

  // The same the other way: from the Shelf, back to Home, with momentum.
  d.swipe(-90, 30);
  d.momentum(-1, 28);
  d.rest();
  t.same("and back to Home, once", [d.page, d.pages], [0, ["shelf", "home"]]);

  // Rubber band: pushing past an edge with no tab gives 0.3 of the push, never more than 40 px.
  const e = swipeModel();
  e.swipe(-60, 6);
  t.same("past Home's edge: a third of the push", Math.round(e.pos), Math.round(-60 * SWIPE_RUBBER));
  e.swipe(-600, 6);
  t.same("…and never more than the cap", e.pos, -SWIPE_RUBBER_MAX_PX);
  e.release();
  t.same("let go: back at Home, no page", [e.page, e.pages], [0, []]);
  e.rest();
  t.check("…logged as a rubber band", e.lines[0]?.endsWith("rubber-band") === true);

  // Two gestures in a row, the pointer never moving: each one pages.
  const f = swipeModel();
  f.swipe(200, 20);
  f.release();
  f.rest();
  t.same("first gesture: the Shelf", f.page, 1);
  f.swipe(-200, 20);
  f.release();
  f.rest();
  t.same("second gesture, at once: Home again", [f.page, f.pages], [0, ["shelf", "home"]]);

  // A new push that begins while the first one's tail is still going counts: it is clearly bigger.
  const g = swipeModel();
  g.swipe(90, 30);
  g.momentum(1, 20);
  g.swipe(-150, 30);
  g.release();
  t.same("a hard push the other way during the tail is a new gesture", g.page, 0);

  // The row scrolls first; a gesture that scrolled it never pages, a separate one at its edge does.
  const h = swipeModel();
  h.swipe(200, 20);
  h.release();
  h.rest();
  h.swipe(24);
  t.same("on the Shelf the row scrolls at once", [h.row.scrollLeft, h.pos], [24, W]);
  h.swipe(1200);
  t.same("to its end, and no tab", [h.row.scrollLeft, h.page, h.pages], [h.max, 1, ["shelf"]]);
  h.momentum(1, 28);
  h.rest();
  t.same("the momentum past the end pages nothing", [h.page, h.pos], [1, W]);
  t.check("…and is logged as a row scroll", h.lines.some((l) => l.endsWith("row-scroll")));
  // Back to the start of the row in one gesture: it stops there on the Shelf.
  h.swipe(-1200);
  h.release();
  h.rest();
  t.same("a gesture that scrolled the row back to its start stays on the Shelf", [h.row.scrollLeft, h.page], [0, 1]);
  // A separate gesture, begun with the row at its start: Home.
  h.swipe(-W * 0.5, 12);
  h.release();
  h.rest();
  t.same("a new gesture at the row's edge pages", [h.page, h.pages], [0, ["shelf", "home"]]);

  // Momentum is let go, but a swipe begun while it still runs is not lost (the pointer never moved).
  // From the Shelf at the end of its row: the row's momentum decays, then a push the other way ramps up.
  const k = swipeModel();
  k.swipe(200, 20);
  k.release();
  k.rest();
  k.swipe(1200);
  k.momentum(1, 28);
  // No pause: the new push turns round at once, as the fingers do. The row is at its end, so it scrolls back.
  const atEnd = k.row.scrollLeft;
  k.swipe(-120, 14);
  t.check("a swipe back begun inside the momentum is not lost: the row scrolls back", k.row.scrollLeft < atEnd - 60);
  k.release();
  k.rest();
  t.same("…and it did not page", [k.page, k.pages], [1, ["shelf"]]);

  // The same direction: the row's momentum has died down to a trickle, and a fresh push the same way follows.
  const m = swipeModel();
  m.swipe(200, 20);
  m.release();
  m.rest();
  m.swipe(1200);
  for (let speed = 20; speed >= 2; speed *= 0.8) m.swipe(speed, speed);
  const before = m.row.scrollLeft;
  // A ramp up: 3, 6, 11, 18, 26 …
  for (const dx of [3, 6, 11, 18, 26, 30, 30]) m.swipe(-dx, dx);
  t.check("a ramp the other way in the trickle is a gesture of its own", m.row.scrollLeft < before || m.pos < W);

  // The guard alone: decaying events are tail, a pause or a ramp ends it, steady pushing never does.
  const guard = new TailGuard();
  guard.start(1, 24, 0);
  let at = 0;
  let decaying = true;
  for (let speed = 24; speed >= 1; speed *= 0.9) decaying = guard.absorbs(speed, (at += 16)) && decaying;
  t.check("momentum is absorbed to its last event", decaying && guard.active);
  guard.start(1, 24, 0);
  at = 0;
  const steady = [24, 23, 24, 25, 24, 23, 24].every((dx) => guard.absorbs(dx, (at += 16)));
  t.check("steady pushing right after the end of a gesture stays its own", steady);
  guard.start(1, 24, 0);
  t.check("a pause ends it", !guard.absorbs(10, 400));
  guard.start(1, 24, 0);
  t.check("a turn ends it", !guard.absorbs(-3, 16));
  guard.start(1, 24, 0);
  at = 0;
  for (const dx of [10, 6, 4, 2]) guard.absorbs(dx, (at += 16));
  const ramp = [3, 6, 11, 18].map((dx) => guard.absorbs(dx, (at += 16)));
  t.same("a ramp ends it on its third rising event, never earlier", ramp, [true, true, false, false]);
  return report("swipe", t);
}

/**
 * The same on the page's own island, with wheel events made here — aimed at
 * the home view, as the browser aims them after the tab changed under a
 * pointer that did not move. The island must not care: the pointer is over
 * the Shelf, so the row scrolls. Run with the island open on the Shelf.
 */
export async function checkShelfSwipe(island: Island) {
  const t = tally();
  // A tab in the background is handed no frame, and the island would still be on its way open: its frames are run by hand.
  const frames = island as unknown as { frame(now: number): void };
  let clock = performance.now();
  const run = (n: number) => {
    for (let i = 0; i < n; i++) frames.frame((clock += 16));
  };
  run(150);
  const row = document.querySelector<HTMLElement>(".shelf-view .shelf-row");
  const views = document.getElementById("views");
  const stale = document.querySelector<HTMLElement>(".view:not(.shelf-view)");
  if (!row || !views || !stale || State.view !== "shelf") {
    t.check("the Shelf is on show when the check starts", false);
    return report("shelf swipe", t);
  }
  const at = views.getBoundingClientRect();
  const wheel = (dx: number) =>
    stale.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, deltaY: 0, clientX: at.left + at.width / 2, clientY: at.top + at.height / 2, bubbles: true, cancelable: true }));
  const pause = (ms: number) => new Promise((done) => window.setTimeout(done, ms));
  const max = row.scrollWidth - row.clientWidth;
  t.check("the row has more cards than it shows", max > 40);

  row.scrollLeft = 0;
  const taken = !wheel(30);
  t.check("the event is the island's (the page does not scroll, or go back)", taken);
  t.check("the row scrolls though the event was aimed elsewhere", row.scrollLeft > 0);
  for (let i = 0; i < 80; i++) wheel(30);
  t.same("to its end", Math.round(row.scrollLeft), Math.round(max));
  t.same("still the Shelf", State.view, "shelf");

  // A separate gesture, begun with the row at its end, goes the other way: it pages Home.
  await pause(SWIPE_RELEASE_MS + SWIPE_TAIL_END_MS + 100);
  row.scrollLeft = 0;
  for (let i = 0; i < 12; i++) wheel(-30);
  await pause(SWIPE_RELEASE_MS + 40);
  run(200);
  t.check("a separate swipe from the start goes Home", State.view !== "shelf");
  return report("shelf swipe", t);
}
/** Claude's usage as it is shown, from what was last reported and the time: around a reset, and with age. */
export function checkUsage() {
  const t = tally();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const at = 1_800_000_000_000;
  const win = { usedPercent: 82.6, resetsAt: at + 2 * HOUR + 14 * MIN };

  // Before the reset: the number, fresh, and a countdown.
  t.same("fresh, with a countdown", usageShown(win, at - 16 * MIN, at), { percent: 83, state: "fresh", countdown: "resets in 2h 14m" });
  t.same("sixteen minutes old is not old", usageShown(win, at - 16 * MIN, at)?.state, "fresh");
  t.same("two hours old, to the millisecond, is not old yet", usageShown(win, at - USAGE_OLD_MS, at)?.state, "fresh");
  t.same("past two hours it is old, and still the number", usageShown(win, at - USAGE_OLD_MS - 1, at), { percent: 83, state: "old", countdown: "resets in 2h 14m" });
  // Around the reset.
  t.same("a millisecond before: still the number", usageShown(win, at, win.resetsAt - 1), { percent: 83, state: "fresh", countdown: "resets in <1m" });
  t.same("at the reset: 0 %, waiting", usageShown(win, at, win.resetsAt), { percent: 0, state: "reset", countdown: USAGE_RESET_WORDS });
  t.same("after it, however fresh the report was", usageShown(win, win.resetsAt + MIN - 1, win.resetsAt + MIN)?.state, "reset");
  t.same("reset wins over old", usageShown(win, at - 9 * HOUR, win.resetsAt + HOUR)?.state, "reset");
  // A window that never said when it resets is never "reset", and has no countdown.
  t.same("no reset time: the number, no countdown", usageShown({ usedPercent: 40, resetsAt: 0 }, at, at + HOUR), { percent: 40, state: "fresh", countdown: "" });
  t.same("no window: nothing", usageShown(null, at, at), null);

  // The countdown's words.
  t.same("under a minute", resetCountdown(59_999), "resets in <1m");
  t.same("a minute", resetCountdown(MIN), "resets in 1m");
  t.same("minutes", resetCountdown(59 * MIN + 59_000), "resets in 59m");
  t.same("hours and minutes", resetCountdown(2 * HOUR + 14 * MIN + 30_000), "resets in 2h 14m");
  t.same("a whole hour", resetCountdown(HOUR), "resets in 1h 0m");
  t.same("days and hours, for the 7-day window", resetCountdown(3 * 24 * HOUR + 4 * HOUR + 50 * MIN), "resets in 3d 4h");
  t.same("never negative", resetCountdown(-5), "resets in <1m");

  // The one timer: to the nearest reset still ahead.
  const usage: Usage = { fiveHour: win, sevenDay: { usedPercent: 12, resetsAt: at + 80 * HOUR }, updatedAt: at };
  t.same("the nearest reset ahead", nextUsageReset(usage, at), win.resetsAt);
  t.same("once it has passed, the other", nextUsageReset(usage, win.resetsAt), at + 80 * HOUR);
  t.same("none ahead", nextUsageReset(usage, at + 100 * HOUR), null);
  t.same("no usage", nextUsageReset(null, at), null);

  // The folded cell: the same state. Reset: "0%", dimmed, no colour of a level, the reason in its tooltip.
  const cell = (now: number, updatedAt = at) => reading("usage5h", { metrics: null, usage: { ...usage, updatedAt }, waiting: 0, now });
  t.same("cell, fresh", [cell(at).text, cell(at).level, cell(at).dim], ["83%", "warm", false]);
  t.same("cell, reset", [cell(win.resetsAt + 1).text, cell(win.resetsAt + 1).level, cell(win.resetsAt + 1).dim], ["0%", undefined, true]);
  t.check("cell, reset: the tooltip says so", (cell(win.resetsAt + 1).more ?? "").startsWith(USAGE_RESET_WORDS));
  t.check("cell, fresh: the tooltip has the countdown", (cell(at).more ?? "").startsWith("resets in 2h 14m"));
  t.same("cell, old but not reset: dimmed, its number kept", [cell(at + HOUR, at - 90 * MIN).text, cell(at + HOUR, at - 90 * MIN).dim], ["83%", true]);
  t.same("cell, ten minutes old: not dimmed", cell(at, at - 10 * MIN).dim, false);
  t.same("the other window is its own", reading("usage7d", { metrics: null, usage, waiting: 0, now: win.resetsAt + 1 }).text, "12%");
  return report("usage", t);
}

/** A clock moved by hand: the timers the state machine sets run when their time is reached, in order. */
function fakeClock(): { timers: FsmTimers; advance(seconds: number): void } {
  let now = 0;
  let ids = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  return {
    timers: {
      set(run, ms) {
        due.set(++ids, { at: now + ms, run });
        return ids;
      },
      clear: (id) => void due.delete(id),
    },
    advance(seconds) {
      const end = now + seconds * 1000;
      for (;;) {
        const next = [...due].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].run();
      }
      now = end;
    },
  };
}

/**
 * Settings → Island → Visibility, on the state machine alone and a clock moved
 * by hand: each choice of "Auto-hide the folded island after", "never", and
 * "hide only when no session is active".
 */
export function checkAutoHide() {
  const t = tally();
  const folded = (delay: number) => {
    const clock = fakeClock();
    const fsm = new IslandStateMachine(clock.timers);
    fsm.petitToHiddenDelay = delay;
    return { fsm, clock };
  };

  t.same("the choices", [...FOLDED_AUTO_HIDE], [5, 10, 30, 60, 0]);
  t.same("a file that says none: a minute, as before", foldedAutoHide({ foldedAutoHide: undefined as unknown as number }), 60);
  t.same("a number that is no choice: a minute", foldedAutoHide({ foldedAutoHide: 12 }), 60);
  t.same("never is a choice", foldedAutoHide({ foldedAutoHide: 0 }), 0);

  for (const delay of FOLDED_AUTO_HIDE.filter((d) => d > 0)) {
    const { fsm, clock } = folded(delay);
    fsm.reveal();
    clock.advance(delay - 0.01);
    t.same(`${delay} s: still folded just before`, fsm.state, "petit");
    clock.advance(0.02);
    t.same(`${delay} s: hidden when the time is up`, fsm.state, "hidden");
    // The pointer on it holds it; the time starts again, whole, when it leaves.
    fsm.reveal();
    clock.advance(delay / 2);
    fsm.mouseEntered();
    clock.advance(delay * 3);
    t.same(`${delay} s: the pointer keeps it`, fsm.state, "petit");
    fsm.mouseLeft();
    clock.advance(delay - 0.01);
    t.same(`${delay} s: its whole time again once the pointer has left`, fsm.state, "petit");
    clock.advance(0.02);
    t.same(`${delay} s: then hidden`, fsm.state, "hidden");
  }

  // Never: it stays, for as long as anyone looks.
  const never = folded(0);
  never.fsm.reveal();
  never.clock.advance(86_400);
  t.same("never: still folded a day later", never.fsm.state, "petit");
  // …until another choice is made: its time runs from then.
  never.fsm.petitToHiddenDelay = 10;
  never.fsm.refresh(true);
  never.clock.advance(9.9);
  t.same("never, then 10 s: not before", never.fsm.state, "petit");
  never.clock.advance(0.2);
  t.same("never, then 10 s: hidden", never.fsm.state, "hidden");
  // A shorter time picked while one runs counts from the moment it is picked.
  const changed = folded(60);
  changed.fsm.reveal();
  changed.clock.advance(20);
  changed.fsm.petitToHiddenDelay = 5;
  changed.fsm.refresh(true);
  changed.clock.advance(4.9);
  t.same("60 s, then 5 s: not before", changed.fsm.state, "petit");
  changed.clock.advance(0.2);
  t.same("60 s, then 5 s: hidden", changed.fsm.state, "hidden");
  // And "never" picked while a time runs stops it.
  const stopped = folded(5);
  stopped.fsm.reveal();
  stopped.clock.advance(2);
  stopped.fsm.petitToHiddenDelay = 0;
  stopped.fsm.refresh(true);
  stopped.clock.advance(600);
  t.same("5 s, then never: it stays", stopped.fsm.state, "petit");

  // Hide only when no session is active.
  let active = true;
  const held = folded(5);
  held.fsm.holds = () => active;
  held.fsm.reveal();
  held.clock.advance(600);
  t.same("a session at work: the folded island stays", held.fsm.state, "petit");
  active = false;
  held.fsm.refresh();
  held.clock.advance(4.9);
  t.same("nothing active: the time starts then, whole", held.fsm.state, "petit");
  held.clock.advance(0.2);
  t.same("…and it hides when it is up", held.fsm.state, "hidden");
  // A session starts work while the time runs: it stops; it starts again, whole, once it rests.
  held.fsm.reveal();
  held.clock.advance(3);
  active = true;
  held.fsm.refresh();
  held.clock.advance(60);
  t.same("work begun while the time ran: it stays", held.fsm.state, "petit");
  // The island is not told (no refresh): the timer that fires asks again.
  active = false;
  held.fsm.refresh();
  held.clock.advance(2);
  active = true;
  held.clock.advance(10);
  t.same("active again when the time is up, with nobody saying so: it stays", held.fsm.state, "petit");
  active = false;
  held.fsm.refresh();
  held.clock.advance(5.1);
  t.same("at rest again: hidden after its time", held.fsm.state, "hidden");
  // With the pointer on it nothing is armed, whatever the sessions do.
  held.fsm.reveal();
  held.fsm.mouseEntered();
  held.fsm.refresh();
  held.clock.advance(600);
  t.same("the pointer on it: refresh arms nothing", held.fsm.state, "petit");
  // Never wins over "when idle"; and an open island is none of this.
  const both = folded(0);
  both.fsm.holds = () => false;
  both.fsm.reveal();
  both.fsm.refresh();
  both.clock.advance(3600);
  t.same("never, nothing active: it stays", both.fsm.state, "petit");
  const open = folded(5);
  open.fsm.forceHome();
  open.fsm.refresh(true);
  open.clock.advance(4);
  t.same("an open island is not the folded one's timer", open.fsm.state, "home");
  return report("auto-hide", t);
}

/**
 * The island auto-hides, and comes back — by the wake strip under the pointer,
 * then by a session's work: both times the slots are on show at once, with the
 * numbers last known, and the bot wears the most urgent session's state.
 * Run on the page's own island, folded; it is left folded, as it was.
 */
export function checkWake(island: Island) {
  const t = tally();
  const el = document.getElementById("compact");
  if (!el || State.mode !== "compact") {
    t.check("the island is folded when the check starts", false);
    return report("wake", t);
  }
  const drawn = () => ({
    on: el.classList.contains("on"),
    dots: el.querySelectorAll(".ci-dot").length,
    dotsHidden: (el.querySelector(".ci-dots") as HTMLElement).hidden,
    cells: [...el.querySelectorAll(".ci-metric b")].map((b) => b.textContent ?? ""),
  });
  const bot = () => (island as unknown as { engine: { state: string } }).engine.state;
  const before = State.metrics;
  const hadCpu = before?.cpu != null;

  for (const how of ["hover", "work event"] as const) {
    // A whole sample, as the island had while it was on show.
    if (before) State.setMetrics({ cpu: before.cpu, gpu: before.gpu, ramUsed: before.ramUsed, ramTotal: before.ramTotal });
    island.fsm.forceHidden();
    t.same(`${how}: hidden`, State.mode, "hidden");
    // What Rust sends first after a wake: memory, and no processor use yet.
    if (how === "hover") island.fsm.mouseEntered();
    else island.reveal();
    if (State.metrics) State.setMetrics({ cpu: null, gpu: null, ramUsed: State.metrics.ramUsed, ramTotal: State.metrics.ramTotal });

    const plan = compactPlan();
    const slots = compactSlots(plan, { metrics: State.metrics, usage: State.usage, waiting: waitingCount() });
    const now = drawn();
    t.same(`${how}: folded again`, State.mode, "compact");
    t.check(`${how}: the slots are on show`, now.on);
    t.same(`${how}: a dot per session`, now.dots, plan.dots);
    t.check(`${how}: dots there when sessions are`, plan.live.length === 0 || (!now.dotsHidden && (now.dots > 0 || slots.more != null)));
    t.same(`${how}: every metric cell, with its number`, now.cells, slots.cells.map((c) => c.text));
    t.same(`${how}: as many cells as were picked and fit`, now.cells.length, plan.kinds.length);
    const cpuAt = plan.kinds.indexOf("cpu");
    if (hadCpu && cpuAt >= 0) t.check(`${how}: the CPU cell keeps its last number`, now.cells[cpuAt] !== "—");
    const { live } = roster();
    t.same(`${how}: the bot wears the most urgent session's state`, bot(), overallState(live));
    t.check(`${how}: the bot is not asleep with sessions or hooks`, bot() !== "sleeping" || (live.length === 0 && !State.settings.hooksInstalled));
  }
  return report("wake", t);
}
