// The Shelf's six widgets: what each is called, its colour, its mark and the
// size of the island while it is expanded. The ids are Rust's (settings.rs
// `SHELF_WIDGETS`); Settings → Shelf has its own copy of the names and colours.

import { OVERSHOOT_H, Room } from "../core/layout";
import { State } from "../core/state";
import { LUCIDE } from "../views/iconset";

export const SHELF_WIDGETS = {
  // Each widget's `w` × `h` is the island's size while it is expanded (the approved preview's).
  media: { name: "Media", accent: "#34D399", icon: LUCIDE.music, w: 460, h: 200 },
  todo: { name: "To-do", accent: "#FACC15", icon: LUCIDE.listTodo, w: 520, h: 300 },
  timer: { name: "Timer", accent: "#F5A524", icon: LUCIDE.timer, w: 360, h: 338 },
  reminders: { name: "Reminders", accent: "#F472B6", icon: LUCIDE.bell, w: 440, h: 304 },
  // The largest: a rounded 4:3 preview.
  mirror: { name: "Mirror", accent: "#22D3EE", icon: LUCIDE.camera, w: 520, h: 390 },
  projects: { name: "Projects", accent: "#3B9EFF", icon: LUCIDE.folder, w: 580, h: 330 },
} as const;
export type ShelfWidgetId = keyof typeof SHELF_WIDGETS;
export const WIDGET_IDS = Object.keys(SHELF_WIDGETS) as ShelfWidgetId[];
export const isWidget = (id: unknown): id is ShelfWidgetId => typeof id === "string" && id in SHELF_WIDGETS;

/** The widgets on the shelf, in their order: the saved one, each once, what it does not name at the end, less the hidden ones. */
export function shelfWidgets(): ShelfWidgetId[] {
  const { shelfOrder, shelfHidden } = State.settings;
  const said = Array.isArray(shelfOrder) ? shelfOrder.filter(isWidget) : [];
  const hidden = new Set(Array.isArray(shelfHidden) ? shelfHidden.filter(isWidget) : []);
  return [...new Set([...said, ...WIDGET_IDS])].filter((id) => !hidden.has(id));
}

/** Switched on in Settings → Shelf: a widget that is off never runs, and nothing of it is armed. */
export const widgetOn = (id: ShelfWidgetId) => shelfWidgets().includes(id);

/** The island's size while a widget is expanded: never taller than the window leaves room for. */
export function expandedSize(id: ShelfWidgetId): { w: number; h: number } {
  const def = SHELF_WIDGETS[id];
  return { w: def.w, h: Math.min(def.h, Math.max(160, Room.h - OVERSHOOT_H)) };
}
