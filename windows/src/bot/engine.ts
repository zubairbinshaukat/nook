// The Nook bot — "Nook Buddy", a port of design/prototype/nook-buddy.html to
// the island's engine: a soft gumdrop with a sprout on its head that glows in
// the colour of what the agent is doing. Same proportions, colours, gradients,
// eyes, mouths, brows and bubble as the prototype (the visual source of truth);
// the tweens, the state machine and the update/draw split are the island's own.
//
// The prototype runs its own frame loop for ever. Here nothing does: `update`
// is called by the island's loop, and `busy` tells that loop when it may stop.

import { Ease, clamp, lerp, type EaseFn } from "../core/anim";
import { Sound } from "../core/sound";
import type { BotEmoteName, BotStateName } from "../core/layout";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EyeShape =
  | "bead" | "wide" | "squint" | "happy" | "closed" | "flat" | "dot"
  | "heart" | "star" | "wink" | "spiral"
  // The reaction layer's (reactions.ts): eyes screwed shut, > <.
  | "squeeze"
  // From the previous drawing, still understood: "bar" is a bead, "x" a cross.
  | "bar" | "x";

export type MouthShape =
  | "smile" | "w" | "grin" | "o" | "O" | "yawn" | "flat" | "hmm" | "wobble" | "tiny"
  // The reaction layer's: a cheeky half-smile, and a laugh.
  | "smirk" | "laugh";

export type BrowShape = "raise" | "worry" | "angry";

/** What the little bubble beside the head says. */
export type BadgeShape = "dots" | "q" | "bang" | "check" | "x" | "hour";

export type BotTheme = "cream" | "peach" | "mint" | "lilac" | "sky" | "cocoa";

export type RGB = readonly [number, number, number]; // components 0…1

export type TweenKey = readonly [target: number, durationMs: number, ease: EaseFn];

interface Tween {
  prop: PropKey;
  keys: TweenKey[];
  index: number;
  from: number;
  startMs: number;
  onComplete?: () => void;
}

type PropKey =
  | "lx" | "ly" | "tilt" | "open" | "sx" | "sy"
  | "oy" | "ox" | "blush" | "es" | "glow" | "sway"
  | "wave" | "badgeS" | "droop"
  // The reaction layer's: see the fields of the same names.
  | "spin" | "tongue" | "poke"
  | "sproutPerk" | "sproutDroop" | "sproutSwing" | "sproutWiggle" | "sproutSpin";

interface BotStateCfg {
  color: RGB;
  eye: EyeShape;
  mouth: MouthShape;
  brow: BrowShape | null;
  /** How bright the sprout glows, 0 (off) to 1. */
  glow: number;
  /** The glow breathes in and out (at work). */
  pulses: boolean;
  /** The glow blinks (waiting for the user). */
  glowBlinks: boolean;
  bounces: boolean;
  /** A small, steady hop on the spot (at work). */
  bobs: boolean;
  /** The arms fidget (at work). */
  fidgets: boolean;
  scans: boolean;
  breathes: boolean;
  zz: boolean;
  sweat: boolean;
  look: readonly [number, number] | null;
  tilt: number;
  badge: BadgeShape | null;
}

interface Particle {
  type: "heart" | "star" | "spark" | "sweat" | "z" | "puff";
  x: number; y: number; vx: number; vy: number;
  age: number; life: number; rot: number; size: number;
}

/** One hair of the plush: where on the outline, how long, which way it bends. */
interface Hair { a: number; l: number; b: number }

// ── Constants (the prototype's SKINS / STATES / EMOTES) ───────────────────────

export const BOT_THEMES: Record<BotTheme, { label: string; a: string; b: string }> = {
  cream: { label: "Cream", a: "#FFF8EE", b: "#EBD3BC" },
  peach: { label: "Peach", a: "#FFEFE6", b: "#F2BBA2" },
  mint: { label: "Mint", a: "#F0FBF4", b: "#B8E2C8" },
  lilac: { label: "Lilac", a: "#F6F1FF", b: "#CBBDF0" },
  sky: { label: "Sky", a: "#F0F7FF", b: "#B6D0F0" },
  cocoa: { label: "Cocoa", a: "#F2E2D2", b: "#C09878" },
};

const C = {
  idle: hexToRGB("#8FD3A0"),
  working: hexToRGB("#5AA9FF"),
  thinking: hexToRGB("#A98BFA"),
  // Not in the prototype: working's twin, in the indigo the rest of the island
  // already uses for a search.
  searching: hexToRGB("#6366F1"),
  approval: hexToRGB("#FFB547"),
  question: hexToRGB("#38CFE0"),
  error: hexToRGB("#FF6B7A"),
  finished: hexToRGB("#4FD69C"),
  ratelimit: hexToRGB("#FF9B5C"),
  sleeping: hexToRGB("#A7B4C8"),
  // An emote in the prototype, a state here: its swatch there is its colour.
  dizzy: hexToRGB("#E879F9"),
};

const base = {
  brow: null, pulses: false, glowBlinks: false, bounces: false, bobs: false,
  fidgets: false, scans: false, breathes: false, zz: false, sweat: false,
  look: null, tilt: 0, badge: null,
};

const atWork = {
  ...base, eye: "bead", mouth: "smile", glow: 0.9,
  pulses: true, scans: true, bobs: true, fidgets: true, badge: "dots",
} as const;

export const BOT_STATES: Record<BotStateName, BotStateCfg> = {
  idle: { ...base, color: C.idle, eye: "bead", mouth: "smile", glow: 0.35 },
  working: { ...atWork, color: C.working },
  thinking: {
    ...base, color: C.thinking, eye: "bead", mouth: "hmm", glow: 0.8,
    pulses: true, look: [0.55, 0.55], badge: "dots",
  },
  searching: { ...atWork, color: C.searching },
  approval: {
    ...base, color: C.approval, eye: "wide", mouth: "o", glow: 1,
    glowBlinks: true, bounces: true, badge: "bang",
  },
  question: {
    ...base, color: C.question, eye: "bead", mouth: "o", brow: "raise", glow: 0.9,
    tilt: 0.16, badge: "q",
  },
  error: {
    ...base, color: C.error, eye: "bead", mouth: "wobble", brow: "worry", glow: 0.9, badge: "x",
  },
  finished: { ...base, color: C.finished, eye: "happy", mouth: "grin", glow: 0.9, badge: "check" },
  ratelimit: {
    ...base, color: C.ratelimit, eye: "squint", mouth: "flat", brow: "worry", glow: 0.6,
    sweat: true, badge: "hour",
  },
  sleeping: {
    ...base, color: C.sleeping, eye: "closed", mouth: "tiny", glow: 0.15,
    breathes: true, zz: true,
  },
  dizzy: { ...base, color: C.dizzy, eye: "spiral", mouth: "wobble", glow: 1 },
};

/** State → sound, as in BotStateCfg.sound. */
export const STATE_SOUND: Partial<Record<BotStateName, string>> = {
  working: "work", thinking: "think", searching: "search", approval: "approval",
  question: "question", error: "error", finished: "finish", ratelimit: "rate",
  sleeping: "sleep", dizzy: "dizzy",
};

/** The face of each emote. `happy` is the island's own: the wave's face, without the wave. */
export const EMOTES: Record<BotEmoteName, { eye: EyeShape; mouth: MouthShape; brow?: BrowShape }> = {
  hello: { eye: "happy", mouth: "grin" },
  love: { eye: "heart", mouth: "w" },
  giggle: { eye: "happy", mouth: "w" },
  surprised: { eye: "dot", mouth: "O" },
  proud: { eye: "star", mouth: "grin" },
  wink: { eye: "wink", mouth: "smile" },
  yawn: { eye: "squint", mouth: "yawn" },
  happy: { eye: "happy", mouth: "grin" },
  annoyed: { eye: "flat", mouth: "flat", brow: "angry" },
};

export const EMOTE_EYE = Object.fromEntries(
  Object.entries(EMOTES).map(([name, face]) => [name, face.eye]),
) as Record<BotEmoteName, EyeShape>;

/**
 * The mouth and brow that go with eyes put on by themselves — a slap's flat
 * eyes, a mini's permanent ones, the greeting's — when no emote says otherwise.
 */
const MOUTH_FOR_EYE: Partial<Record<EyeShape, MouthShape>> = {
  happy: "grin", heart: "w", star: "grin", flat: "flat", closed: "tiny",
  dot: "O", spiral: "wobble", wink: "smile", squint: "flat", x: "wobble",
};
const BROW_FOR_EYE: Partial<Record<EyeShape, BrowShape>> = { flat: "angry" };

