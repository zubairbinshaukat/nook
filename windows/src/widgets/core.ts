// What every widget shares: how a change is told to whoever is showing it, how
// a widget's state is kept (loaded once, saved a moment after the last change),
// and the one way a widget has of asking the island to come up.
//
// A widget's small card and its expanded view are two pictures of one state,
// and the state is in the widget's own module — never in the page. Whatever
// changes it calls `notifyShelf`, and whoever is on show repaints.

import { ShelfBackend } from "./backend";
import type { ShelfWidgetId } from "./defs";

// ── What changed, said to whoever is listening ────────────────────────────────

const listeners = new Set<() => void>();
export const onShelfChange = (fn: () => void) => void listeners.add(fn);
export const notifyShelf = () => {
  for (const fn of listeners) fn();
};

// ── Asking the island to come up ──────────────────────────────────────────────

/**
 * A timer ran out, a reminder is due: the island opens on the widget. Set by
 * the island (island.ts `showWidget`); the widgets know nothing of how.
 */
export const ShelfHooks = {
  alert: (_id: ShelfWidgetId) => {},
};

// ── Saved state ───────────────────────────────────────────────────────────────

/** How long after the last change a widget's state is written: one write for a burst of typing. */
const SAVE_DELAY_MS = 500;

const waiting = new Map<string, { value: unknown; timer: number }>();

/** A widget's saved part, or null when it has none (or none that Nook could read). */
export function loadWidget(widget: ShelfWidgetId): Promise<unknown> {
  return ShelfBackend.load(widget);
}

/** Keeps a widget's state: written once, SAVE_DELAY_MS after the last call for it. */
export function saveWidget(widget: ShelfWidgetId, value: unknown) {
  const held = waiting.get(widget);
  if (held) window.clearTimeout(held.timer);
  const timer = window.setTimeout(() => flushWidget(widget), SAVE_DELAY_MS);
  waiting.set(widget, { value, timer });
}

function flushWidget(widget: string) {
  const held = waiting.get(widget);
  if (!held) return;
  window.clearTimeout(held.timer);
  waiting.delete(widget);
  void ShelfBackend.save(widget, held.value);
}

/** Whatever is waiting to be written is written now: the island folds, the page goes. */
export function flushWidgets() {
  for (const widget of [...waiting.keys()]) flushWidget(widget);
}

window.addEventListener("pagehide", flushWidgets);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushWidgets();
});
