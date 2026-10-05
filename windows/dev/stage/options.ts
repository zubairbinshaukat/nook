// The screenshot stage's own URL parameters, parsed once. Preview only.
// Every value is validated: an unknown parameter is ignored, an invalid value
// falls back to its default. The scenario's parameters (`view`, `home`, ...) are
// read by claude-preview.ts itself; the keys below are the stage's.

export type Dock = "top" | "bottom" | "left" | "right";
export type Scene = "desktop" | "browser" | "editor" | "terminal" | "none";
export type Theme = "light" | "dark";
export type Taskbar = "bottom" | "top" | "hidden";
export type Wallpaper = "nook" | "bloom";

export const DOCKS: readonly Dock[] = ["top", "bottom", "left", "right"];
export const SCENES: readonly Scene[] = ["desktop", "browser", "editor", "terminal", "none"];
export const THEMES: readonly Theme[] = ["light", "dark"];
export const TASKBARS: readonly Taskbar[] = ["bottom", "top", "hidden"];
export const WALLPAPERS: readonly Wallpaper[] = ["nook", "bloom"];

export interface StageOptions {
  scene: Scene;
  theme: Theme;
  taskbar: Taskbar;
  /**
   * "nook" (default): Nook's own silk-ribbon wallpaper (stage/wallpapers, drawn by stage/wallpaper-gen).
   * "bloom": the local Windows 11 Bloom photo (stage/assets, git-ignored); Nook's shows when the file is missing.
   * "original", the old drawn wallpaper's name, is read as "nook".
   */
  wallpaper: Wallpaper;
  dock: Dock;
  /** The sidebar opens (never in shot mode). */
  ui: boolean;
  /** The small button that opens the sidebar is shown (never in shot mode). */
  toggle: boolean;
  shot: boolean;
  /** Stage size in px; null follows the window. */
  w: number | null;
  h: number | null;
  /** Display scale, as Windows' 125 % (1.25). */
  scale: number;
  time: string;
  date: string;
  /** Page colour behind everything: "#rrggbb", or "transparent" (scene=none). */
  bg: string | null;
  seed: number | null;
  motion: "reduce" | "full" | null;
}

/** Keys that change the stage live, with no reload; every other key reloads the page. */
export const LIVE_KEYS = ["scene", "theme", "taskbar", "wallpaper", "time", "date", "bg", "ui", "toggle"] as const;

/** Every key the stage reads (the scenario keys are claude-preview.ts's). */
export const STAGE_KEYS = [...LIVE_KEYS, "dock", "shot", "w", "h", "scale", "zoom", "light", "seed", "motion"] as const;

const oneOf = <T extends string>(list: readonly T[], value: string | null, fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback;

const flag = (value: string | null, fallback: boolean): boolean => {
  if (value == null) return fallback;
  if (value === "0" || value === "false" || value === "off") return false;
  return true;
};

const size = (value: string | null): number | null => {
  const n = Number(value);
  return value && Number.isFinite(n) && n >= 200 && n <= 8192 ? Math.round(n) : null;
};

export function parseOptions(params: URLSearchParams): StageOptions {
  const shot = flag(params.get("shot"), false);
  const scale = Number(params.get("scale") ?? params.get("zoom"));
  const seed = params.get("seed");
  const bg = (params.get("bg") ?? "").trim().toLowerCase();
  const time = (params.get("time") ?? "").trim();
  const motion = params.get("motion");
  // `light=1` is the old name of theme=light.
  const theme = oneOf(THEMES, params.get("theme") ?? (params.get("light") ? "light" : null), "dark");
  return {
    scene: oneOf(SCENES, params.get("scene"), "desktop"),
    theme,
    taskbar: oneOf(TASKBARS, params.get("taskbar"), "bottom"),
    wallpaper: oneOf(WALLPAPERS, params.get("wallpaper") === "original" ? "nook" : params.get("wallpaper"), "nook"),
    dock: oneOf(DOCKS, params.get("dock"), "top"),
    shot,
    ui: !shot && flag(params.get("ui"), false),
    toggle: !shot && flag(params.get("toggle"), true),
    w: size(params.get("w")),
    h: size(params.get("h")),
    scale: scale >= 0.5 && scale <= 3 ? scale : 1,
    time: /^([01]?\d|2[0-3]):[0-5]\d$/.test(time) ? time : "10:09",
    date: (params.get("date") ?? "").trim().slice(0, 24) || "10/6/2026",
    bg: bg === "transparent" ? bg : /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.test(bg) ? (bg.startsWith("#") ? bg : `#${bg}`) : null,
    seed: seed != null && seed !== "" && Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : null,
    motion: motion === "reduce" || motion === "full" ? motion : null,
  };
}

/** A small seeded generator (mulberry32): the same seed, the same numbers. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where the island's window stands on the stage, as src-tauri/src/dock.rs places it, in physical px. */
export interface Geometry {
  /** The stage: the whole display. */
  w: number;
  h: number;
  /** The island's window: the work area (what the taskbar leaves), or the display for a top dock. */
  root: { left: number; top: number; width: number; height: number };
}

export const TASKBAR_H = 48;

export function geometry(o: StageOptions, viewW: number, viewH: number): Geometry {
  const w = o.w ?? viewW;
  const h = o.h ?? viewH;
  const bar = o.taskbar === "hidden" ? 0 : Math.round(TASKBAR_H * o.scale);
  // The work area is as tall as the display less the taskbar. A top dock hangs from the display's
  // own edge, over a top taskbar; the others sit in the work area.
  const top = o.dock === "top" ? 0 : o.taskbar === "top" ? bar : 0;
  return { w, h, root: { left: 0, top, width: w, height: Math.max(0, h - bar) } };
}