/** The bot's `R` for a canvas `W` wide: the body is 2.36 R across, 1.84 R tall. */
export const BOT_R = 0.29;
/** The body, in R: its half-width, and its height above and below its widest line. */
const RW = 1.18;
const HT = 1.0;
const HB = 0.84;
export const BODY_W = RW * 2;
export const BODY_H = HT + HB;

const INK = "#2B1E1A";
const INK_LIGHT = "#53392F";
const WHITE: RGB = [1, 1, 1];
const BLACK: RGB = [0, 0, 0];
const STEM_GREEN: RGB = [70 / 255, 110 / 255, 80 / 255];
const HEART = "#FF5C8A";
const STAR = "#FFC53D";
const TONGUE = "#E9727F";

// ── Small helpers ─────────────────────────────────────────────────────────────

/**
 * The clock every bot reads, in milliseconds: `performance.now()`. A dev page
 * may put its own in its place — to draw frames slower than time passes, or
 * with none passing at all (a tab in the background, a benchmark). The app
 * never does.
 */
let clockMs: () => number = () => performance.now();
export function setBotClock(clock: (() => number) | null) {
  clockMs = clock ?? (() => performance.now());
}
/** The bots' time, in milliseconds. */
export const botNowMs = () => clockMs();

const now = () => clockMs() / 1000;

export function hexToRGB(hex: string): RGB {
  const h = hex.replace("#", "");
  const v = parseInt(h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const rgba = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

const mix3 = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t),
];

const THEME_RGB = Object.fromEntries(
  Object.entries(BOT_THEMES).map(([name, t]) => [name, { a: hexToRGB(t.a), b: hexToRGB(t.b) }]),
) as Record<BotTheme, { a: RGB; b: RGB }>;

/**
 * How much of the bot's surroundings a bot of this size gets, 0…1: its arms and
 * toes, the plush's hairs and rim, the shadow under it and its bubble. The
 * folded island's bot and the minis are a dozen pixels across: there the
 * drawing is simplified rather than shrunk — the body, a thicker sprout, bigger
 * eyes, as the prototype's own small bots. In between, the two are blended, so
 * the bot growing as the island unfolds doesn't jump from one drawing to the
 * other.
 */
export const detailFor = (R: number) => clamp((R - 12) / 6, 0, 1);

/**
 * How much of the face beyond its eyes, 0…1: the mouth, the brows, the cheeks,
 * the light in the eyes. The folded island's bot and a pill's mini keep them;
 * the grid's minis, six pixels of R, are two eyes and a sprout.
 */
const faceFor = (R: number) => clamp((R - 7) / 2, 0, 1);

/** How much light the eyes catch, 0…1: in an eye three pixels across, a highlight only greys it. */
const shineFor = (R: number) => clamp((R - 9) / 4, 0, 1);

function roundRectPath(
  x: CanvasRenderingContext2D | Path2D, X: number, Y: number, W: number, H: number, R: number,
) {
  const r = Math.max(0, Math.min(R, W / 2, H / 2));
  x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r);
  x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r);
  x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

function heartPath(x: CanvasRenderingContext2D, s: number) {
  x.beginPath();
  x.moveTo(0, s * 0.45);
  x.bezierCurveTo(-s * 1.1, -s * 0.1, -s * 0.55, -s * 0.95, 0, -s * 0.35);
  x.bezierCurveTo(s * 0.55, -s * 0.95, s * 1.1, -s * 0.1, 0, s * 0.45);
  x.closePath();
}

function starPath(x: CanvasRenderingContext2D, ro: number, ri: number) {
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    x.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  x.closePath();
}

/**
 * A point of the gumdrop's outline, for a body of size R standing on y = 0:
 * rounder on top, flatter underneath, a little wider at the hips.
 */
function bodyPoint(a: number, R: number): [number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const ex = s < 0 ? 2 / 2.25 : 2 / 3.2;
  const px = R * RW * Math.sign(c) * Math.pow(Math.abs(c), ex) * (1 + 0.05 * s);
  const py = s < 0 ? -R * HT * Math.pow(-s, 2 / 2.2) : R * HB * Math.pow(s, 2 / 3.6);
  return [px, py - R * HB];
}

function bodyPath(R: number): Path2D {
  const p = new Path2D();
  // A small body needs fewer corners to look round.
  const N = R < 12 ? 48 : 120;
  for (let i = 0; i <= N; i++) {
    const [px, py] = bodyPoint((i / N) * Math.PI * 2, R);
    if (i) p.lineTo(px, py);
    else p.moveTo(px, py);
  }
  p.closePath();
  return p;
}

const FONT = `system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif`;

// ── Engine ────────────────────────────────────────────────────────────────────

export class BotEngine {
  isMini = false;
  /** Which plush the body is made of, when nothing tints it. */
  /** The plush every bot made from now on wears: the one chosen in Settings. */
  static defaultTheme: BotTheme = "cream";
  theme: BotTheme = BotEngine.defaultTheme;
  /**
   * The colour of a mini bot's or a pill's body (null = the theme's own): the
   * plush is dyed in it, lighter where the light falls, as the themes are.
   */
  bodyColor: RGB | null = null;

  // Animated state (the prototype's `s`)
  lx = 0; ly = 0; tilt = 0; open = 1;
  sx = 1; sy = 1; oy = 0; ox = 0;
  blush = 0; es = 1; glow = 0.35; sway = 0;
  /** The right arm raised and waving, 0…1. */
  wave = 0;
  /** The bubble's size, 0 (gone) to 1. */
  badgeS = 0;
  /** The sprout hanging its head, 0…1 (asleep). */
  droop = 0;

  // ── The reaction layer's poses (reactions.ts) ───────────────────────────────
  // Every one is neutral here and nothing in the engine moves it: with nobody
  // setting them, the bot is drawn exactly as it was before they existed.

  /** The body leaning to one side from its feet, in radians (towards the cursor). */
  lean = 0;
  /** How far the face travels with a glance: 1 is the engine's own range. */
  lookRange = 1;
  /** The body turned round its own axis, in radians: the face slides off one side and comes back from the other. */
  spin = 0;
  /** The tongue out under the mouth, 0…1. Not drawn on a bot too small for it. */
  tongue = 0;
  /** A finger pressed into the body, 0…1 (under 0, the rebound), and from which side (`pokeAngle`, radians, 0 = its right). */
  poke = 0;
  pokeAngle = 0;
  /** The sprout standing up straight, taller, its leaves raised: 0…1, and a little over for a spring. */
  sproutPerk = 0;
  /** The sprout wilting, 0…1, on top of `droop` (which belongs to the sleeping state). */
  sproutDroop = 0;
  /** The sprout pushed to one side, −1…1, on top of its own sway. */
  sproutSwing = 0;
  /** The sprout shaking fast, 0…1: it only moves while frames are drawn. */
  sproutWiggle = 0;
  /** The leaves turned round the stem, in radians (a propeller when dizzy). */
  sproutSpin = 0;
  /** A mini that looks where `lookX`/`lookY` say instead of wandering. */
  miniFollows = false;
  /** The `R` of the last frame drawn — what `detailFor` was asked about. */
  drawnR = 0;

  // Targets
  tgLx = 0; tgLy = 0; tgTilt = 0; tgSy = 1; tgSx = 1; tgEs = 1;
  tgOy = 0; tgGlow = 0.35; tgSway = 0; tgDroop = 0;

  /** Extra canvas height above the body so hearts can fly out without clipping. */
  particleOverhang = 0;

  col: RGB = C.idle;
  colT: RGB = C.idle;

  state: BotStateName = "idle";
  cfg: BotStateCfg = BOT_STATES.idle;

  /** What the bubble shows; it changes once the bubble has shrunk away. */
  badge: BadgeShape | null = null;
  private badgeKey = "none";

  eyeOverride: EyeShape | null = null;
  eyeOverrideUntil = 0;
  /** An emote's mouth and brow, over the ones its eyes would have by themselves. */
  mouthOverride: MouthShape | null = null;
  browOverride: BrowShape | null = null;
  permanentEye: EyeShape | null = null;
  permanentEmote: BotEmoteName | null = null;
  miniNextBehavior = 0;

  private tweens = new Map<PropKey, Tween>();
  private locks = new Set<PropKey>();
  private particles: Particle[] = [];

  lookX = 0;
  lookY = 0;

  lastTime = now();
  private t0 = now() - Math.random() * 5;
  private nextBlink = now() + 1.5 + Math.random() * 2;
  private lastAmbient = 0;
  private slapTimes: number[] = [];
  private miniLookTarget = { x: 0, y: 0 };
  private miniLookNextTime = 0;

