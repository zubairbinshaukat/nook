// Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
// + IslandRootView.botPosition. All values are logical pixels, identical to the
// macOS app's points.

export type IslandMode = "hidden" | "compact" | "expanded";

export type IslandViewName =
  | "overview"
  | "empty"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "confused"
  | "settings"
  | "greeting"
  | "session"
  | "shelf";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

export type BotEmoteName =
  | "hello" | "love" | "giggle" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export type AgentLayoutMode = "none" | "grid" | "pills" | "column";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
  agentMode: AgentLayoutMode;
}

// The island at its normal size is 720×320 at most, like the macOS panel: the
// session panel is, and no card is taller. It is drawn glued to the top edge of
// its window and horizontally centred in it.
export const PANEL_W = 720;
export const PANEL_H = 320;

/** The session panel at its large size: this, or what of it the display has room for. */
export const LARGE_W = 1120;
export const LARGE_H = 640;

/**
 * The window's own size. It is given once the size of the largest shape the
 * island takes — the large panel — and never follows the island as it grows
 * and shrinks (src-tauri/src/island.rs sizes it, and says here what it came
 * to on this display). The island is centred in it; the large panel fills it.
 */
export const Room = { w: PANEL_W, h: PANEL_H };

/**
 * What the large panel leaves of the window, in all: the spring it opens on
 * goes a little past its size before it settles, and would be cut by the
 * window's edge.
 */
export const OVERSHOOT_W = 16;
export const OVERSHOOT_H = 14;

/** The session panel's size: normal, or large. */
export function sessionSize(large: boolean): { w: number; h: number } {
  if (!large) return { w: PANEL_W, h: PANEL_H };
  return {
    w: Math.max(PANEL_W, Math.min(LARGE_W, Room.w - OVERSHOOT_W)),
    h: Math.max(PANEL_H, Math.min(LARGE_H, Room.h - OVERSHOOT_H)),
  };
}

// No notch on a PC: these are the hidden/compact sizes from docs/SPEC.md.
export const NOTCH_W = 184;
export const NOTCH_H = 38;
/** The folded island as the greeting draws it, and as the previews unfold from. Its real width is `compactLayout`'s. */
export const COMPACT_W = 288; // NOTCH_W + 104
/** The folded island with nothing beside the bot. Kept for what was written against it: `compactLayout` says the width now. */
export const COMPACT_SOLO_W = 76;
export const EXPANDED_W = 640;

/**
 * The folded island: fixed slots, left to right — the bot, a dot per session,
 * up to three metric cells. Every slot has its own width, and an empty one
 * goes with its gap; nothing in it can push the island wider.
 */
export const COMPACT_PAD = 12;
export const COMPACT_SLOT_GAP = 10;
export const COMPACT_BOT_SLOT = 34;
/** The bot in its slot: its diameter (`botPosition`). */
export const COMPACT_BOT = 26;
export const COMPACT_DOT = 9;
export const COMPACT_DOT_GAP = 6;
export const COMPACT_MORE_W = 24;
export const COMPACT_METRIC_GAP = 8;
/** Sessions on show — dots here, mini bots on the home view — before the rest fold into "+N". */
export const MAX_VISIBLE = 6;
/** It is never wider than this, ears included… */
export const COMPACT_MAX_W = 420;
/** …nor than this share of the display's logical width, whichever is smaller. */
export const COMPACT_SCREEN_SHARE = 0.4;

/**
 * The ears: the concave quarter-circles the island flares into the top edge
 * with, on each side. Their radius, folded and open; it follows the island's
 * size on the same spring.
 */
export const EAR_COMPACT = 11;
export const EAR_EXPANDED = 16;

/**
 * The display the island hangs from: its logical width, which caps the folded
 * island. `zoom` is 1 in the app; a dev page that scales its stage to stand
 * for display scaling says by how much, so that edges are snapped to the
 * pixels really drawn.
 */
export const Display = { w: 1920, zoom: 1 };

/** The widest the folded island may be on this display, ears included. */
export const compactCap = () => Math.min(COMPACT_MAX_W, Math.floor(Display.w * COMPACT_SCREEN_SHARE));

export interface CompactLayout {
  /** Dots on show; the other sessions are behind "+N". */
  dots: number;
  /** Metric cells on show: the first this many of those picked. */
  metrics: number;
  /** The island's body: what it is wide for, ears not counted. */
  width: number;
}

/**
 * What of the folded island fits under `cap`, for this many sessions and metric
 * cells of these widths. Short of room, the last metric goes first, then dots
 * fold into "+N": the bot and a way to the sessions always stay.
 */
