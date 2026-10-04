// Gullu's reactions — the layer between the pointer and the bot.
//
// The engine (engine.ts) draws: states, tweens, a face. This decides what the
// bot does about the cursor coming near, staying, circling, leaving, clicking —
// and about nothing happening at all — and drives the engine through its public
// fields and tweens. It owns no canvas, no timer, no frame loop and no sound:
// the host feeds it the pointer and a tick, asks it `busy` and `nextDue()`, and
// hears its cues.
//
// Its hosts: island/island.ts, for the island's bot — the loop, the one timer,
// the sounds — and bot/minibots.ts, for a session's mini, which answers the
// cursor only. dev/gullu-playground.ts is the reference host.
//
// ── The host's contract ───────────────────────────────────────────────────────
//
//   const gullu = new GulluReactions(engine);
//   gullu.onCue = (cue) => …;          // a named moment a sound could go with
//   gullu.onChange = () => { if (gullu.busy) startLoop(); armTimer(); };
//
//   bot moved or resized      gullu.place(cx, cy, diameter)   (same space as the pointer)
//   cursor moved              gullu.pointerMove(x, y)
//   cursor gone (no position) gullu.pointerLeave()
//   click on the bot          gullu.click(x, y)               (the host does the hit test: gullu.hit(x, y))
//   status changed            gullu.setStatus(state)          INSTEAD OF engine.setState(state)
//   island shown / hidden     gullu.setVisible(bool)
//   every frame drawn         gullu.update(dt); engine.update(dt); engine.draw(…)
//   loop may stop when        !gullu.busy                     (it includes engine.busy)
//   when the loop stops       armTimer(): const due = gullu.nextDue();
//                             if (due != null) setTimeout(startLoop, due - performance.now())
//
// Hidden, `busy` is false and `nextDue()` is null: nothing runs. Between two
// idle behaviours nothing runs either — the host sleeps on one timer.

import { Ease } from "../core/anim";
import type { BotStateName } from "../core/layout";
import {
  botNowMs, detailFor, hexToRGB,
  type BotEngine, type BrowShape, type EyeShape, type MouthShape, type RGB, type TweenKey,
} from "./engine";

/** Everything Gullu can do on its own. `play(name)` does it on demand. */
export const REACTIONS = [
  // the cursor
  "perk", "hoverHappy", "hearts", "dizzy", "sigh",
  // a click
  "surprised", "naughty", "ticklish", "boop", "annoyed", "spin", "raspberry",
  // nothing happening
  "lookAround", "doubleBlink", "yawn", "sproutSway", "glance",
  "fallAsleep", "sleepBreath", "wake",
] as const;
export type ReactionName = (typeof REACTIONS)[number];

/** A moment a sound could go with. The controller plays none itself. */
export type GulluCue =
  | "perk" | "happy" | "love" | "dizzy" | "sigh"
  | "gasp" | "giggle" | "laugh" | "boop" | "annoyed" | "whee" | "raspberry"
  | "yawn" | "sleep" | "wake"
  // Playful reactions off: today's two, which the island plays itself for now.
  | "hover";

export type GulluZone = "on" | "near" | "aware" | "far";

/** What the status allows: everything, everything but idling, or a second at most. */
export type GulluTier = "free" | "busy" | "alert" | "none";

type MoveProp =
  | "oy" | "ox" | "sx" | "sy" | "tilt" | "spin" | "poke" | "sproutSwing" | "sproutWiggle" | "sproutSpin";
type SoftProp = "es" | "blush" | "tongue" | "sproutPerk" | "sproutDroop";

const { out, inOut, back, lin } = Ease;
const TAU = Math.PI * 2;

/** The statuses that must never be upstaged: a reaction lasts a second at most, and changes nothing but the face and a small move. */
const ALERT: ReadonlySet<BotStateName> = new Set<BotStateName>(["approval", "question", "error"]);
/** What may still be played under one of them — each has a short form. */
const QUICK_OK: ReadonlySet<ReactionName> = new Set<ReactionName>([
  "perk", "hoverHappy", "dizzy", "surprised", "naughty", "ticklish", "boop", "annoyed",
]);
/** What only an idle Gullu does. */
const IDLE_ONLY: ReadonlySet<ReactionName> = new Set<ReactionName>([
  "lookAround", "doubleBlink", "yawn", "sproutSway", "glance", "fallAsleep", "sleepBreath", "wake",
]);
/** The longest a reaction may last under an alert, in seconds. */
const QUICK_MAX = 0.85;

const DIZZY_COLOR: RGB = hexToRGB("#E879F9");
const SLEEP_COLOR: RGB = hexToRGB("#A7B4C8");

/**
 * A status that moves has no loop: it rests, and every so often plays a beat —
 * its pulse, its bob, its bounce for a moment (engine.ts `beat`) — scheduled
 * here, through `nextDue`, so that between two beats nothing is drawn. How far
 * apart they come, in seconds.
 */
const BEAT_EVERY: Partial<Record<BotStateName, readonly [number, number]>> = {
  working: [4, 6], searching: [4, 6], thinking: [4, 6],
  approval: [2, 3],
  ratelimit: [4, 6],
  sleeping: [5, 8],
};
/** How long a beat plays, in seconds. */
const BEAT_S = 0.9;
/** The sprout of a working bot wiggles for a moment this often (it did so without a pause before), in seconds. */
const WIGGLE_EVERY: readonly [number, number] = [6, 10];
const WIGGLES: ReadonlySet<BotStateName> = new Set<BotStateName>(["working", "searching", "thinking"]);

const CLICK_SET = ["surprised", "naughty", "ticklish", "boop"] as const;
const CLICK_WEIGHT: Record<(typeof CLICK_SET)[number], number> = {
  surprised: 1, naughty: 1.1, ticklish: 1, boop: 1.2,
};
const IDLE_SET = ["lookAround", "doubleBlink", "yawn", "sproutSway", "glance"] as const;

const now = () => botNowMs() / 1000;

export class GulluReactions {
  readonly engine: BotEngine;

  onCue: ((cue: GulluCue) => void) | null = null;
  /** Something changed outside a frame: check `busy` and `nextDue()` again. */
  onChange: (() => void) | null = null;
  random: () => number = Math.random;
  /** The status plays its beats (see BEAT_EVERY). A mini's are the home view's to schedule, staggered: it turns them off here. */
  beats = true;

  /** Seconds without the cursor near, a click or a change of status before Gullu naps. */
  napAfter = 180;
  /** An idle behaviour comes this many seconds after the last thing that happened: between the two. */
  idleEvery: readonly [number, number] = [10, 20];

  private _playful = true;
  private _reduce: boolean | null = null;
  private media: MediaQueryList | null = null;
  private _visible = true;
  private status: BotStateName = "idle";