  /**
   * The time of what would move for ever in the prototype without belonging to
   * a looping state: the wobble of a worried mouth, the bubble's float. It runs
   * while the state loops, and for a moment after a state is entered; then it
   * stops, and they hold still.
   */
  private clock = Math.random() * 5;
  private liveUntil = 0;
  /**
   * The looping extras of a working state — the glow's pulse, the eyes' sweep,
   * the bob, the fidgeting arms, the bounce, the breath — play only in a beat:
   * a short while now and then, asked for by whoever drives the bot (`beat`).
   * Between beats the state rests: its colour, its bubble, a steady glow, and
   * nothing for the island to draw.
   */
  private beatUntil = 0;
  private beatFrom = 0;

  private path: Path2D | null = null;
  private pathR = 0;
  private hairs: Hair[] | null = null;

  /** Fired when three slaps land inside 1.7 s (→ dizzy + confused view). */
  onDizzy: (() => void) | null = null;

  // ── Public API ──────────────────────────────────────────────────────────────

  setState(next: BotStateName, force = false) {
    if (this.state === next && !force) return;
    const prev = this.state;
    this.state = next;
    this.cfg = BOT_STATES[next];
    this.colT = this.cfg.color;
    this.setBadge(this.cfg.badge);

    switch (next) {
      case "finished":
        this.hop();
        this.emit("spark", 6, 0.28);
        // The wave waits, like the sparks, for the hop to leave the ground.
        this.anim("wave", [[0, 280, Ease.lin], ...WAVE]);
        break;
      case "error":
        this.anim("ox", [
          [0.08, 50, Ease.out], [-0.08, 70, Ease.inOut], [0.06, 70, Ease.inOut],
          [-0.03, 70, Ease.inOut], [0, 90, Ease.out],
        ]);
        // Its mouth wobbles for a moment, then holds: an error comes to rest.
        this.liveUntil = now() + 1.6;
        break;
      case "approval":
        this.anim("oy", [[-0.2, 140, Ease.out], [0, 320, Ease.back]]);
        break;
      case "dizzy":
        break;
      case "ratelimit":
        this.emit("sweat", 1);
        break;
      case "sleeping":
        break;
      default:
        if (prev !== "idle" || next !== "idle") this.blink();
    }
    // The entrance of a state that moves: one beat of it.
    if (this.beatable) this.beat(1.2);
  }

  /** The state has looping extras, which play in beats (`beat`). */
  get beatable(): boolean {
    const c = this.cfg;
    return c.pulses || c.glowBlinks || c.bounces || c.bobs || c.fidgets || c.scans || c.breathes || c.zz || c.sweat;
  }

  /** The state's looping extras play for this many seconds, and then it rests again. */
  beat(seconds: number) {
    const n = now();
    if (n >= this.beatUntil) this.beatFrom = n;
    this.beatUntil = Math.max(this.beatUntil, n + seconds);
  }

  /** 0…1: the beat's strength — it comes in and goes out over a fifth of a second, so nothing snaps. */
  private beatEnv(): number {
    const n = now();
    return Math.max(0, Math.min(1, (n - this.beatFrom) / 0.2, (this.beatUntil - n) / 0.25));
  }

  /**
   * Takes a state as if it had always been in it: no entrance, no bubble
   * popping up, nothing to settle.
   */
  adopt(state: BotStateName) {
    const cfg = BOT_STATES[state];
    this.state = state;
    this.cfg = cfg;
    this.col = cfg.color;
    this.colT = cfg.color;
    this.glow = cfg.glow;
    this.tgGlow = cfg.glow;
    this.droop = state === "sleeping" ? 1 : 0;
    this.tilt = cfg.tilt;
    this.badge = cfg.badge;
    this.badgeKey = cfg.badge ?? "none";
    this.badgeS = cfg.badge ? 1 : 0;
  }

  /** The bubble shrinks away, takes its new sign, and pops back. */
  private setBadge(badge: BadgeShape | null) {
    const key = badge ?? "none";
    if (key === this.badgeKey) return;
    this.badgeKey = key;
    this.anim("badgeS", [[0, 110, Ease.inOut]], () => {
      this.badge = badge;
      if (badge) this.anim("badgeS", [[1, 340, Ease.back]]);
    });
  }

  blink() {
    if (this.locks.has("open")) return;
    this.anim("open", [[0.06, 70, Ease.inOut], [1, 140, Ease.out]]);
  }

  squash() {
    this.anim("sy", [[0.82, 70, Ease.out], [1.08, 140, Ease.out], [1, 190, Ease.inOut]]);
    this.anim("sx", [[1.14, 70, Ease.out], [0.96, 140, Ease.out], [1, 190, Ease.inOut]]);
  }

  /** The little jump of a job done: up, down, and a squash on landing. */
  hop() {
    this.anim("oy", [[-0.34, 220, Ease.out], [0, 250, Ease.inOut]], () => this.squash());
  }

  /** The right arm goes up, waves, and comes down. */
  waveHello() {
    this.anim("wave", [...WAVE]);
  }

  slap() {
    if (this.state === "dizzy") return;
    const t = now();
    this.slapTimes = this.slapTimes.filter((s) => t - s < 1.7);
    this.slapTimes.push(t);
    Sound.play("slap");
    this.squash();
    if (this.slapTimes.length >= 3) {
      this.slapTimes = [];
      this.onDizzy?.();
    } else {
      this.eyeOverride = "flat";
      this.mouthOverride = null;
      this.browOverride = null;
      this.eyeOverrideUntil = t + 0.8;
      this.anim("ox", [[0.04, 60, Ease.out], [-0.04, 80, Ease.inOut], [0, 90, Ease.out]]);
      setTimeout(() => Sound.play("annoyed"), 60);
    }
  }

  setPermanentEmote(emote: BotEmoteName | null) {
    this.permanentEmote = emote;
    if (emote === "wink") {
      this.miniNextBehavior = now() + 0.8 + Math.random() * 1.7;
      return;
    }
    this.permanentEye = emote ? EMOTE_EYE[emote] : null;
    if (this.permanentEye) {
      this.eyeOverride = this.permanentEye;
      this.eyeOverrideUntil = Number.POSITIVE_INFINITY;
    } else if (this.eyeOverrideUntil === Number.POSITIVE_INFINITY) {
      this.eyeOverride = null;
      this.eyeOverrideUntil = 0;
    }
    this.miniNextBehavior = now() + 0.8 + Math.random() * 1.7;
  }

  triggerEmote(emote: BotEmoteName, duration = 1.8) {
    const t = now();
    const face = EMOTES[emote];
    this.eyeOverride = face.eye;
    this.mouthOverride = face.mouth;
    this.browOverride = face.brow ?? null;
    this.eyeOverrideUntil = t + duration;

    switch (emote) {
      case "hello":
        this.eyeOverrideUntil = t + 1.5;
        this.waveHello();
        break;
      case "love":
        this.anim("blush", [
          [1, 300, Ease.out], [1, (duration - 0.6) * 1000, Ease.lin], [0, 300, Ease.inOut],
        ]);
        this.emit("heart", 5);
        this.anim("oy", [[-0.12, 160, Ease.out], [0, 320, Ease.back]]);
        break;
      case "giggle":
        this.squash();
        this.emit("spark", 3);
        this.anim("tilt", [
          [0.08, 90, Ease.out], [-0.08, 140, Ease.inOut], [0.05, 120, Ease.inOut], [0, 140, Ease.out],
        ]);
        break;
      case "surprised":
        this.anim("oy", [[-0.3, 140, Ease.out], [0, 380, Ease.back]]);
        this.anim("es", [[1.22, 120, Ease.out], [1, 520, Ease.inOut]]);
        break;
      case "proud":
        this.emit("star", 5);
        this.anim("tilt", [
          [-0.1, 220, Ease.out], [-0.1, (duration - 0.5) * 1000, Ease.lin], [0, 280, Ease.inOut],
        ]);
        break;
      case "wink":
        this.anim("tilt", [
          [0.1, 160, Ease.out], [0.1, (duration - 0.4) * 1000, Ease.lin], [0, 240, Ease.inOut],
        ]);
        break;
      case "yawn":
        this.anim("sy", [[1.12, 500, Ease.inOut], [1, 500, Ease.inOut]]);
        this.anim("sx", [[0.94, 500, Ease.inOut], [1, 500, Ease.inOut]]);
        setTimeout(() => {
          if (this.mouthOverride !== "yawn") return;
          this.eyeOverride = "closed";
          this.mouthOverride = "tiny";
          this.emit("z", 2);
        }, 700);
        break;
      case "happy":
        this.anim("blush", [[0.6, 200, Ease.out], [0, 600, Ease.inOut]]);
        break;
      case "annoyed":
        this.squash();
        this.anim("ox", [[0.04, 60, Ease.out], [-0.04, 80, Ease.inOut], [0, 90, Ease.out]]);
        this.eyeOverrideUntil = t + 0.8;
        setTimeout(() => Sound.play("annoyed"), 60);
        break;
    }
  }