export function compactLayout(sessions: number, metricWidths: readonly number[], cap = compactCap()): CompactLayout {
  const dotsWidth = (dots: number) => {
    if (sessions === 0) return 0;
    const more = sessions > dots ? COMPACT_MORE_W : 0;
    const cells = dots + (more ? 1 : 0);
    return dots * COMPACT_DOT + more + Math.max(0, cells - 1) * COMPACT_DOT_GAP;
  };
  const metricsWidth = (count: number) =>
    metricWidths.slice(0, count).reduce((w, m) => w + m, 0) + Math.max(0, count - 1) * COMPACT_METRIC_GAP;
  const body = (dots: number, count: number) => {
    const d = dotsWidth(dots);
    const m = metricsWidth(count);
    return COMPACT_PAD + COMPACT_BOT_SLOT + (d ? COMPACT_SLOT_GAP + d : 0) + (m ? COMPACT_SLOT_GAP + m : 0) + COMPACT_PAD;
  };
  let dots = Math.min(MAX_VISIBLE, sessions);
  let metrics = metricWidths.length;
  while (metrics > 0 && body(dots, metrics) + 2 * EAR_COMPACT > cap) metrics--;
  while (dots > 0 && body(dots, metrics) + 2 * EAR_COMPACT > cap) dots--;
  return { dots, metrics, width: body(dots, metrics) };
}

export const ROUNDED_CORNER = 16; // hidden / compact
export const EXPANDED_CORNER = 22;

/** Invisible hover strip that wakes the island when hidden. */
export const WAKE_STRIP_W = 240;
export const WAKE_STRIP_H = 6;

/**
 * The bot in the session panel: at the head of the sidebar, beside the
 * session's name — and, in the large panel, at full size above it, in the
 * middle of the sidebar (style.css `.sess-bot-slot` keeps the room).
 */
export const SESSION_BOT = {
  normal: { x: 57, y: 72, diameter: 46 },
  large: { x: 152, y: 105, diameter: 71 },
} as const;

/**
 * How tall the island is for the home view: three columns — the bot, a row of
 * mini bots, five lines of resources — need more than a card's 160 and less
 * than the session panel's 320.
 */
export const HOME_H = 248;

/**
 * The Shelf, the island's second tab (plans/tabs-plan.md §2): a row of small
 * cards, each this wide and this far from the next, that scrolls sideways.
 * The island is this tall for it: a card holds three lines and a field under
 * its header.
 */
export const SHELF_H = 212;
export const SHELF_CARD_W = 200;
export const SHELF_CARD_GAP = 10;
/** The row's inner width: four whole cards and a sliver of the fifth, so the row reads as one that goes on. */
const SHELF_VISIBLE_CARDS = 4;
const SHELF_PEEK = 12;
/** The island's side padding (style.css `#content`). */
const ISLAND_SIDE_PAD = 10;
/** The Shelf's width at its widest: wider than Home, so that its cards are not cut. */
export const SHELF_W =
  SHELF_VISIBLE_CARDS * (SHELF_CARD_W + SHELF_CARD_GAP) + SHELF_PEEK + 2 * ISLAND_SIDE_PAD;

/** The Shelf's width on this display: as wide as the window has room for, never narrower than Home. */
export function shelfWidth(): number {
  return Math.max(EXPANDED_W, Math.min(SHELF_W, Room.w - OVERSHOOT_W));
}

/** How far a tab's view travels sideways as it gives way to the other, and the bot with it. */
export const TAB_SLIDE = 28;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  // The home view: the bot stands in the stage its card keeps for it, on the
  // left (style.css `.hb-stage`: its feet 6 px above the stage's bottom edge).
  overview: { height: HOME_H, botX: 92, botY: 89, botDiameter: 58, agentMode: "none" },
  empty: { height: 160, botX: 70, botY: null, botDiameter: 62, agentMode: "none" },
  approval: { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  // 196 as docs/SPEC.md has it: a question, its options, and a line for what
  // the option under the mouse means.
  question: { height: 196, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  error: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  finished: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  confused: { height: 160, botX: 76, botY: null, botDiameter: 66, agentMode: "column" },
  settings: { height: 160, botX: 54, botY: null, botDiameter: 46, agentMode: "none" },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0, agentMode: "none" },
  // Windows only, no macOS counterpart yet: what a Claude Code session did —
  // its journal, its subagents, the files it changed. A small bot at the head
  // of the sidebar, beside the session's name, the tree of sessions under it
  // and the journal in a panel on the right. SESSION_BOT has the bot of the
  // panel at its large size.
  session: {
    height: PANEL_H, botX: SESSION_BOT.normal.x, botY: SESSION_BOT.normal.y, botDiameter: SESSION_BOT.normal.diameter,
    agentMode: "none",
  },
  // The Shelf has no bot: the row of cards is all of it. The bot waits where
  // the home view left it, a slide to the left, and is not drawn (`botPosition`).
  shelf: { height: SHELF_H, botX: 92 - TAB_SLIDE, botY: 89, botDiameter: 58, agentMode: "none" },
};