  // The bot on the page, and the cursor.
  private cx = 0;
  private cy = 0;
  private d = 58;
  private px = 0;
  private py = 0;
  private known = false;
  private _zone: GulluZone = "far";

  // What is playing.
  private current: { name: ReactionName; at: number; until: number } | null = null;
  private timeline: { at: number; fn: () => void }[] = [];
  private cool = new Map<string, number>();
  private hold: { x: number; y: number; until: number } | null = null;
  private dizzyUntil = 0;
  private tinted = false;
  private _napping = false;

  // The lean, on its spring.
  private lean = 0;
  private leanV = 0;
  private leanT = 0;
  private dirty = false;

  // Hovering.
  private hoverStage = 0;
  private hoverDue: number | null = null;
  private engaged = false;
  // Circling.
  private circ = 0;
  private circAng: number | null = null;
  private circAt = 0;
  // Clicking.
  private clicks: number[] = [];
  private lastClickAt = -1e9;
  private picks: string[] = [];
  private lastRare: ReactionName | null = null;
  // Idling.
  private idleDue = Number.POSITIVE_INFINITY;
  private lastIdle: string | null = null;
  // Beats: the next one, and the next wiggle of the sprout (which comes with a beat).
  private beatDue = Number.POSITIVE_INFINITY;
  private wiggleDue = 0;
  private lastActivity = now();
  // Playful off: the island's hover → love, as it is today.
  private legacyOver = false;
  private legacyStart = { x: 0, y: 0 };
  private lastLove = -1e9;

