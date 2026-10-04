// The launch greeting — port of GreetingCanvasView.swift.
// Everything is laid out in the same 640×150 reference space as on macOS.
//
// The sequence and its timing are the original's; the character is the Nook
// bot, drawn by the engine itself from the pose of each frame. Where the
// original waved a hand, the bot waves its arm, grinning; where a badge popped
// up, its sprout lights up; where the body took a tint, its sprout does.

import { Sound } from "../core/sound";
import { wipe } from "../core/canvas";
import { COMPACT_BOT, COMPACT_W, NOTCH_H, NOTCH_W } from "../core/layout";
import { BODY_H, BODY_W, BOT_R, BOT_STATES, BotEngine, hexToRGB, type EyeShape } from "./engine";

// ── Timing (mirrors greeting-v2.html `T`) ─────────────────────────────────────

const T = {
  grow: 0.45,
  squint0: 0.6,
  squint1: 0.82,
  dip0: 1.25,
  dip1: 1.4,
  pop0: 1.36,
  pop1: 1.52,
  content0: 2.45,
  content1: 2.58,
  tuck0: 2.58,
  tuck1: 2.8,
  badge: 2.72,
  down0: 2.85,
  down1: 3.2,
  blink2: 3.8,
  tint0: 3.85,
  tint1: 4.15,
  end: 4.6,
  autoLeave: 4.9,
  COLLAPSE: 0.34,
};

/**
 * The sequence's own seconds pass this much faster than the clock's: the
 * original's 4.6 s are 2.3 here — a short hello, a light one (it is drawn on
 * a 640x150 canvas, at a frame rate the island paces itself).
 */
export const GREETING_SPEED = 2;

export const GREETING_END = T.end / GREETING_SPEED;

// ── Geometry (640×150) ────────────────────────────────────────────────────────

const C0 = { x: 320, y: 90 };
const HB = 58;
/** The bot's body, width over height. */
const ASP = BODY_W / BODY_H;
const EAR_X = 40;
const EAR_Y = NOTCH_H / 2;
/** The compact island's bot (botPosition): its diameter, so a canvas of that / 0.6. */
const EAR_HB = (COMPACT_BOT / 0.6) * BOT_R * BODY_H;
const CARD = { x: 10, y: 36, w: 620, h: 104 };
const CARD_R = 20;
const SMALL_W = COMPACT_W;
const SMALL_H = NOTCH_H;

// ── Easing ────────────────────────────────────────────────────────────────────

const E = {
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);

// ── Pose ──────────────────────────────────────────────────────────────────────

type EyeType = Extract<EyeShape, "bead" | "happy" | "closed">;

interface Pose {
  hb: number; x: number; y: number; sx: number; sy: number; tilt: number;
  eye: EyeType; open: number; eyeRoll: number;
  lookX: number; lookY: number;
  /** The arm up and waving hello, 0…1. */
  wave: number;
  /** The sprout lighting up (0 = dim, 1 = lit). */
  badge: number;
  halo: number; haloBlue: number; minis: number; fx: number;
  header: number; card: number;
  iw: number; ih: number;
}