  /**
   * Particles over the bot. `delay` holds the first one back — the sparks of a
   * finished job wait for the hop to leave the ground. A mini has none: at a
   * dozen pixels they are noise, and a "z" would be text too small to read.
   */
  emit(type: Particle["type"], count: number, delay = 0) {
    if (this.isMini) return;
    for (let i = 0; i < count; i++) {
      const p: Particle = {
        type,
        x: (Math.random() - 0.5) * 1.6,
        y: -0.1 - Math.random() * 0.2,
        vx: (Math.random() - 0.5) * 0.5,
        vy: -(0.6 + Math.random() * 0.5),
        age: -delay - i * 0.12,
        life: 1.3 + Math.random() * 0.5,
        rot: Math.random() * 6,
        size: 0.12 + Math.random() * 0.07,
      };
      if (type === "z") { p.x = 0.55; p.y = -0.1; p.vx = 0.35; p.vy = -0.55; p.size = 0.14; }
      if (type === "sweat") { p.x = 1.0; p.y = 0.35; p.vx = 0.08; p.vy = 0.45; p.life = 1; }
      // A puff of breath, from the mouth and off to either side.
      if (type === "puff") {
        const side = i % 2 ? -1 : 1;
        p.x = side * 0.22; p.y = 1.22; p.vx = side * (0.9 + Math.random() * 0.7);
        p.vy = -0.25 + Math.random() * 0.3; p.life = 0.6; p.size = 0.1;
      }
      this.particles.push(p);
    }
  }

  /** What is in the air is gone at once (the reaction layer's: a status that matters has arrived). */
  clearParticles() {
    this.particles = [];
  }

  /** The engine's own time — a worried mouth's wobble, the bubble's float — runs for this long, whatever the state. */
  keepLive(seconds: number) {
    this.liveUntil = Math.max(this.liveUntil, now() + seconds);
  }

  /** True for a state that moves for as long as it lasts: a pulse, a sweep, a breath. */
  private get looping(): boolean {
    return (
      this.state === "dizzy" || (this.beatable && now() < this.beatUntil)
    );
  }

  /**
   * True while anything is still moving — lets the island stop its RAF loop.
   * idle, question, finished and error come to rest (a steady glow, a still
   * sprout, eyes that don't move); the states that pulse, sweep, bounce or
   * breathe never do.
   */
  get busy(): boolean {
    return (
      this.tweens.size > 0 ||
      this.particles.length > 0 ||
      this.looping ||
      this.isMini ||
      now() < this.liveUntil ||
      // An emote's face has to be taken off again when its time is up.
      (this.eyeOverride != null && Number.isFinite(this.eyeOverrideUntil)) ||
      Math.abs(this.tgLx - this.lx) > 0.002 ||
      Math.abs(this.tgLy - this.ly) > 0.002 ||
      Math.abs(this.tgTilt - this.tilt) > 0.002 ||
      Math.abs(this.tgSy - this.sy) > 0.002 ||
      Math.abs(this.tgSx - this.sx) > 0.002 ||
      Math.abs(this.tgEs - this.es) > 0.002 ||
      Math.abs(this.tgOy - this.oy) > 0.002 ||
      Math.abs(this.tgGlow - this.glow) > 0.004 ||
      Math.abs(this.tgSway - this.sway) > 0.002 ||
      Math.abs(this.tgDroop - this.droop) > 0.004 ||
      Math.abs(this.col[0] - this.colT[0]) > 0.003 ||
      Math.abs(this.col[1] - this.colT[1]) > 0.003 ||
      Math.abs(this.col[2] - this.colT[2]) > 0.003
    );
  }

  // ── Tweens ──────────────────────────────────────────────────────────────────

  anim(prop: PropKey, keys: TweenKey[], onComplete?: () => void) {
    this.tweens.set(prop, {
      prop, keys, index: 0, from: this[prop], startMs: clockMs(), onComplete,
    });
    this.locks.add(prop);
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  update(dt: number) {
    const n = now();
    const nowMs = clockMs();

    for (const tw of [...this.tweens.values()]) {
      const k = tw.keys[tw.index];
      const p = Math.min(1, Math.max(0, (nowMs - tw.startMs) / k[1]));
      this[tw.prop] = tw.from + (k[0] - tw.from) * k[2](p);
      if (p >= 1) {
        tw.from = k[0];
        tw.index += 1;
        tw.startMs = nowMs;
        if (tw.index >= tw.keys.length) {
          this.tweens.delete(tw.prop);
          this.locks.delete(tw.prop);
          tw.onComplete?.();
        }
      }
    }

    const t = n - this.t0;
    const c = this.cfg;
    const dizzy = this.state === "dizzy";
    // What the prototype keeps moving in every state — the breath, the sprout's
    // sway — belongs here to the states that move anyway: at rest it would keep
    // the loop alive.
    const lively = this.looping || this.isMini;
    if (lively || n < this.liveUntil) this.clock += dt;

    let lx = this.lookX;
    let ly = this.lookY;

    // Mini bots never follow the mouse — they wander.
    if (this.isMini && !this.miniFollows) {
      if (n > this.miniLookNextTime) {
        this.miniLookTarget = {
          x: -0.88 + Math.random() * 1.76,
          y: -0.55 + Math.random() * 1.0,
        };
        this.miniLookNextTime = n + 0.5 + Math.random() * 1.5;
      }
      lx = this.miniLookTarget.x;
      ly = this.miniLookTarget.y;
    }

    const act = this.looping;
    if (c.scans && act) lx = lx * 0.3 + Math.sin(t * 1.6) * 0.6;
    if (c.look) {
      lx = lx * 0.3 + c.look[0];
      ly = ly * 0.3 + c.look[1];
    }
    if (this.state === "sleeping") { lx = 0; ly = -0.25; }
    if (dizzy) { lx = Math.sin(t * 7) * 0.5; ly = Math.cos(t * 7) * 0.25; }

    this.tgLx = clamp(lx, -1, 1);
    this.tgLy = clamp(ly, -1, 1);
    this.tgTilt = c.tilt + (dizzy ? Math.sin(t * 5) * 0.14 : 0);
    this.tgOy = !act ? 0 : c.bounces
      ? -Math.abs(Math.sin(t * 5)) * 0.09
      : c.bobs ? -Math.abs(Math.sin(t * 3.4)) * 0.03 : 0;

    if (this.isMini && !c.breathes) {
      this.tgSy = 1 + Math.sin(t * 2.2) * 0.04;
      this.tgSx = 1 - Math.sin(t * 2.2) * 0.02;
    } else if (lively) {
      const br = c.breathes ? 0.035 : 0.014;
      this.tgSy = 1 + Math.sin(t * 1.7) * br;
      this.tgSx = 1 - Math.sin(t * 1.7) * br * 0.6;
    } else {
      this.tgSy = 1;
      this.tgSx = 1;
    }

    // At rest the glow is steady, at about the middle of what it pulses through.
    let g = c.glow;
    if (c.pulses) g *= act ? 0.6 + 0.4 * Math.sin(t * 4) : 0.8;
    if (c.glowBlinks) g *= act ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 6.5)) : 0.85;
    this.tgGlow = g;

    // The sprout leans against a tilt, a shake and a glance.
    const idleSway = lively ? Math.sin(t * 1.3) * 0.14 : 0;
    this.tgSway = -this.tilt * 1.4 - this.ox * 1.6 + idleSway - this.lx * 0.15 - this.lean * 1.2;
    this.tgDroop = this.state === "sleeping" ? 1 : 0;

    if (this.isMini && n > this.miniNextBehavior) this.doMiniBehaviorLoop();

    const kLook = 1 - Math.pow(0.002, dt);
    const kGen = 1 - Math.pow(0.0008, dt);
    const kGlow = 1 - Math.pow(1e-5, dt);
    if (!this.locks.has("lx")) this.lx += (this.tgLx - this.lx) * kLook;
    if (!this.locks.has("ly")) this.ly += (this.tgLy - this.ly) * kLook;
    if (!this.locks.has("tilt")) this.tilt += (this.tgTilt - this.tilt) * kGen;
    if (!this.locks.has("oy")) this.oy += (this.tgOy - this.oy) * kGen;
    if (!this.locks.has("sy")) this.sy += (this.tgSy - this.sy) * kGen;
    if (!this.locks.has("sx")) this.sx += (this.tgSx - this.sx) * kGen;
    if (!this.locks.has("es")) this.es += (this.tgEs - this.es) * kGen;
    if (!this.locks.has("sway")) this.sway += (this.tgSway - this.sway) * kGen;
    if (!this.locks.has("droop")) this.droop += (this.tgDroop - this.droop) * kGen;
    if (!this.locks.has("glow")) this.glow += (this.tgGlow - this.glow) * kGlow;