  constructor(engine: BotEngine) {
    this.engine = engine;
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      this.media = window.matchMedia("(prefers-reduced-motion: reduce)");
    }
    this.scheduleIdle();
  }

  // ── Switches ────────────────────────────────────────────────────────────────

  get playful() { return this._playful; }
  /** Off, the bot is driven as the island drives it today: its eyes follow, a click is a slap, a long hover is love. */
  set playful(on: boolean) {
    if (on === this._playful) return;
    this.cancel(true);
    this.unnap();
    this._playful = on;
    this.hoverDue = null;
    this.hoverStage = 0;
    this.legacyOver = false;
    this.engine.tgEs = 1;
    this.circ = 0;
    this.clicks = [];
    if (!on) this.engine.lookRange = 1;
    this.pose(300);
    this.scheduleIdle();
    this.touch();
  }

  /** True, false, or null to follow the system's `prefers-reduced-motion`. */
  get reduceMotion() { return this._reduce; }
  set reduceMotion(v: boolean | null) {
    if (v === this._reduce) return;
    this.cancel(true);
    this._reduce = v;
    this.pose(300);
    this.touch();
  }
  /** Blinks, faces and status stay; hops, spins, shakes and the lean go. */
  get reduced(): boolean { return this._reduce ?? this.media?.matches ?? false; }

  get visible() { return this._visible; }
  setVisible(on: boolean) {
    if (on === this._visible) return;
    if (!on) {
      this.cancel(true);
      this.hoverDue = null;
      this.hoverStage = 0;
      this.lean = this.leanT = this.leanV = 0;
      this.engine.lean = 0;
      this.dirty = false;
    }
    this._visible = on;
    if (on) {
      this.scheduleIdle();
      this.scheduleBeat();
      this.dirty = true;
    } else {
      this.beatDue = Number.POSITIVE_INFINITY;
    }
    this.onChange?.();
  }

  /** The status the bot speaks for. The host calls this instead of `engine.setState`. */
  setStatus(next: BotStateName) {
    if (next === this.status) {
      this.engine.setState(next);
      return;
    }
    this.status = next;
    if (this._playful) {
      // Status always wins: whatever was playing stops, now.
      this.cancel(true);
      this.unnap();
      if (ALERT.has(next)) this.engine.clearParticles();
    }
    this.engine.setState(next);
    this.lastActivity = now();
    this.pose(400);
    this.scheduleIdle();
    this.scheduleBeat();
    this.touch();
  }

  get tier(): GulluTier {
    if (this.status === "dizzy") return "none";
    if (ALERT.has(this.status) || this.status === "sleeping") return "alert";
    return this.status === "idle" ? "free" : "busy";
  }

  // ── Read-outs ───────────────────────────────────────────────────────────────

  /** True while anything is moving or about to: the host's loop goes on. */
  get busy(): boolean {
    if (!this._visible) return false;
    return (
      this.engine.busy || this.current != null || this.timeline.length > 0 || this.dirty ||
      this.lean !== this.leanT || this.leanV !== 0
    );
  }

  /**
   * When the controller next needs a frame although nothing is moving — a
   * hover that has lasted long enough, an idle behaviour, the nap — on the
   * engine's clock (`performance.now()`, in milliseconds). Null: never, until
   * something happens.
   */
  nextDue(): number | null {
    if (!this._visible) return null;
    let t = Math.min(this.hoverDue ?? Number.POSITIVE_INFINITY, this.beatDue);
    if (this._playful && this.tier === "free") {
      t = Math.min(t, this.idleDue);
      if (!this._napping) t = Math.min(t, this.lastActivity + this.napAfter);
    }
    return Number.isFinite(t) ? t * 1000 : null;
  }

  get reaction(): ReactionName | null { return this.current?.name ?? null; }
  get napping() { return this._napping; }
  get zone(): GulluZone { return this._zone; }
  /** Drawn a dozen pixels across: no tongue, no particles, simpler moves. */
  get small(): boolean { return detailFor(this.engine.drawnR) < 0.5; }

  /** Seconds left on every cooldown still running. */
  cooldowns(): Record<string, number> {
    const n = now();
    const res: Record<string, number> = {};
    for (const [k, until] of this.cool) if (until > n) res[k] = until - n;
    return res;
  }

  /** Is the point on the bot's body, for a click? As far out as the island's own hit test always went: 0.83 of its diameter. (The "on" zone of a hover is the layer's own, and smaller.) */
  hit(x: number, y: number): boolean {
    return Math.hypot(x - this.cx, y - this.cy) <= this.d * 0.83;
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  /** Where the bot is: the centre of its slot and the slot's diameter, in the pointer's coordinates. */
  place(cx: number, cy: number, diameter: number) {
    this.cx = cx;
    this.cy = cy;
    this.d = Math.max(1, diameter);
  }

  pointerMove(x: number, y: number) {
    const moved = Math.hypot(x - this.px, y - this.py);
    this.px = x;
    this.py = y;
    this.known = true;
    if (!this._visible) return;
    const n = now();
    if (!this._playful) {
      this.legacyHover(x, y, n);
      this.dirty = true;
      this.onChange?.();
      return;
    }

    const prev = this._zone;
    const zone = this.zoneAt(x, y);
    this._zone = zone;
    if (zone === "far" && prev === "far") return; // somewhere else on the screen: nothing to do
    this.dirty = true;
    const close = zone === "on" || zone === "near";
    const wasClose = prev === "on" || prev === "near";
    if (close) this.lastActivity = n;

    if (close && (this._napping || this.current?.name === "fallAsleep")) {
      this.run("wake");
    } else {
      this.circling(x, y, n, moved);
      if (close && !wasClose) this.approached();
    }

    if (zone === "on" && prev !== "on") {
      this.hoverStage = 0;
      this.hoverDue = this.tier === "none" ? null : n + (this.small ? 0.6 : 1.5);
    } else if (zone !== "on" && prev === "on") {
      this.hoverStage = 0;
      this.hoverDue = null;
    }

    if (zone === "far") this.left(n);
    if (close !== wasClose && !this.current) this.pose(320);
    this.onChange?.();
  }

  /** The cursor has no position any more (it left the window, on a system with no global cursor). */
  pointerLeave() {
    if (!this.known) return;
    this.known = false;
    if (!this._visible) return;
    const prev = this._zone;
    this._zone = "far";
    this.hoverDue = null;
    this.hoverStage = 0;
    this.dirty = true;
    if (!this._playful) {
      this.legacyOver = false;
      this.engine.tgEs = 1;
    } else if (prev !== "far") {
      this.left(now());
      if (!this.current) this.pose(320);
    }
    this.onChange?.();
  }

  /** A click on the bot (the host has done the hit test). */
  click(x: number, y: number) {
    if (!this._visible) return;
    const n = now();
    this.lastActivity = n;
    if (!this._playful) {
      this.engine.slap();
      this.onChange?.();
      return;
    }
    if (this.tier === "none" || n < this.dizzyUntil) return;
    if (this._napping || this.current?.name === "fallAsleep") {
      this.run("wake");
      this.onChange?.();
      return;
    }
    this.engaged = true;
    this.clicks = this.clicks.filter((t) => n - t < 2.4);
    this.clicks.push(n);
    const fast = this.clicks.filter((t) => n - t < 1.15).length;
    if (this.clicks.length >= 5) {
      this.clicks = [];
      this.run("dizzy");
    } else if (fast >= 3) {
      this.run("annoyed");
    } else if (n - this.lastClickAt < 0.35 && this.current) {
      // Too soon after the last one for a new reaction: a pat, on top of it.
      this.M("sy", [[0.86, 60, out], [1.06, 130, out], [1, 170, inOut]]);
      this.M("sx", [[1.1, 60, out], [0.97, 130, out], [1, 170, inOut]]);
      this.current.until = Math.max(this.current.until, n + 0.4);
    } else {
      this.lastClickAt = n;
      this.run(this.pickClick(), x, y);
    }
    this.onChange?.();
  }

  /**
   * Plays a reaction now, whatever its cooldown — but not against the status,
   * the size or reduced motion, which decide as they always do. Says what
   * happened: "played", or why not.
   */
  play(name: ReactionName, x?: number, y?: number): string {
    if (!this._visible) return "blocked: hidden";
    if (!this._playful) return "blocked: playful reactions are off";
    const tier = this.tier;
    if (tier === "none") return "blocked: dizzy";
    if (tier === "alert" && !QUICK_OK.has(name)) return `blocked: status ${this.status} wins`;
    if (tier === "busy" && IDLE_ONLY.has(name)) return `blocked: only when idle (status ${this.status})`;
    if (name === "hearts" && this.small) return "blocked: too small for hearts";
    if (name === "sproutSway" && this.reduced) return "blocked: reduced motion";
    if (name === "wake" && !this._napping) return "blocked: not asleep";
    if (name === "sleepBreath" && !this._napping) return "blocked: not asleep";
    if (this._napping && name !== "wake" && name !== "sleepBreath") this.unnap();
    this.lastActivity = now();
    this.run(name, x, y);
    this.onChange?.();
    return tier === "alert" ? "played (short: status wins)" : "played";
  }

  // ── The frame ───────────────────────────────────────────────────────────────

  /** Once per frame drawn, before `engine.update(dt)`. */
  update(dt: number) {
    if (!this._visible) return;
    const e = this.engine;
    const n = now();
    this.dirty = false;

    if (this.timeline.length) {
      const due = this.timeline.filter((s) => s.at <= n);
      if (due.length) {
        this.timeline = this.timeline.filter((s) => s.at > n);
        for (const s of due) s.fn();
      }
    }
    if (n >= this.beatDue) this.beat(n);
    if (this.current && n >= this.current.until) this.finish();
    // Belt and braces: under an alert nothing outlives its second.
    if (this.current && this.tier === "alert" && n - this.current.at > QUICK_MAX + 0.1) this.cancel(true);

    if (this.hoverDue != null && n >= this.hoverDue) {
      if (this._playful) this.hoverTick(n);
      else this.legacyLove(n);
    }

    if (this._playful && this.tier === "free") {
      const napAt = this.lastActivity + this.napAfter;
      if (!this.current && !this._napping && n >= napAt) {
        // Not with the cursor parked beside it: look again in a while.
        if (this._zone === "on" || this._zone === "near") this.lastActivity = n - this.napAfter + 30;
        else this.run("fallAsleep");
      } else if (n >= this.idleDue) {
        // Idle behaviours never stack, and never interrupt.
        if (this.current || this._zone === "on") this.idleDue = n + 4;
        else this.run(this._napping ? "sleepBreath" : this.pickIdle());
      }
    }

    // Where it looks, and how far it leans that way.
    const still = this.reduced;
    let lx = 0;
    let ly = 0;
    let lean = 0;
    if (!this._playful) {
      // island.ts lookX / lookY
      if (this.known) {
        lx = Math.tanh((this.px - this.cx) / 260);
        ly = -Math.tanh((this.py - this.cy) / 200);
      }
      e.lookRange = 1;
    } else {
      const dizzy = n < this.dizzyUntil;
      if (this.hold && n < this.hold.until) {
        lx = this.hold.x;
        ly = this.hold.y;
      } else if (dizzy && !still) {
        lx = Math.sin(n * 7) * 0.7;
        ly = Math.cos(n * 7) * 0.45;
      } else if (this._napping) {
        ly = -0.25;
      } else if (this.known && this._zone !== "far") {
        lx = Math.tanh((this.px - this.cx) / (this.d * 0.9));
        ly = -Math.tanh((this.py - this.cy) / (this.d * 0.8));
        if (still) { lx *= 0.6; ly *= 0.6; }
      }
      const small = this.small;
      e.lookRange = still ? 1 : small ? 1.9 : 1.65;
      if (!still && !small) lean = lx * 0.115 + (dizzy ? Math.sin(n * 5) * 0.1 : 0);
      if (dizzy && !still && this.current) e.sproutSpin = (n - this.current.at) * 11;
    }
    e.lookX = lx;
    e.lookY = ly;

    // A soft spring, a little under-damped: the body arrives, and settles.
    this.leanT = lean;
    if (this.lean !== lean || this.leanV !== 0) {
      const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        this.leanV += (13 * 13 * (lean - this.lean) - 2 * 0.45 * 13 * this.leanV) * h;
        this.lean += this.leanV * h;
      }
      if (Math.abs(lean - this.lean) < 0.0012 && Math.abs(this.leanV) < 0.012) {
        this.lean = lean;
        this.leanV = 0;
      }
    }
    e.lean = this.lean;
  }

  // ── Internals: pointer ──────────────────────────────────────────────────────

  private zoneAt(x: number, y: number): GulluZone {
    const dist = Math.hypot(x - this.cx, y - this.cy);
    const d = this.d;
    // A zone, once entered, is left a little further out than it was entered.
    const cur = this._zone;
    const on = d * (cur === "on" ? 0.68 : 0.58);
    const near = Math.max(90, d * 1.7) * (cur === "on" || cur === "near" ? 1.2 : 1);
    const aware = Math.max(360, d * 4.5) * (cur !== "far" ? 1.1 : 1);
    return dist <= on ? "on" : dist <= near ? "near" : dist <= aware ? "aware" : "far";
  }

  /** The cursor has come close. */
  private approached() {
    if (this.current || this.tier === "none" || !this.cooled("perk")) return;
    this.run("perk");
  }

  /** The cursor has gone far: if they had been together, it looks after it and sighs. */
  private left(n: number) {
    this.circ = 0;
    this.circAng = null;
    this.engine.tgEs = 1;
    const was = this.engaged;
    this.engaged = false;
    // A perk or a happy face still playing gives way to it; anything else does not.
    const playing = this.current?.name;
    if (playing && playing !== "perk" && playing !== "hoverHappy") return;
    if (!was || this.tier !== "free" || !this.cooled("sigh")) return;
    this.lastActivity = n;
    this.run("sigh");
  }

  /** Round and round the bot, fast: the eyes follow, widen, and then it is dizzy. */
  private circling(x: number, y: number, n: number, moved: number) {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const dist = Math.hypot(dx, dy);
    if (dist < this.d * 0.45 || this._zone === "far" || moved === 0) {
      this.circAng = null;
      return;
    }
    const ang = Math.atan2(dy, dx);
    if (this.circAng != null && n - this.circAt < 0.3) {
      let delta = ang - this.circAng;
      if (delta > Math.PI) delta -= TAU;
      if (delta < -Math.PI) delta += TAU;
      // What is not kept up leaks away: a slow turn never adds up.
      const leak = 2.6 * (n - this.circAt);
      this.circ = Math.sign(this.circ) * Math.max(0, Math.abs(this.circ) - leak) + delta;
    }
    this.circAng = ang;
    this.circAt = n;
    const turns = Math.abs(this.circ) / TAU;
    this.engine.tgEs = turns > 0.9 && !this.current ? 1.16 : 1;
    if (turns >= 2 && this.tier !== "none" && n >= this.dizzyUntil && this.cooled("circle")) {
      this.circ = 0;
      this.engine.tgEs = 1;
      this.engaged = true;
      this.run("dizzy");
    }
  }

  /** A hover that has lasted: happy first, and hearts if it goes on. */
  private hoverTick(n: number) {
    this.hoverDue = null;
    if (this._zone !== "on" || this._napping) return;
    if (this.current && this.current.name !== "hoverHappy") {
      this.hoverDue = n + 0.5; // something else is playing: after it
      return;
    }
    this.engaged = true;
    if (this.hoverStage === 0) {
      if (!this.cooled("hover")) return;
      this.hoverStage = 1;
      this.run("hoverHappy");
      if (this.tier !== "alert" && !this.small) this.hoverDue = this.current ? this.current.until - 0.05 : null;
    } else if (this.hoverStage === 1) {
      this.hoverStage = 2;
      if (this.cooled("hearts") && this.tier !== "alert") this.run("hearts");
    }
  }

  private legacyHover(x: number, y: number, n: number) {
    const over = Math.hypot(x - this.cx, y - this.cy) <= this.d * 0.83 && this.status !== "dizzy";
    if (over && !this.legacyOver) {
      if (n - this.lastLove >= 6) {
        this.legacyStart = { x, y };
        this.engine.blink();
        this.engine.tgEs = 1.08;
        this.onCue?.("hover");
        this.hoverDue = n + 1.9;
      }
    } else if (!over && this.legacyOver) {
      this.hoverDue = null;
      this.engine.tgEs = 1;
    } else if (over && this.hoverDue != null) {
      if (Math.hypot(x - this.legacyStart.x, y - this.legacyStart.y) > 40) {
        this.legacyStart = { x, y };
        this.hoverDue = n + 1.9;
      }
    }
    this.legacyOver = over;
  }

  private legacyLove(n: number) {
    this.hoverDue = null;
    if (!this.legacyOver || n - this.lastLove < 6) return;
    this.lastLove = n;
    this.engine.triggerEmote("love");
    this.onCue?.("love");
  }

  // ── Internals: choosing ─────────────────────────────────────────────────────

  /** One of the set, weighted, never the one before, seldom the one before that; one time in fifteen, something rare. */
  private pickClick(): ReactionName {
    const n = now();
    const roll = this.random();
    if (roll < 1 / 15 && this.tier !== "alert" && !this.small && !this.reduced && this.cooled("rare")) {
      const rare: ReactionName =
        this.lastRare === "spin" ? "raspberry" : this.lastRare === "raspberry" ? "spin"
          : this.random() < 0.5 ? "spin" : "raspberry";
      this.lastRare = rare;
      this.cool.set("rare", n + 30);
      return rare;
    }
    const [last, before] = this.picks;
    const weights = CLICK_SET.map((name) =>
      name === last ? 0 : name === before ? CLICK_WEIGHT[name] * 0.35 : CLICK_WEIGHT[name]);
    const pick = CLICK_SET[this.weighted(weights)];
    this.picks = [pick, last];
    return pick;
  }

  private pickIdle(): ReactionName {
    const sleepy = Math.min(1, (now() - this.lastActivity) / Math.max(1, this.napAfter));
    const weights = IDLE_SET.map((name) => {
      if (name === this.lastIdle) return 0;
      switch (name) {
        case "lookAround": return 1.2;
        case "doubleBlink": return 1;
        case "yawn": return 0.4 + sleepy * 1.6;
        case "sproutSway": return this.reduced ? 0 : 1;
        // Only when the cursor is somewhere it is not already looking.
        case "glance": return this.known && this._zone === "far" ? 1.1 : 0;
      }
    });
    const pick = IDLE_SET[this.weighted(weights)];
    this.lastIdle = pick;
    return pick;
  }

  private weighted(weights: number[]): number {
    let r = this.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.findIndex((w) => w > 0);
  }

  private cooled(family: string): boolean {
    return now() >= (this.cool.get(family) ?? 0);
  }

  private scheduleIdle() {
    const [lo, hi] = this._napping ? [20, 40] : this.idleEvery;
    this.idleDue = now() + lo + this.random() * (hi - lo);
  }

  /** The next beat of the status, if it has them: one at a random time in its range. */
  private scheduleBeat() {
    const every = this._visible && this.beats ? BEAT_EVERY[this.status] : undefined;
    this.beatDue = every ? now() + every[0] + this.random() * (every[1] - every[0]) : Number.POSITIVE_INFINITY;
  }

  /** A beat of the status: its looping extras play for a moment; now and then the sprout wiggles with it. */
  private beat(n: number) {
    this.engine.beat(BEAT_S);
    if (this._playful && WIGGLES.has(this.status) && n >= this.wiggleDue && !this.reduced) {
      this.wiggleDue = n + WIGGLE_EVERY[0] + this.random() * (WIGGLE_EVERY[1] - WIGGLE_EVERY[0]);
      this.M("sproutWiggle", [[0.5, 120, out], [0.5, 460, lin], [0, 220, inOut]]);
    }
    this.scheduleBeat();
  }

  private touch() {
    this.dirty = true;
    this.onChange?.();
  }

  // ── Internals: playing ──────────────────────────────────────────────────────

  private get quick(): boolean { return this.tier === "alert"; }

  /** Room above the resting figure, in R: a mini's canvas has a third of an R, the island's bot its overhang. */
  private get roomy(): boolean {
    const R = this.engine.drawnR;
    return R > 0 && 0.33 + this.engine.particleOverhang / R > 1.0;
  }

  /** A big move: a hop, a shake, a squash, a spin. Not under reduced motion. */
  private M(prop: MoveProp, keys: TweenKey[], done?: () => void) {
    if (this.reduced) return;
    // A canvas with no room above the bot (a mini's): nothing may make it
    // taller. It crouches where it would have jumped, and is pressed in less.
    if (!this.roomy) {
      if (prop === "sy") keys = keys.map(([v, ms, ease]) => [Math.min(v, 1.03), ms, ease]);
      else if (prop === "oy") keys = keys.map(([v, ms, ease]) => [Math.max(v, -0.07), ms, ease]);
      else if (prop === "poke") keys = keys.map(([v, ms, ease]) => [v * 0.4, ms, ease]);
    }
    this.engine.anim(prop, keys, done);
  }

  /** A small one, which reduced motion keeps: the eyes' size, a blush, the tongue, the sprout standing or wilting. */
  private S(prop: SoftProp, keys: TweenKey[]) {
    this.engine.anim(prop, keys);
  }

  private face(eye: EyeShape | null, mouth: MouthShape | null, brow: BrowShape | null, seconds: number) {
    const e = this.engine;
    e.eyeOverride = eye ?? e.cfg.eye;
    e.mouthOverride = mouth;
    e.browOverride = brow;
    e.eyeOverrideUntil = now() + (this.quick ? Math.min(seconds, QUICK_MAX - 0.05) : seconds);
  }

  private clearFace() {
    const e = this.engine;
    e.eyeOverride = e.permanentEye;
    e.mouthOverride = null;
    e.browOverride = null;
    e.eyeOverrideUntil = e.permanentEye ? Number.POSITIVE_INFINITY : 0;
  }

  private later(seconds: number, fn: () => void) {
    this.timeline.push({ at: now() + seconds, fn });
  }

  private cue(cue: GulluCue) {
    this.onCue?.(cue);
  }

  private begin(name: ReactionName, seconds: number): number {
    this.cancel(false);
    const n = now();
    const d = this.quick ? Math.min(seconds, QUICK_MAX) : seconds;
    this.current = { name, at: n, until: n + d };
    this.scheduleIdle();
    return d;
  }

  /** The reaction has played out: back to the pose the status and the cursor ask for. */
  private finish() {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    this.hold = null;
    if (cur.name === "dizzy") {
      this.dizzyUntil = 0;
      this.unwind("sproutSpin");
      this.engine.blink();
    }
    this.untint();
    this.pose(320);
    this.scheduleIdle();
  }

  /** A turn left unfinished goes on to the nearest whole one, and is then no turn at all. */
  private unwind(prop: "spin" | "sproutSpin") {
    const e = this.engine;
    if (e[prop] === 0) return;
    const to = Math.round(e[prop] / TAU) * TAU;
    e.anim(prop, [[to, 160, out]], () => { e[prop] = 0; });
  }

  /**
   * Stops what is playing. Its face comes off, what it had pending is dropped,
   * and everything it was moving goes back to rest in a tenth of a second.
   * With nothing playing, it does nothing.
   */
  private cancel(clearAir: boolean) {
    const cur = this.current;
    this.timeline = [];
    this.hold = null;
    this.dizzyUntil = 0;
    if (!cur) return;
    this.current = null;
    const e = this.engine;
    if (this._napping) this.napFace();
    else this.clearFace();
    this.untint();
    this.unwind("spin");
    this.unwind("sproutSpin");
    const rest: [MoveProp | SoftProp, number][] = [
      ["tongue", 0], ["poke", 0], ["sproutSwing", 0], ["oy", 0], ["ox", 0], ["sx", 1], ["sy", 1],
      ["es", 1], ["blush", 0], ["tilt", e.cfg.tilt],
    ];
    for (const [prop, to] of rest) {
      if (Math.abs(e[prop] - to) > 0.001) e.anim(prop, [[to, 110, out]]);
    }
    e.tgEs = 1;
    if (clearAir) this.pose(200);
  }

  private tint(color: RGB) {
    // Only an idle Gullu changes colour: any other status keeps its own, readable.
    if (this.tier !== "free") return;
    this.engine.colT = color;
    this.tinted = true;
  }

  private untint() {
    if (!this.tinted || this._napping) return;
    this.tinted = false;
    this.engine.colT = this.engine.cfg.color;
  }

  private napFace() {
    const e = this.engine;
    e.eyeOverride = "closed";
    e.mouthOverride = "tiny";
    e.browOverride = null;
    e.eyeOverrideUntil = Number.POSITIVE_INFINITY;
  }

  /** Awake at once, without the stretch (a status has come, or the switch was thrown). */
  private unnap() {
    if (!this._napping) return;
    this._napping = false;
    this.clearFace();
    this.untint();
  }

  /** What the sprout does when nothing else is asking: the status's pose, and up when the cursor is close. */
  private sproutWant(): { perk: number; droop: number; wiggle: number } {
    if (!this._playful) return { perk: 0, droop: 0, wiggle: 0 };
    if (this._napping) return { perk: 0, droop: 1, wiggle: 0 };
    const close = this._zone === "on" || this._zone === "near";
    const top = this.roomy ? 1 : 0.1;
    let perk = close ? top : 0;
    let droop = 0;
    let wiggle = 0;
    switch (this.status) {
      case "working":
      case "searching":
        perk = Math.max(perk, 0.3 * top);
        break;
      case "approval":
      case "finished":
        perk = top;
        break;
      case "question":
        perk = Math.max(perk, 0.6 * top);
        break;
      case "error":
        perk = 0;
        droop = 0.7;
        break;
      case "ratelimit":
        perk = 0;
        droop = 0.4;
        break;
      case "sleeping":
      case "dizzy":
        perk = 0;
        break;
    }
    return { perk, droop, wiggle };
  }

  /** Eases the sprout to its pose. */
  private pose(ms: number) {
    const e = this.engine;
    const want = this.sproutWant();
    // Against the last pose asked for as well: a tween towards it may not have moved yet.
    const was = this.posed;
    this.posed = want;
    if (Math.abs(e.sproutPerk - want.perk) > 0.002 || was.perk !== want.perk) e.anim("sproutPerk", [[want.perk, ms, inOut]]);
    if (Math.abs(e.sproutDroop - want.droop) > 0.002 || was.droop !== want.droop) e.anim("sproutDroop", [[want.droop, ms, inOut]]);
    if (Math.abs(e.sproutWiggle - want.wiggle) > 0.002 || was.wiggle !== want.wiggle) e.anim("sproutWiggle", [[want.wiggle, ms, inOut]]);
  }
  private posed = { perk: 0, droop: 0, wiggle: 0 };

  /** The sprout springs up to `peak` and settles into its pose. */
  private sproutPop(peak: number) {
    const want = this.sproutWant();
    const top = this.roomy ? peak : Math.min(peak, 0.1);
    this.S("sproutPerk", [[Math.max(top, want.perk), 130, out], [want.perk, 420, inOut]]);
    if (want.droop > 0) this.S("sproutDroop", [[want.droop * 0.25, 130, out], [want.droop, 520, inOut]]);
  }

  /** A hop no higher than the canvas has room for. */
  private up(h: number): number {
    return this.roomy ? h : Math.min(h, 0.07);
  }

  /** Where there is no room to jump: down, and back up with a little spring. */
  private crouch() {
    if (this.roomy) return;
    this.M("sy", [[0.8, 80, out], [1.03, 140, out], [1, 170, inOut]]);
    this.M("sx", [[1.12, 80, out], [0.98, 140, out], [1, 170, inOut]]);
  }

  // ── The reactions ───────────────────────────────────────────────────────────

  private run(name: ReactionName, x?: number, y?: number): void {
    const e = this.engine;
    const small = this.small;
    const still = this.reduced;
    const roomy = this.roomy;
    const want = this.sproutWant();
    const ct = e.cfg.tilt;

    switch (name) {
      // ── The cursor ────────────────────────────────────────────────────────
      case "perk": {
        // "Oh! Someone's coming": a little hop and stretch, big eyes, the sprout up.
        this.begin("perk", 0.6);
        this.cue("perk");
        this.cool.set("perk", now() + 8);
        this.face("wide", null, null, 0.45);
        this.S("es", [[1.2, 120, out], [1, 380, inOut]]);
        this.M("oy", [[-this.up(0.26), 130, out], [0, 260, back]]);
        this.crouch();
        if (roomy) {
          this.M("sy", [[1.1, 130, out], [1, 300, back]]);
          this.M("sx", [[0.94, 130, out], [1, 300, back]]);
        }
        this.sproutPop(1.4);
        break;
      }
      case "hoverHappy": {
        // Being kept company: happy eyes, a blush, the sprout wagging.
        const d = this.begin("hoverHappy", small ? 0.9 : 1.9);
        this.cue("happy");
        this.cool.set("hover", now() + d + 6);
        this.face("happy", "grin", null, d - 0.1);
        this.S("blush", [[0.9, 220, out], [0.9, Math.max(60, (d - 0.6) * 1000), lin], [0, 300, inOut]]);
        if (small) {
          this.M("oy", [[-this.up(0.22), 120, out], [0, 230, back]]);
          this.crouch();
        } else {
          this.M("sy", [[1.07, 130, out], [1, 260, back]]);
          this.M("sx", [[0.95, 130, out], [1, 260, back]]);
        }
        this.M("sproutWiggle", [[0.9, 100, out], [0.9, Math.max(60, (d - 0.5) * 1000), lin], [want.wiggle, 250, inOut]]);
        this.sproutPop(1.2);
        break;
      }
      case "hearts": {
        this.begin("hearts", 2.2);
        this.cue("love");
        this.cool.set("hearts", now() + 20);
        this.face("heart", "w", null, 2.05);
        this.S("blush", [[1, 200, out], [1, 1500, lin], [0, 320, inOut]]);
        this.M("oy", [[-this.up(0.16), 160, out], [0, 320, back]]);
        this.M("sproutWiggle", [[0.7, 100, out], [0.7, 900, lin], [want.wiggle, 300, inOut]]);
        this.sproutPop(1.3);
        if (!small && !still) e.emit("heart", 6);
        break;
      }
      case "dizzy": {
        // Spiral eyes, the head rolling, the sprout a propeller.
        const d = this.begin("dizzy", still ? 1.6 : 2.6);
        this.cue("dizzy");
        this.cool.set("circle", now() + 10);
        this.clicks = [];
        this.face("spiral", "wobble", null, d);
        // The spirals are thin lines: bigger, they still read on a small bot.
        this.S("es", [[1.45, 160, out], [1.45, Math.max(60, d * 1000 - 420), lin], [1, 240, inOut]]);
        e.keepLive(d);
        this.dizzyUntil = now() + d;
        this.tint(DIZZY_COLOR);
        this.M("sy", [[0.84, 70, out], [1.08, 140, out], [1, 190, inOut]]);
        this.M("sx", [[1.13, 70, out], [0.96, 140, out], [1, 190, inOut]]);
        this.S("sproutPerk", [[roomy ? 0.5 : 0.1, 200, out]]);
        break;
      }
      case "sigh": {
        // It looks after the cursor, then lets its breath out and comes back.
        const dx = this.px - this.cx;
        const dy = this.py - this.cy;
        const len = Math.hypot(dx, dy) || 1;
        const hx = this.known ? dx / len : 0.9;
        const hy = this.known ? -dy / len : 0.1;
        this.begin("sigh", 1.55);
        this.cool.set("sigh", now() + 15);
        this.hold = { x: hx, y: hy, until: now() + 0.7 };
        this.S("sproutPerk", [[0, 500, inOut]]);
        this.later(0.7, () => {
          this.cue("sigh");
          this.hold = { x: hx * 0.2, y: -0.5, until: now() + 0.7 };
          this.face("closed", "o", null, 0.68);
          this.M("sy", [[0.91, 300, inOut], [1, 400, inOut]]);
          this.M("sx", [[1.06, 300, inOut], [1, 400, inOut]]);
          this.S("sproutDroop", [[Math.max(0.6, want.droop), 300, inOut], [want.droop, 480, inOut]]);
          if (!small && !still) e.emit("puff", 1);
        });
        break;
      }

      // ── A click ───────────────────────────────────────────────────────────
      case "surprised": {
        // A jump, pin-point eyes, the sprout shot up.
        this.begin("surprised", 0.9);
        this.cue("gasp");
        this.face("dot", "O", null, 0.75);
        this.S("es", [[1.4, 100, out], [1, 520, inOut]]);
        this.M("oy", [[-this.up(0.42), 130, out], [0, 380, back]]);
        this.crouch();
        if (roomy) {
          this.M("sy", [[1.14, 120, out], [0.9, 230, inOut], [1, 220, back]]);
          this.M("sx", [[0.92, 120, out], [1.07, 230, inOut], [1, 220, back]]);
        }
        this.sproutPop(1.7);
        break;
      }
      case "naughty": {
        // A wink and its tongue out — or, as often as not, just a cheeky half-smile — and a giggle.
        const tongue = this.random() < 0.65 && !small;
        const d = this.begin("naughty", 1.15);
        this.cue("giggle");
        this.face("wink", tongue ? "smile" : "smirk", null, d - 0.1);
        if (tongue) this.S("tongue", [[1.15, 140, out], [1, 90, inOut], [1, Math.max(60, d * 1000 - 500), lin], [0, 150, inOut]]);
        this.M("tilt", [[ct + 0.15, 140, out], [ct + 0.15, Math.max(60, (d - 0.5) * 1000), lin], [ct, 220, inOut]]);
        this.M("sproutSwing", [[0.6, 140, out], [0.6, Math.max(60, (d - 0.5) * 1000), lin], [0, 220, inOut]]);
        this.later(0.28, () => {
          this.M("ox", [[0.05, 50, out], [-0.05, 70, inOut], [0.04, 70, inOut], [-0.03, 60, inOut], [0, 70, out]]);
        });
        break;
      }
      case "ticklish": {
        // Eyes screwed shut, a laugh, wriggling all over.
        const d = this.begin("ticklish", 1.2);
        this.cue("laugh");
        this.face("squeeze", "laugh", null, d - 0.15);
        this.M("tilt", [
          [ct + 0.1, 70, out], [ct - 0.1, 110, inOut], [ct + 0.09, 110, inOut], [ct - 0.08, 110, inOut],
          [ct + 0.05, 100, inOut], [ct, 120, out],
        ]);
        this.M("sy", [
          [0.85, 80, out], [1.13, 120, inOut], [0.9, 120, inOut], [1.08, 120, inOut], [0.96, 110, inOut], [1, 140, out],
        ]);
        this.M("sx", [
          [1.09, 80, out], [0.92, 120, inOut], [1.06, 120, inOut], [0.95, 120, inOut], [1.03, 110, inOut], [1, 140, out],
        ]);
        this.S("blush", [[0.85, 150, out], [0.85, Math.max(60, (d - 0.55) * 1000), lin], [0, 300, inOut]]);
        this.M("sproutWiggle", [[1, 80, out], [1, Math.max(60, (d - 0.45) * 1000), lin], [want.wiggle, 200, inOut]]);
        if (!small && !still) e.emit("spark", 3);
        break;
      }
      case "boop": {
        // Pressed in where the finger landed, it springs back out and looks at the spot.
        this.begin("boop", 0.85);
        this.cue("boop");
        const ang = x != null && y != null
          ? Math.atan2(y - (this.cy + this.d * 0.12), x - this.cx)
          : (this.random() < 0.5 ? Math.PI : 0) - 0.5 + this.random();
        e.pokeAngle = ang;
        this.M("poke", [[1, 70, out], [-0.45, 130, out], [0.18, 110, inOut], [0, 120, inOut]]);
        this.M("sproutSwing", [[-Math.cos(ang) * 0.9, 80, out], [Math.cos(ang) * 0.5, 150, inOut], [0, 220, inOut]]);
        this.hold = { x: Math.cos(ang) * 0.9, y: -Math.sin(ang) * 0.9, until: now() + 0.45 };
        this.face("wide", "o", null, 0.48);
        this.S("es", [[1.18, 80, out], [1, 320, inOut]]);
        this.later(0.5, () => this.face("happy", "smile", null, 0.3));
        break;
      }
      case "annoyed": {
        // Enough: flat eyes, a frown, a shake, the sprout flat on its head.
        this.begin("annoyed", 0.9);
        this.cue("annoyed");
        this.face("flat", "flat", "angry", 0.85);
        this.M("sy", [[0.82, 70, out], [1.08, 140, out], [1, 190, inOut]]);
        this.M("sx", [[1.14, 70, out], [0.96, 140, out], [1, 190, inOut]]);
        this.M("ox", [[0.05, 60, out], [-0.05, 80, inOut], [0.03, 80, inOut], [0, 90, out]]);
        this.S("sproutPerk", [[0, 120, out], [want.perk, 600, inOut]]);
        this.S("sproutDroop", [[Math.max(0.65, want.droop), 120, out], [want.droop, 600, inOut]]);
        break;
      }
      case "spin": {
        // Rare: once round on the spot, in the air, and proud of it.
        if (still) {
          this.begin("spin", 0.9);
          this.cue("whee");
          this.face("star", "grin", null, 0.8);
          break;
        }
        this.begin("spin", 1.3);
        this.cue("whee");
        this.face("wide", "O", null, 0.7);
        this.M("spin", [[TAU, 640, inOut]], () => { e.spin = 0; });
        this.M("sproutSpin", [[TAU * 2, 720, out]], () => { e.sproutSpin = 0; });
        this.M("oy", [[-this.up(0.3), 200, out], [-this.up(0.3), 300, lin], [0, 240, back]]);
        this.later(0.72, () => {
          this.face("happy", "grin", null, 0.5);
          this.M("sy", [[0.84, 70, out], [1.08, 140, out], [1, 190, inOut]]);
          this.M("sx", [[1.13, 70, out], [0.96, 140, out], [1, 190, inOut]]);
          if (!small) e.emit("star", 3);
        });
        this.sproutPop(1.2);
        break;
      }
      case "raspberry": {
        // Rare: eyes shut tight, tongue out, a long rude noise — and no remorse.
        if (small) return this.run("naughty", x, y);
        this.begin("raspberry", 1.5);
        this.cue("raspberry");
        this.face("squeeze", "flat", null, 1.08);
        this.S("tongue", [[1.15, 110, out], [1, 90, inOut], [1, 760, lin], [0, 140, inOut]]);
        const shake: TweenKey[] = [];
        for (let i = 0; i < 16; i++) shake.push([i % 2 ? -0.03 : 0.03, 55, inOut]);
        shake.push([0, 80, out]);
        this.M("ox", shake);
        this.M("sy", [[0.93, 120, out], [0.93, 800, lin], [1, 220, back]]);
        this.M("sx", [[1.06, 120, out], [1.06, 800, lin], [1, 220, back]]);
        this.M("sproutWiggle", [[0.7, 100, out], [0.7, 820, lin], [want.wiggle, 160, inOut]]);
        if (!still) e.emit("puff", 6, 0.12);
        this.later(1.1, () => this.face("happy", "smirk", null, 0.38));
        break;
      }

      // ── Nothing happening ─────────────────────────────────────────────────
      case "lookAround": {
        // One way, the other, up — the body turning with the eyes.
        const side = this.random() < 0.5 ? -1 : 1;
        this.begin("lookAround", 2.3);
        this.hold = { x: side * 0.95, y: 0.1, until: now() + 0.75 };
        this.later(0.8, () => { this.hold = { x: -side * 0.95, y: 0.15, until: now() + 0.75 }; });
        this.later(1.6, () => { this.hold = { x: 0, y: 0.85, until: now() + 0.5 }; });
        break;
      }
      case "doubleBlink": {
        this.begin("doubleBlink", 0.75);
        e.blink();
        this.later(0.25, () => e.blink());
        this.M("tilt", [[ct + 0.07, 150, out], [ct + 0.07, 280, lin], [ct, 220, inOut]]);
        break;
      }
      case "yawn": {
        this.begin("yawn", 1.9);
        this.cue("yawn");
        this.yawn();
        break;
      }
      case "sproutSway": {
        // It notices its own sprout: looks up at it, and waves it about.
        this.begin("sproutSway", 2.7);
        this.hold = { x: 0, y: 0.95, until: now() + 2.05 };
        this.face(null, "o", "raise", 2.0);
        this.M("sproutSwing", [
          [0.9, 350, inOut], [-0.9, 550, inOut], [0.7, 500, inOut], [-0.5, 450, inOut], [0, 400, inOut],
        ]);
        this.later(2.1, () => this.face("happy", "smile", null, 0.5));
        break;
      }
      case "glance": {
        // "Where did the cursor get to?"
        if (!this.known) return this.run("lookAround");
        const dx = this.px - this.cx;
        const dy = this.py - this.cy;
        const len = Math.hypot(dx, dy) || 1;
        this.begin("glance", 1.5);
        this.hold = { x: dx / len, y: -dy / len, until: now() + 1.1 };
        this.face(null, null, "raise", 1.1);
        this.S("es", [[1.1, 150, out], [1.1, 700, lin], [1, 250, inOut]]);
        break;
      }
      case "fallAsleep": {
        // A yawn, the eyes close, the sprout sinks, two slow breaths — and then it lies still.
        this.begin("fallAsleep", 6.5);
        this.cue("yawn");
        this.yawn();
        this.later(1.55, () => {
          this._napping = true;
          this.cue("sleep");
          this.napFace();
          this.tint(SLEEP_COLOR);
          this.S("sproutPerk", [[0, 400, inOut]]);
          this.S("sproutDroop", [[1, 800, inOut]]);
          this.M("sy", [[1.05, 1200, inOut], [1, 1200, inOut], [1.05, 1200, inOut], [1, 1200, inOut]]);
          this.M("sx", [[0.97, 1200, inOut], [1, 1200, inOut], [0.97, 1200, inOut], [1, 1200, inOut]]);
          if (!small && !still) {
            e.emit("z", 1, 0.9);
            this.later(2.4, () => e.emit("z", 1, 0.9));
          }
        });
        break;
      }
      case "sleepBreath": {
        // Asleep, it lies still — no frame is drawn — and breathes once in a while.
        this.begin("sleepBreath", 2.5);
        this.M("sy", [[1.05, 1200, inOut], [1, 1200, inOut]]);
        this.M("sx", [[0.97, 1200, inOut], [1, 1200, inOut]]);
        if (!small && !still) e.emit("z", 1, 0.9);
        else this.S("sproutDroop", [[0.85, 1200, inOut], [1, 1200, inOut]]);
        break;
      }
      case "wake": {
        // A stretch, a squint at the light, and it is glad to see you.
        this._napping = false;
        this.begin("wake", 1.3);
        this.clearFace();
        this.untint();
        this.cue("wake");
        const awake = this.sproutWant();
        this.face("squint", "yawn", null, 0.56);
        this.M("sy", [[1.16, 260, out], [1.16, 280, lin], [1, 320, back]]);
        this.M("sx", [[0.9, 260, out], [0.9, 280, lin], [1, 320, back]]);
        this.S("sproutDroop", [[awake.droop, 220, out]]);
        this.S("sproutPerk", [[roomy ? 1.3 : 0.1, 300, roomy ? back : out], [awake.perk, 500, inOut]]);
        this.later(0.58, () => {
          e.blink();
          this.face("happy", "smile", null, 0.6);
        });
        break;
      }
    }
  }

  private yawn() {
    const e = this.engine;
    const want = this.sproutWant();
    this.face("squint", "yawn", null, 1.0);
    this.M("sy", [[1.12, 500, inOut], [1, 500, inOut]]);
    this.M("sx", [[0.94, 500, inOut], [1, 500, inOut]]);
    this.S("sproutPerk", [[Math.max(this.roomy ? 0.6 : 0.1, want.perk), 500, inOut], [want.perk, 500, inOut]]);
    this.later(1.0, () => {
      this.face("closed", "tiny", null, 0.7);
      if (!this.small && !this.reduced) e.emit("z", 1);
    });
  }
}