function greetPose(t: number): Pose {
  const gx = seg(t, 0, 0.5);
  const g = Math.sin((Math.PI * gx) / 2) + 0.04 * Math.sin(Math.PI * gx) * gx;
  const iw = lerp(NOTCH_W, 640, g);
  const ih = lerp(NOTCH_H, 150, g);

  const gg = E.back(seg(t, 0.02, T.grow));
  const hb = lerp(3, HB, gg);
  let x = C0.x;
  let y = lerp(NOTCH_H / 2, C0.y, E.out(seg(t, 0.02, T.grow)));
  let sx = 1;
  let sy = 1;
  let tilt = 0;

  if (t >= T.dip0 && t < T.pop1) {
    const k = Math.sin(Math.PI * seg(t, T.dip0, T.pop1));
    y += hb * 0.22 * k;
    sy = 1 - 0.06 * k;
    sx = 1 + 0.04 * k;
  }
  if (t >= T.pop1 && t < T.tuck1) {
    const w = t - T.pop1;
    const fade = 1 - seg(t, T.tuck0, T.tuck1);
    x += Math.sin(w * 2 * Math.PI * 0.9) * hb * ASP * 0.05 * fade;
    tilt = Math.sin(w * 2 * Math.PI * 0.9 + 0.6) * 0.05 * fade;
    y += Math.sin(w * 2 * Math.PI * 1.8) * 0.8 * fade;
  }
  if (t >= T.tuck0 && t < T.down1) {
    y += hb * 0.12 * Math.sin(Math.PI * seg(t, T.tuck0, T.down1));
  }

  let eye: EyeType = "bead";
  if (t >= T.squint0 && t < T.squint1) eye = "happy";
  if (t >= T.content0 && t < T.content1) eye = "closed";
  if (t >= T.down0 && t < T.down1) eye = "closed";
  let eyeRoll = 0;
  if (t >= T.dip0 && t < T.pop1) eyeRoll = Math.sin(Math.PI * seg(t, T.dip0, T.pop1));
  const blink = (tb: number) => {
    const k = seg(t, tb, tb + 0.12);
    return k > 0 && k < 1 ? 1 - Math.sin(Math.PI * k) * 0.94 : 1;
  };
  const open = Math.min(blink(1.95), blink(T.blink2));

  let lookX = 0;
  let lookY = 0;
  if (t >= T.squint1 && t < T.dip0) lookY = -0.2;
  if (t >= T.pop1 && t < T.content0) { lookX = 0.55; lookY = -0.45; }
  if (t >= T.content0 && t < T.down1) { lookX = -0.3; lookY = 0.6; }
  if (t >= T.down1) {
    const k = E.inOut(seg(t, T.down1, T.down1 + 0.35));
    lookX = lerp(-0.3, 0, k);
    lookY = lerp(0.6, 0, k);
  }

  // The wave: the arm goes up between the pop and the tuck, eased in and out
  // at both ends; the engine shakes it.
  let wave = 0;
  if (t >= T.pop1 && t < T.tuck0) {
    wave = E.inOut(Math.min(1, (t - T.pop1) / 0.15, (T.tuck0 - t) / 0.15));
  }

  return {
    hb, x, y, sx, sy, tilt,
    eye, open, eyeRoll,
    lookX, lookY,
    wave,
    badge: E.back(seg(t, T.badge, T.badge + 0.28)),
    halo: E.out(seg(t, 0.3, 0.7)),
    haloBlue: seg(t, T.tint0, T.tint1),
    minis: 0,
    fx: 1,
    header: seg(t, 0.35, 0.6),
    card: seg(t, 0.18, 0.45),
    iw, ih,
  };
}

function smallPose(): Pose {
  return {
    hb: EAR_HB,
    x: 320 - SMALL_W / 2 + EAR_X,
    y: EAR_Y,
    sx: 1, sy: 1, tilt: 0,
    eye: "bead", open: 1, eyeRoll: 0,
    lookX: 0, lookY: 0,
    wave: 0,
    badge: 1, halo: 0.6, haloBlue: 1,
    minis: 1, fx: 1,
    header: 0, card: 0,
    iw: SMALL_W, ih: SMALL_H,
  };
}

function pose(t: number, tc: number): Pose {
  if (t < tc) return greetPose(Math.min(t, T.end + 10));
  const a = greetPose(tc);
  const b = smallPose();
  const e = E.inOut(seg(t, tc, tc + T.COLLAPSE));
  const p: Pose = { ...a };
  p.iw = lerp(a.iw, b.iw, e);
  p.ih = lerp(a.ih, b.ih, e);
  p.x = lerp(a.x, b.x, e);
  p.y = lerp(a.y, b.y, e);
  p.hb = lerp(a.hb, b.hb, e);
  p.badge = lerp(a.badge, b.badge, e);
  p.halo = lerp(a.halo, b.halo, e);
  p.haloBlue = lerp(a.haloBlue, b.haloBlue, e);
  p.header = a.header * (1 - seg(t, tc, tc + 0.1));
  p.card = a.card * (1 - seg(t, tc, tc + 0.18));
  p.wave = a.wave * (1 - seg(t, tc, tc + 0.15));
  p.tilt = a.tilt * (1 - e);
  p.sx = lerp(a.sx, 1, e);
  p.sy = lerp(a.sy, 1, e);
  p.eyeRoll = a.eyeRoll * (1 - e);
  const bk = seg(t, tc + 0.14, tc + 0.26);
  p.eye = "bead";
  p.open = bk > 0 && bk < 1 ? 1 - Math.sin(Math.PI * bk) * 0.94 : 1;
  p.lookX = a.lookX * (1 - e);
  p.lookY = a.lookY * (1 - e);
  p.minis = E.back(seg(t, tc + 0.24, tc + 0.42));
  p.fx = 1 - seg(t, tc, tc + 0.2);
  return p;
}