    this.col = mix3(this.col, this.colT, 1 - Math.pow(0.002, dt));

    if (n > this.nextBlink) {
      if (this.state !== "sleeping" && !dizzy) {
        this.blink();
        if (Math.random() < 0.22) setTimeout(() => this.blink(), 230);
      }
      this.nextBlink = n + 2.2 + Math.random() * 3.2;
    }

    if (this.eyeOverride && n > this.eyeOverrideUntil) {
      this.eyeOverride = this.permanentEye;
      this.mouthOverride = null;
      this.browOverride = null;
      if (this.permanentEye) this.eyeOverrideUntil = Number.POSITIVE_INFINITY;
    }

    if (n - this.lastAmbient > 1.3) {
      this.lastAmbient = n;
      if (c.zz && act) this.emit("z", 1);
      if (c.sweat && act && Math.random() < 0.5) this.emit("sweat", 1);
    }

    for (const p of this.particles) p.age += dt;
    this.particles = this.particles.filter((p) => p.age < p.life);

    this.lastTime = n;
  }

  private doMiniBehaviorLoop() {
    const n = now();
    switch (this.permanentEmote) {
      case "happy":
        if (this.locks.has("oy")) { this.miniNextBehavior = n + 0.4; return; }
        this.anim("oy", [[-0.3, 120, Ease.out], [0.03, 200, Ease.inOut], [0, 160, Ease.back]]);
        this.anim("sy", [[0.82, 80, Ease.out], [1.18, 130, Ease.out], [0.88, 160, Ease.inOut], [1, 200, Ease.back]]);
        this.anim("sx", [[1.15, 80, Ease.out], [0.88, 130, Ease.out], [1.06, 160, Ease.inOut], [1, 200, Ease.back]]);
        this.miniNextBehavior = n + 2.2 + Math.random() * 1.2;
        break;
      case "annoyed":
        if (this.locks.has("lx")) { this.miniNextBehavior = n + 0.5; return; }
        this.anim("lx", [
          [-0.65, 50, Ease.out], [0.65, 90, Ease.inOut], [-0.5, 80, Ease.inOut],
          [0.4, 75, Ease.inOut], [-0.2, 70, Ease.inOut], [0, 140, Ease.out],
        ]);
        this.miniNextBehavior = n + 3.0 + Math.random() * 2.5;
        break;
      case "wink":
        this.eyeOverride = "wink";
        this.eyeOverrideUntil = n + 0.55;
        this.anim("tilt", [[0.13, 100, Ease.out], [0.13, 320, Ease.lin], [0, 200, Ease.inOut]]);
        this.miniNextBehavior = n + 2.2 + Math.random() * 2.0;
        break;
      case "love":
        this.anim("tilt", [[-0.1, 180, Ease.out], [0.1, 340, Ease.inOut], [0, 220, Ease.inOut]]);
        this.miniNextBehavior = n + 2.6 + Math.random() * 1.5;
        break;
      default:
        this.miniNextBehavior = n + 3.0 + Math.random() * 2.0;
    }
  }

  // ── Draw ────────────────────────────────────────────────────────────────────

  /**
   * Draws the sprout, the body, its face and arms, the bubble and the particles
   * into a canvas of `W`×`H` CSS pixels (the caller has already applied the DPR
   * transform). The body is 0.68 W across; from the tip of its sprout to its
   * toes the bot is centred on the canvas (less the overhang, which is all
   * above it).
   */
  draw(x: CanvasRenderingContext2D, W: number, H: number) {
    const R = W * BOT_R;
    if (R <= 0.2) return;
    this.drawnR = R;
    const k = detailFor(R);
    const f = faceFor(R);
    const t = now() - this.t0;
    const cx = W / 2 + this.ox * R;
    // The ground the bot stands on: the whole figure, sprout included, is some
    // 2.3 R tall (taller when small, where the sprout is drawn bigger).
    const ground = H / 2 + this.particleOverhang / 2 + R * lerp(1.2, 1.13, k);
    const gy = ground + this.oy * R;
    // A shadow's blur is counted in pixels of the bitmap, whatever the transform.
    const m = x.getTransform();
    const px = Math.hypot(m.a, m.b);

    const skin = this.bodyColor
      ? { a: mix3(this.bodyColor, WHITE, 0.45), b: this.bodyColor }
      : THEME_RGB[this.theme];

    if (k > 0) {
      // Its shadow on the ground, smaller as it leaves it.
      const lift = clamp(1 + this.oy * 1.4, 0.4, 1.2);
      x.fillStyle = `rgba(0,0,0,${0.3 * lift * k})`;
      x.beginPath();
      x.ellipse(cx, ground + R * 0.13, R * RW * 0.82 * lift, R * 0.1 * lift, 0, 0, Math.PI * 2);
      x.fill();
    }

    x.save();
    x.translate(cx, gy);
    // Leaning, it pivots on its feet; tilting, on its middle.
    if (this.lean !== 0) x.rotate(this.lean);
    x.translate(0, -R * 0.9);
    if (this.tilt !== 0) x.rotate(this.tilt);
    x.translate(0, R * 0.9);
    x.scale(this.sx, this.sy);
    if (this.poke !== 0) {
      // Pressed in from one side: shorter along the finger, fatter across it,
      // and pushed a little away from it.
      const p = this.poke;
      const ca = Math.cos(this.pokeAngle);
      const sa = Math.sin(this.pokeAngle);
      x.translate(-ca * R * 0.12 * p, -R * 0.9 - sa * R * 0.12 * p);
      x.rotate(this.pokeAngle);
      x.scale(1 - 0.24 * p, 1 + 0.13 * p);
      x.rotate(-this.pokeAngle);
      x.translate(0, R * 0.9);
    }
    // Turned round: a gumdrop is as round from the side, so it is the face that
    // tells — it slides off one edge, is gone, and comes back from the other.
    const turned = this.spin !== 0;
    const spinC = turned ? Math.cos(this.spin) : 1;
    if (turned) x.scale(1 - 0.08 * Math.abs(Math.sin(this.spin)), 1);

    this.drawSprout(x, R, k, px, t);
    if (k > 0) this.drawToes(x, R, k, skin.b);
    this.drawBody(x, R, k, skin);
    if (!turned) this.drawFace(x, R, k, f, t);
    else if (spinC > 0.05 && this.path) {
      x.save();
      x.clip(this.path);
      x.translate(Math.sin(this.spin) * R * 1.05, 0);
      x.scale(spinC, 1);
      this.drawFace(x, R, k, f, t);
      x.restore();
    }
    if (k > 0) this.drawArms(x, R, k, t, skin, spinC);

    x.restore();

    const headTop = gy - R * BODY_H * this.sy;
    if (this.badge && this.badgeS * k > 0.01) {
      this.drawBubble(
        x, cx + R * RW * 1.02, headTop + R * 0.04 + Math.sin(this.clock * 2) * R * 0.03,
        R, this.badgeS * k, t, px,
      );
    }
    this.drawParticles(x, R, cx, headTop);
  }

  /** The stem behind the head and its two leaves, which glow with the state. */
  private drawSprout(x: CanvasRenderingContext2D, R: number, k: number, px: number, t: number) {
    const base = -R * BODY_H + R * 0.12;
    const perk = this.sproutPerk;
    const L = R * lerp(0.5, 0.44, k) * (1 + 0.5 * perk);
    const droop = this.sproutDroop !== 0 ? clamp(this.droop + this.sproutDroop, 0, 1) : this.droop;
    // Standing up straight, it sways less; pushed or shaken, more.
    const sway =
      this.sway * (1 - 0.75 * clamp(perk, 0, 1)) + this.sproutSwing +
      (this.sproutWiggle !== 0 ? Math.sin(t * 17) * this.sproutWiggle * 0.85 : 0);
    const tipX = sway * R * 0.32 + droop * R * 0.3;
    const tipY = base - L * (1 - droop * 0.45);
    const ctrlX = tipX * 0.1;
    const ctrlY = base - L * 0.6;

    x.strokeStyle = rgba(mix3(mix3(this.col, STEM_GREEN, 0.35), BLACK, 0.12));
    x.lineWidth = R * lerp(0.12, 0.07, k);
    x.lineCap = "round";
    x.beginPath();
    x.moveTo(0, base);
    x.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
    x.stroke();

    const ang = Math.atan2(tipY - ctrlY, tipX - ctrlX);
    const ll = R * lerp(0.42, 0.32, k) * (1 + 0.18 * perk);
    const gl = clamp(this.glow, 0, 1);
    // Perked up, the leaves rise towards the stem's line, like ears.
    const spread = 0.78 + droop * 0.25 - 0.26 * perk;
    for (const sd of [-1, 1]) {
      x.save();
      x.translate(tipX, tipY);
      if (this.sproutSpin === 0) x.rotate(ang + sd * spread);
      else {
        // Turning round the stem: seen from the front, the leaves close up,
        // cross, and open again on the other side.
        x.rotate(ang);
        x.scale(1, Math.cos(this.sproutSpin));
        x.rotate(sd * spread);
      }
      if (gl > 0.05) {
        x.shadowColor = rgba(this.col, 0.9 * gl);
        x.shadowBlur = R * lerp(0.25, 0.45, k) * gl * px;
      }
      const lg = x.createLinearGradient(0, 0, ll, 0);
      lg.addColorStop(0, rgba(mix3(this.col, BLACK, 0.08)));
      lg.addColorStop(1, rgba(mix3(this.col, WHITE, 0.35 + 0.2 * gl)));
      x.fillStyle = lg;
      x.beginPath();
      x.moveTo(0, 0);
      x.quadraticCurveTo(ll * 0.5, -ll * 0.5, ll, 0);
      x.quadraticCurveTo(ll * 0.5, ll * 0.5, 0, 0);
      x.fill();
      x.shadowColor = "transparent";
      if (k > 0) {
        x.strokeStyle = `rgba(255,255,255,${0.35 * k})`;
        x.lineWidth = R * 0.018;
        x.beginPath();
        x.moveTo(ll * 0.12, 0);
        x.lineTo(ll * 0.8, 0);
        x.stroke();
      }
      x.restore();
    }
  }

  private drawToes(x: CanvasRenderingContext2D, R: number, k: number, dark: RGB) {
    x.save();
    x.globalAlpha = k;
    const g = x.createLinearGradient(0, -R * 0.15, 0, R * 0.14);
    g.addColorStop(0, rgba(mix3(dark, BLACK, 0.04)));
    g.addColorStop(1, rgba(mix3(dark, BLACK, 0.14)));
    x.fillStyle = g;
    for (const sd of [-1, 1]) {
      x.beginPath();
      x.ellipse(sd * R * 0.48, -R * 0.01, R * 0.27, R * 0.14, 0, 0, Math.PI * 2);
      x.fill();
    }
    x.restore();
  }

  /** The gumdrop: its hairs, its plush, the shade under it and the light on it. */
  private drawBody(x: CanvasRenderingContext2D, R: number, k: number, skin: { a: RGB; b: RGB }) {
    if (!this.path || this.pathR !== R) {
      this.path = bodyPath(R);
      this.pathR = R;
    }
    const path = this.path;
    const rw = R * RW;
    const ht = R * HT;
    const hb = R * HB;

    if (k > 0) {
      this.hairs ??= makeHairs();
      x.strokeStyle = rgba(mix3(skin.a, skin.b, 0.6), k);
      x.lineWidth = R * 0.035;
      x.lineCap = "round";
      x.beginPath();
      for (const hair of this.hairs) {
        const [hx, hy] = bodyPoint(hair.a, R);
        let nx = hx;
        let ny = hy + hb * 0.95;
        const len = Math.hypot(nx, ny) || 1;
        nx /= len;
        ny /= len;
        const L = R * 0.075 * hair.l;
        x.moveTo(hx - nx * R * 0.03, hy - ny * R * 0.03);
        x.quadraticCurveTo(
          hx + nx * L * 0.5 - ny * L * 0.4 * hair.b, hy + ny * L * 0.5 + nx * L * 0.4 * hair.b,
          hx + nx * L, hy + ny * L,
        );
      }
      x.stroke();
    }

    const bg = x.createRadialGradient(-rw * 0.35, -hb - ht * 0.55, R * 0.1, -rw * 0.1, -hb * 0.8, R * 1.7);
    bg.addColorStop(0, rgba(mix3(skin.a, WHITE, 0.5)));
    bg.addColorStop(0.5, rgba(mix3(skin.a, skin.b, 0.3)));
    bg.addColorStop(1, rgba(skin.b));
    x.fillStyle = bg;
    x.fill(path);

    x.save();
    x.clip(path);
    const sh = x.createLinearGradient(0, -hb * 0.7, 0, 0);
    sh.addColorStop(0, "rgba(120,70,40,0)");
    sh.addColorStop(1, "rgba(120,70,40,0.16)");
    x.fillStyle = sh;
    x.fill(path);

    // The state's colour, coming up from under it with the glow.
    const tn = x.createRadialGradient(0, R * 0.1, R * 0.2, 0, R * 0.1, R * 1.3);
    tn.addColorStop(0, rgba(this.col, 0.22 * clamp(this.glow, 0, 1)));
    tn.addColorStop(1, rgba(this.col, 0));
    x.fillStyle = tn;
    x.fill(path);

    if (k > 0) {
      const rim = x.createLinearGradient(-rw, -hb - ht, rw * 0.4, 0);
      rim.addColorStop(0, `rgba(255,255,255,${0.75 * k})`);
      rim.addColorStop(1, "rgba(255,255,255,0)");
      x.strokeStyle = rim;
      x.lineWidth = R * 0.07;
      x.stroke(path);
    }

    x.save();
    x.translate(-rw * 0.4, -hb - ht * 0.55);
    x.rotate(-0.55);
    const hl = x.createRadialGradient(0, 0, 0, 0, 0, R * 0.36);
    hl.addColorStop(0, "rgba(255,255,255,0.6)");
    hl.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = hl;
    x.scale(1, 0.6);
    x.beginPath();
    x.arc(0, 0, R * 0.36, 0, Math.PI * 2);
    x.fill();
    x.restore();
    x.restore();
  }

  /** The cheeks, the eyes with their brows, and the mouth. */
  private drawFace(x: CanvasRenderingContext2D, R: number, k: number, f: number, t: number) {
    const fx = this.lx * R * 0.2 * this.lookRange;
    const fy = -this.ly * R * 0.12 * this.lookRange;
    const eyeY = -R * 0.86 + fy;
    // Small, the eyes are drawn bigger, and bigger still once they are all the face has.
    const ek = lerp(1.3, 1, k) + 0.25 * (1 - f);
    const narrow = 1 - 0.1 * Math.abs(this.lx);

    const eye: EyeShape = this.eyeOverride ?? this.cfg.eye;
    // Eyes put on over the state's own bring their mouth and brow with them.
    const worn = this.eyeOverride != null && this.eyeOverride !== this.cfg.eye;
    const mouth: MouthShape =
      this.mouthOverride ?? (worn ? MOUTH_FOR_EYE[eye] ?? this.cfg.mouth : this.cfg.mouth);
    const brow: BrowShape | null =
      this.browOverride ?? (worn ? BROW_FOR_EYE[eye] ?? null : this.cfg.brow);

    if (f > 0) {
      const ca = (0.32 + 0.5 * this.blush) * f;
      for (const sd of [-1, 1]) {
        const kx = sd * R * 0.66 * narrow + fx * 0.9;
        const ky = eyeY + R * 0.2;
        const g = x.createRadialGradient(kx, ky, 0, kx, ky, R * 0.18);
        g.addColorStop(0, `rgba(255,128,150,${ca})`);
        g.addColorStop(1, "rgba(255,128,150,0)");
        x.fillStyle = g;
        x.beginPath();
        x.ellipse(kx, ky, R * 0.19, R * 0.12, 0, 0, Math.PI * 2);
        x.fill();
      }
    }

    const w = R * 0.115 * this.es * ek;
    const h = R * 0.15 * this.es * ek;
    for (const sd of [-1, 1]) {
      // The eye on the far side of a glance is seen a little from the side.
      const shrink = 1 - 0.22 * Math.max(0, -sd * this.lx);
      x.save();
      x.translate(sd * R * 0.42 * narrow + fx, eyeY);
      x.scale(shrink, 1);
      this.drawEye(x, eye, w, h, sd, shineFor(R), t);
      if (brow && f > 0) this.drawBrow(x, brow, sd, w, h, f);
      x.restore();
    }

    if (f > 0) {
      x.save();
      x.globalAlpha = f;
      x.translate(fx, eyeY + R * 0.21);
      // Small, the mouth is drawn bigger and with a thicker line, to stay a mouth.
      this.drawMouth(x, mouth, R * lerp(1.3, 1, k), lerp(1.5, 1, k));
      // The tongue, out and a little to one side. On a bot a dozen pixels
      // across it would be a pink smudge under the mouth: there it is not drawn.
      if (this.tongue > 0.01 && k > 0.35) {
        const tw = R * 0.085;
        const tl = R * 0.25 * Math.min(this.tongue, 1.15);
        x.fillStyle = TONGUE;
        x.strokeStyle = "rgba(120,40,50,0.55)";
        x.lineWidth = R * 0.022;
        x.beginPath();
        x.moveTo(R * 0.025 - tw, R * 0.02);
        x.lineTo(R * 0.025 - tw, tl - tw);
        x.arc(R * 0.025, tl - tw, tw, Math.PI, 0, true);
        x.lineTo(R * 0.025 + tw, R * 0.02);
        x.closePath();
        x.fill();
        x.stroke();
        x.beginPath();
        x.moveTo(R * 0.025, R * 0.05);
        x.lineTo(R * 0.025, tl - tw * 0.9);
        x.stroke();
      }
      x.restore();
    }
  }

  private drawEye(
    x: CanvasRenderingContext2D, shape: EyeShape, w: number, h: number, sd: number,
    shine: number, t: number,
  ) {
    // Small, an eye drawn as a line gets a thicker one: half a pixel of ink is a grey smudge.
    const thick = lerp(1.7, 1, shine);
    const bead = (bw: number, bh: number, open = this.open) => {
      const hh = Math.max(bh * open, bh * 0.1);
      const g = x.createRadialGradient(0, hh * 0.5, 0, 0, 0, Math.max(bw, hh) * 1.2);
      g.addColorStop(0, INK_LIGHT);
      g.addColorStop(1, INK);
      x.fillStyle = g;
      x.beginPath();
      x.ellipse(0, 0, bw, hh, 0, 0, Math.PI * 2);
      x.fill();
      if (open > 0.45 && shine > 0) {
        x.fillStyle = `rgba(255,255,255,${0.95 * shine})`;
        x.beginPath();
        x.arc(-bw * 0.3, -hh * 0.36, bw * 0.33, 0, Math.PI * 2);
        x.fill();
        x.beginPath();
        x.arc(bw * 0.32, hh * 0.36, bw * 0.14, 0, Math.PI * 2);
        x.fill();
      }
    };
    const arcUp = () => {
      x.strokeStyle = INK;
      x.lineWidth = w * 0.5 * thick;
      x.lineCap = "round";
      x.beginPath();
      x.arc(0, h * 0.5, w * 1.1, Math.PI * 1.2, Math.PI * 1.8);
      x.stroke();
    };

    switch (shape) {
      case "bead":
      case "bar":
        bead(w, h);
        break;
      case "wide":
        bead(w * 1.15, h * 1.12);
        break;
      case "dot":
        bead(w * 0.6, w * 0.65, 1);
        break;
      case "happy":
        arcUp();
        break;
      case "closed":
        x.strokeStyle = INK;
        x.lineWidth = w * 0.42 * thick;
        x.lineCap = "round";
        x.beginPath();
        x.arc(0, -h * 0.4, w * 1.05, Math.PI * 0.2, Math.PI * 0.8);
        x.stroke();
        break;
      case "squint":
        x.save();
        x.translate(0, h * 0.15);
        bead(w, h * 0.55);
        x.restore();
        x.strokeStyle = INK;
        x.lineWidth = w * 0.28 * thick;
        x.lineCap = "round";
        x.beginPath();
        x.moveTo(-w * 1.05, -h * 0.22);
        x.lineTo(w * 1.05, -h * 0.22);
        x.stroke();
        break;
      case "flat":
        x.fillStyle = INK;
        x.beginPath();
        roundRectPath(x, -w, -w * 0.3, w * 2, w * 0.6, w * 0.3);
        x.fill();
        break;
      case "x": {
        const d = w * 0.75;
        x.strokeStyle = INK;
        x.lineWidth = w * 0.45;
        x.lineCap = "round";
        x.beginPath();
        x.moveTo(-d, -d);
        x.lineTo(d, d);
        x.moveTo(d, -d);
        x.lineTo(-d, d);
        x.stroke();
        break;
      }
      case "heart":
        x.fillStyle = HEART;
        heartPath(x, w * 1.4);
        x.fill();
        if (shine > 0) {
          x.fillStyle = `rgba(255,255,255,${0.85 * shine})`;
          x.beginPath();
          x.arc(-w * 0.45, -w * 0.35, w * 0.2, 0, Math.PI * 2);
          x.fill();
        }
        break;
      case "star":
        x.fillStyle = STAR;
        x.rotate(t * 1.4 * sd);
        starPath(x, w * 1.2, w * 0.52);
        x.fill();
        break;
      case "wink":
        if (sd < 0) bead(w, h);
        else arcUp();
        break;
      case "squeeze":
        // > < : each eye a chevron pointing at the nose.
        x.strokeStyle = INK;
        x.lineWidth = w * 0.5 * thick;
        x.lineCap = "round";
        x.lineJoin = "round";
        x.beginPath();
        x.moveTo(sd * w * 1.05, -h * 0.62);
        x.lineTo(-sd * w * 0.75, 0);
        x.lineTo(sd * w * 1.05, h * 0.62);
        x.stroke();
        break;
      case "spiral": {
        x.strokeStyle = INK;
        x.lineWidth = w * 0.22 * thick;
        x.lineCap = "round";
        x.beginPath();
        for (let a = 0; a < 4.4 * Math.PI; a += 0.2) {
          const r = w * 0.05 + a * w * 0.065;
          const aa = a + t * 9 * sd;
          const sx = Math.cos(aa) * r;
          const sy = Math.sin(aa) * r;
          if (a === 0) x.moveTo(sx, sy);
          else x.lineTo(sx, sy);
        }
        x.stroke();
        break;
      }
    }
  }

  private drawBrow(
    x: CanvasRenderingContext2D, type: BrowShape, sd: number, w: number, h: number, f: number,
  ) {
    let r = 0;
    let dy = 0;
    if (type === "worry") r = sd * 0.32;
    if (type === "angry") { r = -sd * 0.38; dy = h * 0.25; }
    if (type === "raise") {
      if (sd > 0) { dy = -h * 0.35; r = -0.12; }
      else r = -sd * 0.05;
    }
    x.save();
    x.globalAlpha = f;
    x.translate(0, -h * 1.55 + dy);
    x.rotate(r);
    x.strokeStyle = INK;
    x.lineWidth = w * 0.34;
    x.lineCap = "round";
    x.beginPath();
    x.moveTo(-w * 0.85, 0);
    x.lineTo(w * 0.85, 0);
    x.stroke();
    x.restore();
  }

  private drawMouth(x: CanvasRenderingContext2D, mouth: MouthShape, R: number, thick: number) {
    x.strokeStyle = INK;
    x.fillStyle = INK;
    x.lineWidth = R * 0.042 * thick;
    x.lineCap = "round";
    x.lineJoin = "round";
    /** The tongue, inside the mouth just filled. */
    const tongue = (cy: number, rx: number, ry: number) => {
      x.save();
      x.clip();
      x.fillStyle = TONGUE;
      x.beginPath();
      x.ellipse(0, cy, rx, ry, 0, 0, Math.PI * 2);
      x.fill();
      x.restore();
    };

    switch (mouth) {
      case "smile":
        x.beginPath();
        x.arc(0, -R * 0.05, R * 0.085, Math.PI * 0.22, Math.PI * 0.78);
        x.stroke();
        break;
      case "w":
        for (const sd of [-1, 1]) {
          x.beginPath();
          x.arc(sd * R * 0.055, -R * 0.01, R * 0.055, 0, Math.PI);
          x.stroke();
        }
        break;
      case "grin":
        x.beginPath();
        x.moveTo(-R * 0.1, -R * 0.025);
        x.lineTo(R * 0.1, -R * 0.025);
        x.quadraticCurveTo(0, R * 0.17, -R * 0.1, -R * 0.025);
        x.closePath();
        x.fill();
        tongue(R * 0.085, R * 0.06, R * 0.04);
        break;
      case "o":
        x.beginPath();
        x.ellipse(0, 0, R * 0.045, R * 0.055, 0, 0, Math.PI * 2);
        x.fill();
        break;
      case "O":
        x.beginPath();
        x.ellipse(0, R * 0.01, R * 0.065, R * 0.085, 0, 0, Math.PI * 2);
        x.fill();
        tongue(R * 0.08, R * 0.05, R * 0.035);
        break;
      case "yawn":
        x.beginPath();
        x.ellipse(0, R * 0.02, R * 0.08, R * 0.11, 0, 0, Math.PI * 2);
        x.fill();
        tongue(R * 0.11, R * 0.06, R * 0.04);
        break;
      case "flat":
        x.beginPath();
        x.moveTo(-R * 0.07, 0);
        x.lineTo(R * 0.07, 0);
        x.stroke();
        break;
      case "hmm":
        x.beginPath();
        x.moveTo(-R * 0.06, R * 0.012);
        x.lineTo(R * 0.06, -R * 0.018);
        x.stroke();
        break;
      case "wobble":
        x.lineWidth = R * 0.036 * thick;
        x.beginPath();
        for (let i = 0; i <= 16; i++) {
          const u = i / 16;
          const wx = lerp(-R * 0.1, R * 0.1, u);
          const wy = Math.sin(u * Math.PI * 3 + this.clock * 6) * R * 0.018;
          if (i) x.lineTo(wx, wy);
          else x.moveTo(wx, wy);
        }
        x.stroke();
        break;
      case "tiny":
        x.beginPath();
        x.arc(0, -R * 0.03, R * 0.045, Math.PI * 0.25, Math.PI * 0.75);
        x.stroke();
        break;
      case "smirk":
        // A smile that only one corner of the mouth is making.
        x.beginPath();
        x.moveTo(-R * 0.085, R * 0.0);
        x.quadraticCurveTo(R * 0.03, R * 0.085, R * 0.12, -R * 0.06);
        x.stroke();
        break;
      case "laugh":
        x.beginPath();
        x.moveTo(-R * 0.14, -R * 0.04);
        x.lineTo(R * 0.14, -R * 0.04);
        x.quadraticCurveTo(R * 0.12, R * 0.2, 0, R * 0.2);
        x.quadraticCurveTo(-R * 0.12, R * 0.2, -R * 0.14, -R * 0.04);
        x.closePath();
        x.fill();
        tongue(R * 0.17, R * 0.09, R * 0.06);
        break;
    }
  }

  /** The two little arms; at work they fidget, and the right one can wave. */
  private drawArms(
    x: CanvasRenderingContext2D, R: number, k: number, t: number, skin: { a: RGB; b: RGB },
    /** The cosine of a spin: the arms go round with the body. 1 when it faces us. */
    spinC = 1,
  ) {
    x.save();
    x.globalAlpha = k;
    for (const sd of [-1, 1]) {
      let ang = -sd * 0.42;
      if (this.cfg.fidgets && this.looping) ang += -sd * Math.sin(t * 7 + sd * 1.3) * 0.12 * this.beatEnv();
      if (sd === 1 && this.wave > 0.01) ang = lerp(ang, -2.5 + Math.sin(t * 13) * 0.35, this.wave);
      if (spinC < 0) ang = -ang;
      x.save();
      x.translate(sd * R * RW * 0.93 * spinC, -R * HB * 0.95);
      x.rotate(ang);
      const g = x.createLinearGradient(-R * 0.16, 0, R * 0.16, R * 0.45);
      g.addColorStop(0, rgba(mix3(skin.a, skin.b, 0.2)));
      g.addColorStop(1, rgba(skin.b));
      x.fillStyle = g;
      x.beginPath();
      x.ellipse(0, R * 0.2, R * 0.16, R * 0.24, 0, 0, Math.PI * 2);
      x.fill();
      x.strokeStyle = "rgba(120,70,40,0.12)";
      x.lineWidth = R * 0.02;
      x.stroke();
      x.restore();
    }
    x.restore();
  }

  /** The thought bubble beside the head, and the sign of the state in it. */
  private drawBubble(
    x: CanvasRenderingContext2D, bx: number, by: number, R: number, scale: number,
    t: number, px: number,
  ) {
    x.save();
    x.translate(bx, by);
    x.scale(scale, scale);
    x.fillStyle = "rgba(255,255,255,0.96)";
    x.beginPath();
    x.arc(-R * 0.38, R * 0.3, R * 0.065, 0, Math.PI * 2);
    x.fill();
    x.beginPath();
    x.arc(-R * 0.52, R * 0.47, R * 0.04, 0, Math.PI * 2);
    x.fill();

    const w = R * 0.68;
    const h = R * 0.44;
    x.save();
    x.shadowColor = "rgba(0,0,0,0.3)";
    x.shadowBlur = R * 0.25 * scale * px;
    x.shadowOffsetY = R * 0.05 * scale * px;
    x.beginPath();
    roundRectPath(x, -w / 2, -h / 2, w, h, h / 2);
    x.fill();
    x.restore();

    const ink = rgba(mix3(this.col, BLACK, 0.12));
    x.fillStyle = ink;
    x.strokeStyle = ink;
    x.lineCap = "round";
    x.lineJoin = "round";
    switch (this.badge) {
      case "dots":
        for (let i = 0; i < 3; i++) {
          const ph = (((t * 2.2 - i * 0.2) % 1) + 1) % 1;
          const lift = Math.max(0, Math.sin(ph * Math.PI * 2)) * R * 0.06;
          x.beginPath();
          x.arc((i - 1) * R * 0.16, -lift + R * 0.01, R * 0.055, 0, Math.PI * 2);
          x.fill();
        }
        break;
      case "bang":
      case "q":
        x.font = `800 ${R * 0.3}px ${FONT}`;
        x.textAlign = "center";
        x.textBaseline = "middle";
        x.fillText(this.badge === "bang" ? "!" : "?", 0, R * 0.015);
        break;
      case "check":
        x.lineWidth = R * 0.07;
        x.beginPath();
        x.moveTo(-R * 0.11, 0);
        x.lineTo(-R * 0.025, R * 0.08);
        x.lineTo(R * 0.13, -R * 0.08);
        x.stroke();
        break;
      case "x":
        x.lineWidth = R * 0.065;
        x.beginPath();
        x.moveTo(-R * 0.08, -R * 0.08);
        x.lineTo(R * 0.08, R * 0.08);
        x.moveTo(R * 0.08, -R * 0.08);
        x.lineTo(-R * 0.08, R * 0.08);
        x.stroke();
        break;
      case "hour":
        x.rotate(Math.sin(t * 1.5) * 0.25);
        for (const sd of [-1, 1]) {
          x.beginPath();
          x.moveTo(-R * 0.085, sd * R * 0.12);
          x.lineTo(R * 0.085, sd * R * 0.12);
          x.lineTo(0, 0);
          x.closePath();
          x.fill();
        }
        break;
    }
    x.restore();
  }

  private drawParticles(x: CanvasRenderingContext2D, R: number, cx: number, headTop: number) {
    for (const p of this.particles) {
      if (p.age < 0) continue;
      // The compact island's bot: a "z" there would be letters three pixels tall.
      if (p.type === "z" && R < 14) continue;
      const k = p.age / p.life;
      const a = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
      const px = cx + (p.x + p.vx * p.age) * R;
      const py = headTop + (p.y + p.vy * p.age) * R;
      const sz = R * p.size * (1 + k * 0.4);

      x.save();
      x.translate(px, py);
      x.globalAlpha = clamp(a, 0, 1);
      switch (p.type) {
        case "heart":
          x.rotate(Math.sin(p.age * 6) * 0.3);
          x.fillStyle = HEART;
          heartPath(x, sz);
          x.fill();
          break;
        case "star":
          x.rotate(p.rot + p.age * 2);
          x.fillStyle = STAR;
          starPath(x, sz, sz * 0.45);
          x.fill();
          break;
        case "spark":
          x.rotate(p.rot);
          x.fillStyle = "#fff";
          starPath(x, sz * 0.85, sz * 0.18);
          x.fill();
          break;
        case "sweat":
          x.fillStyle = "#8FD0FF";
          x.beginPath();
          x.moveTo(0, -sz);
          x.quadraticCurveTo(sz * 0.8, sz * 0.2, 0, sz * 0.6);
          x.quadraticCurveTo(-sz * 0.8, sz * 0.2, 0, -sz);
          x.fill();
          break;
        case "z":
          x.fillStyle = "rgb(215,222,238)";
          x.font = `700 ${sz * 1.9}px ${FONT}`;
          x.fillText("z", 0, 0);
          break;
        case "puff":
          x.fillStyle = "rgba(226,238,255,0.9)";
          x.beginPath();
          x.arc(0, 0, sz, 0, Math.PI * 2);
          x.fill();
          break;
      }
      x.restore();
    }
  }
}

/** The arm's wave: up with a little overshoot, a second of waving, and down. */
const WAVE: TweenKey[] = [[1, 280, Ease.back], [1, 1000, Ease.lin], [0, 320, Ease.inOut]];

/** The plush's hairs, all round the outline but not under it. */
function makeHairs(): Hair[] {
  const hairs: Hair[] = [];
  while (hairs.length < 170) {
    const a = Math.random() * Math.PI * 2;
    if (Math.sin(a) > 0.55) continue;
    hairs.push({ a, l: 0.55 + Math.random() * 0.75, b: Math.random() * 2 - 1 });
  }
  return hairs;
}