/**
 * An approval card that shows what the edit would do holds a diff between the
 * request and its buttons: the island is that much taller for it — as tall as
 * the window allows.
 */
export const PROPOSAL_ROOM = PANEL_H - 160;

/**
 * A view whose content varies — a question has two options or four, a line
 * each or a row of buttons — says how tall the island should be for it: what
 * it holds, the air the card keeps above and below it, and the island around
 * the card (its bar, its own margins), between a card's usual height and the
 * window's.
 */
const ISLAND_CHROME = 52;
const VIEW_MIN = 160;
/** The air a card that asks something keeps above and below its lines. */
export const CARD_AIR = 22;
/**
 * The least air any card keeps: one that tells something — a turn's end, an
 * error — is as tall as it always was until its lines would come closer to
 * its edges than this.
 */
export const CARD_AIR_MIN = 14;

export function fittedHeight(content: number, air = CARD_AIR): number {
  return Math.min(PANEL_H, Math.max(VIEW_MIN, Math.ceil(content) + ISLAND_CHROME + 2 * air));
}

export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  proposal = false,
  fitted: number | null = null,
  large = false,
  compactW = COMPACT_W,
  fittedW: number | null = null,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // No notch to hide inside on a PC: the island retracts to zero height and
      // slides into the top edge of the screen instead of sitting there as a bar.
      return { w: NOTCH_W, h: 0 };
    case "compact":
      return { w: compactW, h: NOTCH_H };
    case "expanded": {
      if (view === "session") return sessionSize(large);
      const h = fitted ?? VIEW_LAYOUTS[view].height;
      const room = proposal && view === "approval" ? PROPOSAL_ROOM : 0;
      // An expanded widget of the Shelf is as wide as it says: no wider than the window's normal panel.
      return { w: fittedW != null ? Math.min(fittedW, PANEL_W) : view === "shelf" ? shelfWidth() : EXPANDED_W, h: h + room };
    }
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** IslandRootView.botPosition — cy is measured from the island's top edge. */
export function botPosition(
  mode: IslandMode,
  view: IslandViewName,
  islandH: number,
  large = false,
): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: 46, cy: NOTCH_H / 2, diameter: 6, opacity: 0 };
    case "compact":
      // In the middle of its slot, the first one.
      return { cx: COMPACT_PAD + COMPACT_BOT_SLOT / 2, cy: NOTCH_H / 2, diameter: COMPACT_BOT, opacity: 1 };
    case "expanded": {
      if (view === "session") {
        const at = SESSION_BOT[large ? "large" : "normal"];
        return { cx: at.x, cy: at.y, diameter: at.diameter, opacity: 1 };
      }
      const layout = VIEW_LAYOUTS[view];
      if (layout.botY != null) {
        return { cx: layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: view === "shelf" ? 0 : 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

/** The colour of each state: the bot's sprout and bubble (BOT_STATES), and the glow under it. */
export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "idle":
      return "#8FD3A0";
    case "working":
      return "#5AA9FF";
    case "thinking":
      return "#A98BFA";
    case "searching":
      return "#6366F1";
    case "approval":
      return "#FFB547";
    case "question":
      return "#38CFE0";
    case "error":
      return "#FF6B7A";
    case "finished":
      return "#4FD69C";
    case "ratelimit":
      return "#FF9B5C";
    case "sleeping":
      return "#A7B4C8";
    case "dizzy":
      return "#E879F9";
  }
}

/** How strong the glow under the bot is: each state's own glow level (BOT_STATES), 0.65 at its brightest. */
export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "sleeping":
      return 0.1;
    case "idle":
      return 0.23;
    case "ratelimit":
      return 0.4;
    case "thinking":
      return 0.52;
    case "approval":
      return 0.65;
    case "dizzy":
      return 0;
    default:
      return 0.58;
  }
}

// Project colours (IslandConst.projectColors)
const PROJECT_COLORS: Record<string, string> = {
  korus: "#FF5A4E",
  "sbe hub": "#2EC4A0",
  "morning ai brief": "#F29B38",
  "publication ig": "#7C5CFF",
  "ig post": "#7C5CFF",
};

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

export function colorForProject(name: string): string {
  const key = name.toLowerCase().trim();
  const exact = PROJECT_COLORS[key];
  if (exact) return exact;
  for (const [k, c] of Object.entries(PROJECT_COLORS)) {
    if (key.startsWith(k) || key.includes(k)) return c;
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