// ── Particles (seeded LCG, seed = 7, identical sequence to the Swift version) ──

interface RingDot { a: number; j: number; s: number; al: number }
interface Ring { t0: number; dots: RingDot[] }
interface Streak { a: number; sp: number; len: number; t0: number; col: string }

const PARTICLES = (() => {
  let seed = 7;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const rings: Ring[] = [0.1, 0.2, 0.3, 0.45, 0.6].map((t0) => ({
    t0,
    dots: Array.from({ length: 170 }, () => ({
      a: rnd() * Math.PI * 2,
      j: (rnd() - 0.5) * 0.22,
      s: 0.7 + rnd() * 0.9,
      al: 0.45 + rnd() * 0.55,
    })),
  }));
  const cols = ["#3B9EFF", "#F29B38", "#FF5A4E", "#2EC4A0", "#A78BFA"];
  const streaks: Streak[] = Array.from({ length: 16 }, (_, i) => ({
    a: (i / 16) * Math.PI * 2 + (rnd() - 0.5) * 0.3,
    sp: 230 + rnd() * 260,
    len: 6 + rnd() * 9,
    t0: 0.08 + rnd() * 0.14,
    col: cols[i % 5],
  }));
  return { rings, streaks };
})();

// ── Drawing ───────────────────────────────────────────────────────────────────

function rr(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number) {
  const r = Math.max(0, Math.min(R, W / 2, H / 2));
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r);
  x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r);
  x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

/** The greeting's own bot: never updated, only posed and drawn. */
const bot = new BotEngine();
const IDLE = BOT_STATES.idle.color;
const WORKING = BOT_STATES.working.color;

function drawBot(x: CanvasRenderingContext2D, p: Pose) {
  const R = p.hb / BODY_H;
  if (R <= 0.4) return;
  const hw = (R * BODY_W) / 2;

  // Halo: the bot's resting colour → the blue of work, two passes for a soft aura
  const bl = p.haloBlue;
  const col = [0, 1, 2].map((i) => lerp(IDLE[i], WORKING[i], bl)) as [number, number, number];
  if (p.halo > 0) {
    const [cr, cg, cb] = col.map((c) => Math.round(c * 255));
    for (const [radius, alpha] of [[hw * 2.6, 0.18], [hw * 4.2, 0.07]] as const) {
      const g = x.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha * p.halo})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      x.fillStyle = g;
      x.beginPath();
      x.arc(p.x, p.y, radius, 0, Math.PI * 2);
      x.fill();
    }
  }

  // The pose, handed to the engine: it draws in a square of side R / BOT_R and
  // centres the bot in it, so that square is centred on the pose.
  bot.col = col;
  bot.eyeOverride = p.eye;
  // Waving, it grins; otherwise the mouth that goes with its eyes.
  bot.mouthOverride = p.wave > 0.01 ? "grin" : null;
  // The dip: the eyes squeeze shut as the bot ducks.
  bot.open = p.open * (1 - 0.8 * p.eyeRoll);
  bot.lx = p.lookX * 1.5;
  bot.ly = -p.lookY * 1.5;
  bot.tilt = p.tilt;
  bot.sx = p.sx;
  bot.sy = p.sy;
  bot.glow = 0.35 + 0.65 * p.badge;
  bot.sway = -p.tilt * 1.4 - bot.lx * 0.15;
  bot.wave = p.wave;

  const side = R / BOT_R;
  x.save();
  x.translate(p.x - side / 2, p.y - side / 2);
  bot.draw(x, side, side);
  x.restore();
}

function drawParticles(x: CanvasRenderingContext2D, t: number, p: Pose) {
  if (!(p.card > 0 || p.fx < 1)) return;
  for (const ring of PARTICLES.rings) {
    const k = seg(t, ring.t0, ring.t0 + 1.35);
    if (k <= 0 || k >= 1) continue;
    const rx = lerp(14, 380, E.out(k));
    const ry = rx * 0.34;
    const fade = (1 - k) * (k < 0.08 ? k / 0.08 : 1) * p.fx * p.card;
    for (const dot of ring.dots) {
      const r = 1 + dot.j;
      x.fillStyle = `rgba(255,255,255,${dot.al * fade})`;
      x.fillRect(C0.x + Math.cos(dot.a) * rx * r, C0.y + Math.sin(dot.a) * ry * r, dot.s, dot.s);
    }
  }
  for (const s of PARTICLES.streaks) {
    const k = seg(t, s.t0, s.t0 + 0.6);
    if (k <= 0 || k >= 1) continue;
    const dist = s.sp * E.out(k) * 0.9 + 10;
    const alpha = (1 - k) * p.fx;
    x.strokeStyle = s.col + Math.round(alpha * 255).toString(16).padStart(2, "0");
    x.lineWidth = 1.6;
    x.lineCap = "round";
    x.beginPath();
    x.moveTo(C0.x + Math.cos(s.a) * (dist - s.len), C0.y + Math.sin(s.a) * (dist - s.len) * 0.42);
    x.lineTo(C0.x + Math.cos(s.a) * dist, C0.y + Math.sin(s.a) * dist * 0.42);
    x.stroke();
  }
}

const MINI_COLORS = ["#E86A6A", "#3E86E0", "#EFAE5A", "#8C73F2"].map(hexToRGB);
/** A mini's body here is 10.6 across. */
const MINI_SIDE = 10.6 / (BODY_W * BOT_R);

/** The grid's minis' stand-in: like the greeting's bot, never updated, only drawn. */
const mini = new BotEngine();

/** The four minis of the compact grid, as the engine draws them at that size. */
function drawMinis(x: CanvasRenderingContext2D, alpha: number) {
  if (alpha <= 0.01) return;
  const cx = 320 + SMALL_W / 2 - 27;
  const cy = NOTCH_H / 2;
  const sp = 6;
  const offsets: [number, number][] = [[-sp, -sp], [sp, -sp], [-sp, sp], [sp, sp]];
  offsets.forEach(([dx, dy], i) => {
    x.save();
    x.translate(cx + dx, cy + dy);
    x.scale(alpha, alpha);
    x.translate(-MINI_SIDE / 2, -MINI_SIDE / 2);
    mini.bodyColor = MINI_COLORS[i];
    mini.draw(x, MINI_SIDE, MINI_SIDE);
    x.restore();
  });
}

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * Runs the greeting animation on its own canvas. `onComplete` fires once at
 * T.end (or right after the collapse when interrupted) so the FSM can move on.
 */
export class Greeting {
  private startMs = 0;
  private tc = Number.POSITIVE_INFINITY;
  private fired = false;
  private timers: number[] = [];

  onComplete: (() => void) | null = null;

  start() {
    this.startMs = performance.now();
    this.tc = Number.POSITIVE_INFINITY;
    this.fired = false;
    this.cancelTimers();
    this.timers.push(
      window.setTimeout(() => Sound.play("greet"), (T.pop0 / GREETING_SPEED) * 1000),
      window.setTimeout(() => Sound.play("blip"), (T.badge / GREETING_SPEED) * 1000),
      window.setTimeout(() => this.fire(), (T.end / GREETING_SPEED + 0.05) * 1000),
    );
  }

  /** Mouse entered the island during the greeting — hold it open. */
  hover() {
    if (this.tc >= T.autoLeave) this.tc = Number.POSITIVE_INFINITY;
  }

  /** Mouse left — collapse from now. */
  interrupt() {
    const t = (performance.now() - this.startMs) / 1000;
    if (!Number.isFinite(this.tc) || this.tc > t) this.tc = t;
    this.cancelTimers();
  }

  get elapsed(): number {
    return ((performance.now() - this.startMs) / 1000) * GREETING_SPEED;
  }

  get done(): boolean {
    return this.fired;
  }

  private fire() {
    if (this.fired) return;
    this.fired = true;
    this.cancelTimers();
    this.onComplete?.();
  }

  private cancelTimers() {
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers = [];
  }

  draw(x: CanvasRenderingContext2D) {
    const t = this.elapsed;
    if (!this.fired && t >= T.end && this.tc >= T.autoLeave) this.fire();

    const p = pose(t, this.tc);
    wipe(x);

    if (p.card > 0) {
      x.save();
      x.globalAlpha = p.card;
      rr(x, CARD.x, CARD.y, CARD.w, CARD.h, CARD_R);
      x.fillStyle = "#141518";
      x.fill();
      x.restore();

      x.save();
      rr(x, CARD.x, CARD.y, CARD.w, CARD.h, CARD_R);
      x.clip();
      drawParticles(x, t, p);
      x.restore();
    } else if (Number.isFinite(this.tc) && t >= this.tc) {
      drawParticles(x, t, p);
    }

    drawMinis(x, p.minis);
    drawBot(x, p);
  }
}
