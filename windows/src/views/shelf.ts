// The Shelf (plans/tabs-plan.md §2): the island's second tab, a row of small
// widgets that scroll sideways and come to rest on a card. Each widget is one
// thing in two sizes: the small card works where it stands, and the expanded
// view — the card morphing into it — is the same state with more in it
// (src/widgets/).
//
// Nothing here runs on its own. The row is drawn when the order changes; a
// widget is painted when it changes or when the Shelf comes on show; and while
// it is on show, one timer ticks once a second for what grows old by itself.
// With the Shelf off the screen — another tab, a card over it, the island
// folded or hidden — the timer is gone, and every widget has been told to let
// go of whatever it holds open (the camera).
//
// The Shelf does not own the island's size: an expanded widget says how large
// it wants the island (`width`, `height`), and the island's own spring does it.

import { Bridge } from "../core/bridge";
import { Spring, clamp } from "../core/anim";
import { SHELF_CARD_GAP, SHELF_CARD_W } from "../core/layout";
import { State } from "../core/state";
import { BUILDERS } from "../widgets";
import { flushWidgets, onShelfChange } from "../widgets/core";
import { SHELF_WIDGETS, WIDGET_IDS, expandedSize, shelfWidgets, type ShelfWidgetId } from "../widgets/defs";
import { enableGestures } from "../widgets/gestures";
import { mediaOn } from "../widgets/media";
import { nextReminder } from "../widgets/reminders";
import { todo } from "../widgets/todo";
import { CONTROL, mini, type Widget, type WidgetContext } from "../widgets/ui";
import { clear, h } from "./dom";
import type { ViewActions, ViewHost } from "./views";

export { SHELF_WIDGETS, shelfWidgets };
export type { ShelfWidgetId };

/** How long a card is held before it lifts to be moved (plans/tabs-plan.md §2). */
const LONG_PRESS_MS = 350;

/** What the Shelf names for one shared-element transition (see `Shelf` below and the island's `morph`). */
export interface MorphNames {
  /** The side being left: its shared elements get their names. */
  before(): void;
  /** The side being entered, once the page has changed. */
  after(): void;
  /** The transition is over: every name is taken off. */
  clear(): void;
}

/** What the island asks of the Shelf, beyond a view's own. */
export interface ShelfHost extends ViewHost {
  /** The expanded widget, or null on the row. */
  readonly focused: ShelfWidgetId | null;
  /** The island's bar steps aside for an expanded widget. */
  readonly bare: boolean;
  /** Back to the row, with the morph: Escape, Backspace, a swipe to the right. False when there was nothing to go back from. */
  closeWidget(): boolean;
  /** A timer ran out, a reminder is due: the widget is expanded at once, with no morph. */
  showWidget(id: ShelfWidgetId): void;
  /** The Shelf is on show, or is not: what ticks is started, or stopped, and every widget told. */
  visible(on: boolean): void;
  /** The island folds: the expanded widget goes back to the row, unseen, and the keyboard is let go. */
  leave(): void;
}

// ── The spring of a shared-element transition ─────────────────────────────────
// The browser draws the morph from an easing function, not a spring. The island's
// own spring (anim.ts, response 0.5, damping 0.72) is run once from 0 to 1 and
// written out as a `linear()` easing, so a card grows into a widget exactly as
// the island grows between views.

let curveMade = false;

export function ensureMorphCurve() {
  if (curveMade) return;
  curveMade = true;
  const spring = new Spring(0);
  spring.target = 1;
  const step = 1 / 120;
  const samples = [0];
  let t = 0;
  while (t < 1.5) {
    spring.step(step);
    t += step;
    samples.push(spring.value);
    if (Math.abs(1 - spring.value) < 0.0015 && Math.abs(spring.velocity) < 0.02) break;
  }
  samples[samples.length - 1] = 1;
  const root = document.documentElement;
  root.style.setProperty("--vt-spring", `linear(${samples.map((v) => clamp(v, -1, 2).toFixed(4)).join(", ")})`);
  root.style.setProperty("--vt-spring-ms", `${Math.round(t * 1000)}ms`);
}

// ── The row, scrolled by hand ─────────────────────────────────────────────────

/**
 * The row scrolled by hand. The island moves it itself, by the travel of each
 * wheel event (island.ts `swipeTabs`): left to the browser, a wheel event goes
 * to whatever was under the pointer before the view changed, and scrolls
 * nothing until the pointer moves. While it is moved so, the row does not snap
 * (`.swiping`): each small step would be pulled back to the card it left.
 */
export function scrollRow(row: HTMLElement, dx: number) {
  row.classList.add("swiping");
  row.scrollLeft += dx;
}

/** The gesture has paused: the row comes to rest on a card, as it does when the browser scrolls it. */
export function settleRow(row: HTMLElement, still: boolean) {
  if (!row.classList.contains("swiping")) return;
  const step = SHELF_CARD_W + SHELF_CARD_GAP;
  const max = Math.max(0, row.scrollWidth - row.clientWidth);
  // The nearest card's edge — or the row's end, when that is nearer than the last edge before it.
  const edge = Math.min(max, Math.round(row.scrollLeft / step) * step);
  const left = Math.abs(max - row.scrollLeft) < Math.abs(row.scrollLeft - edge) ? max : edge;
  const snap = () => row.classList.remove("swiping");
  if (still || Math.abs(left - row.scrollLeft) < 1) {
    row.scrollLeft = left;
    snap();
    return;
  }
  // Snapping comes back once it has arrived; a scroll that is taken over meanwhile says so again.
  row.addEventListener("scrollend", snap, { once: true });
  window.setTimeout(snap, 600);
  row.scrollTo({ left, behavior: "smooth" });
}

/** A widget that is not built yet has its place in the row, and nothing in it. */
function placeholder(id: ShelfWidgetId): HTMLElement {
  const el = mini(id, h("div", { class: "wmini-none", text: "Coming next" }));
  el.querySelector(".wmini-expand")?.remove();
  return el;
}

export function buildShelf(actions: ViewActions): ShelfHost {
  const row = h("div", { class: "shelf-row" });
  const empty = h("div", { class: "shelf-empty" },
    h("div", { class: "title", text: "Every widget is hidden." }),
    h("div", { class: "sub", text: "Turn some on in Settings → Shelf." }),
    h("button", { class: "link-btn", text: "Open Settings…", onclick: () => actions.openSettingsWindow() }));
  const rowLayer = h("div", { class: "shelf-layer on" }, row, empty);
  const focusLayer = h("div", { class: "shelf-layer" });
  const el = h("div", { class: "view shelf-view" }, rowLayer, focusLayer);
  // The card's width and the gap, said once (layout.ts): the stylesheet reads them here.
  el.style.setProperty("--shelf-card-w", `${SHELF_CARD_W}px`);
  el.style.setProperty("--shelf-card-gap", `${SHELF_CARD_GAP}px`);

  // ── The widgets ─────────────────────────────────────────────────────────────

  let focus: ShelfWidgetId | null = null;
  const widgets = new Map<ShelfWidgetId, Widget>();
  const placeholders = new Map<ShelfWidgetId, HTMLElement>();

  const ctx: WidgetContext = {
    back: () => void closeWidget(),
    expand: (id, opts) => openWidget(id, opts?.camera === true),
    keyboard: (on) => actions.keyboard(on),
  };
  for (const id of WIDGET_IDS) {
    const make = BUILDERS[id];
    if (!make) {
      placeholders.set(id, placeholder(id));
      continue;
    }
    const widget = make(ctx);
    widgets.set(id, widget);
    focusLayer.append(widget.card);
    // A tap on the card expands it — unless it landed on a control, which then acts by
    // itself. The corner's expand button is the one control that expands. A press that
    // moved never gets this far: gestures.ts swallows its click.
    widget.small.addEventListener("click", (e) => {
      // The path as it was when the click began: a control may have redrawn itself since
      // (play turns to pause), and what was clicked is then no longer inside it.
      const control = e.composedPath().find((n): n is Element => n instanceof Element && n.matches(CONTROL));
      if (control && !control.hasAttribute("data-expand")) return;
      openWidget(id);
    });
  }

  /** More cards past an edge: that edge fades. */
  const edges = () => {
    const max = row.scrollWidth - row.clientWidth;
    row.classList.toggle("more-left", row.scrollLeft > 2);
    row.classList.toggle("more-right", row.scrollLeft < max - 2);
  };
  row.addEventListener("scroll", edges, { passive: true });
  // The row is narrower while the island is still opening.
  new ResizeObserver(edges).observe(row);

  /** What the row was last drawn for: nothing is touched when that has not changed. */
  let key: string | null = null;

  /**
   * Settings' order, with what has something to say in front: a reminder that
   * waits, then a list with something left to do. A player with nothing on
   * goes to the end.
   */
  function ranked(shown: ShelfWidgetId[]): ShelfWidgetId[] {
    const rank = (id: ShelfWidgetId) =>
      id === "reminders" && nextReminder() ? 0 : id === "todo" && todo.items.some((i) => !i.done) ? 1 : id === "media" && !mediaOn() ? 3 : 2;
    return shown.map((id, at) => ({ id, at })).sort((a, b) => rank(a.id) - rank(b.id) || a.at - b.at).map((x) => x.id);
  }

  /** The row, the order Settings says — less what `ranked` moves. */
  function drawRow(inOrder: ShelfWidgetId[]) {
    const shown = ranked(inOrder);
    const next = shown.join();
    if (next === key) return;
    key = next;
    clear(row);
    for (const id of shown) row.append(widgets.get(id)?.small ?? placeholders.get(id)!);
    row.style.display = shown.length ? "" : "none";
    empty.style.display = shown.length ? "none" : "";
    row.scrollLeft = 0;
    edges();
  }

  // A card dragged to another place, or a swipe: the order is Settings'. The same
  // two settings the Settings window writes, and the island follows it live.
  enableGestures({
    row,
    card: ".wmini",
    control: CONTROL,
    longPressMs: LONG_PRESS_MS,
    onScrollStart: () => row.classList.add("swiping"),
    onScrollEnd: () => settleRow(row, actions.reducedMotion()),
    onReorder: (ids) => {
      const moved = ids.filter((id): id is ShelfWidgetId => id in SHELF_WIDGETS);
      const hidden = new Set(State.settings.shelfHidden);
      const order = (Array.isArray(State.settings.shelfOrder) ? State.settings.shelfOrder : WIDGET_IDS) as ShelfWidgetId[];
      // The visible cards in their new order, the hidden ones where they were.
      let at = 0;
      const next = [...new Set([...order, ...WIDGET_IDS])].map((id) => (hidden.has(id) ? id : moved[at++] ?? id));
      State.settings.shelfOrder = next;
      // The row already stands as it will be drawn: it is not drawn again.
      key = moved.join();
      void Bridge.saveSettings(State.settings);
      State.notify();
    },
  });

  // ── Paint ───────────────────────────────────────────────────────────────────

  let live = false;
  let tickTimer = 0;

  /** The small cards on the shelf and the expanded one, from their widgets' state. */
  function paintAll() {
    for (const id of shelfWidgets()) widgets.get(id)?.paint();
    if (focus) widgets.get(focus)?.paint();
  }

  /** Which layer is on show, and which widget's view is in it. */
  function render() {
    const open = focus != null;
    rowLayer.classList.toggle("on", !open);
    rowLayer.inert = open;
    focusLayer.classList.toggle("on", open);
    focusLayer.inert = !open;
    for (const [id, widget] of widgets) widget.card.classList.toggle("on", id === focus);
  }

  /** What a widget changed, said while the Shelf is on show: repainted at once. Off the screen, nothing is painted. */
  onShelfChange(() => {
    if (!live) return;
    // What a widget has to say may have changed its place in the row — never under a card being carried.
    if (!focus && !row.classList.contains("reordering") && !row.classList.contains("dragging")) drawRow(shelfWidgets());
    paintAll();
  });

  /** Once a second, while the Shelf is on show: what is on the row, or the one widget expanded. */
  function tick() {
    if (focus) widgets.get(focus)?.tick?.();
    else for (const id of shelfWidgets()) widgets.get(id)?.tick?.();
  }

  function stopAll(why: string) {
    for (const widget of widgets.values()) widget.stop?.(why);
  }

  // ── The morph ───────────────────────────────────────────────────────────────
  // Every element that is the same thing in the small card and in the expanded
  // view carries `data-vt` (widgets/ui.ts). For the length of one transition the
  // ones on show get `view-transition-name: w-<that name>`: first in the size
  // being left, then — once the page has changed — in the size being entered. A
  // name on both sides moves; a name on one side only fades. Names are unique at
  // each capture because only one widget, in one size, wears them at a time.

  const named = new Set<HTMLElement>();
  let revealTimer = 0;

  /** Laid out, and not scrolled out of the list or the row that holds it. */
  function onShow(node: HTMLElement): boolean {
    const box = node.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const holder = node.parentElement?.closest<HTMLElement>(".gh-list, .shelf-row");
    if (!holder) return true;
    const clip = holder.getBoundingClientRect();
    return box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1 && box.left >= clip.left - 1 && box.right <= clip.right + 1;
  }

  function nameShared(scope: HTMLElement) {
    const done: string[] = [];
    for (const node of [scope, ...scope.querySelectorAll<HTMLElement>("[data-vt]")]) {
      const name = node.dataset.vt;
      if (!name || done.includes(name) || !onShow(node)) continue;
      node.style.setProperty("view-transition-name", `w-${name}`);
      if (node.dataset.vtc) node.style.setProperty("view-transition-class", `w-${node.dataset.vtc}`);
      named.add(node);
      done.push(name);
    }
  }

  function unnameAll() {
    for (const node of named) {
      node.style.removeProperty("view-transition-name");
      node.style.removeProperty("view-transition-class");
    }
    named.clear();
  }

  /** Brings a card wholly into the row's view, at once: what is cut by the row's edge would grow from outside the island. */
  function revealCard(card: HTMLElement) {
    const left = card.offsetLeft - row.offsetLeft;
    const right = left + card.offsetWidth;
    if (left >= row.scrollLeft && right <= row.scrollLeft + row.clientWidth) return;
    // Set by hand, so not while the row snaps by itself.
    window.clearTimeout(revealTimer);
    row.classList.add("swiping");
    row.scrollLeft = left < row.scrollLeft ? left : right - row.clientWidth;
    revealTimer = window.setTimeout(() => row.classList.remove("swiping"), 800);
  }

  function morphNames(widget: Widget, open: boolean): MorphNames {
    return {
      before() {
        unnameAll();
        if (open) revealCard(widget.small);
        nameShared(open ? widget.small : widget.card);
      },
      after() {
        unnameAll();
        // Going back: the card it shrinks into stands wholly in the row.
        if (!open && widget.small.isConnected) revealCard(widget.small);
        nameShared(open ? widget.card : widget.small);
      },
      clear: unnameAll,
    };
  }

  /**
   * Changes what the Shelf shows — a widget expands, or goes back — as the
   * morph where the page can draw one, and as the island's spring and a
   * cross-fade where it cannot (or where motion is reduced: then, a plain swap).
   */
  function go(change: () => void, id: ShelfWidgetId, open: boolean) {
    const widget = widgets.get(id);
    if (widget && actions.morph(change, morphNames(widget, open), open)) return;
    change();
    actions.resized(!open);
  }

  function openWidget(id: ShelfWidgetId, camera = false) {
    if (focus || !widgets.has(id)) return;
    go(() => {
      focus = id;
      render();
      paintAll();
      widgets.get(id)?.opened?.({ camera });
    }, id, true);
  }

  function closeWidget(): boolean {
    if (!focus) return false;
    const id = focus;
    // The widget on its way out lets go of what it holds open — the camera — at once.
    if (document.activeElement instanceof HTMLElement && el.contains(document.activeElement)) document.activeElement.blur();
    widgets.get(id)?.stop?.("closed");
    go(() => {
      focus = null;
      render();
      paintAll();
    }, id, false);
    return true;
  }

  return {
    el,

    get focused() {
      return focus;
    },
    get bare() {
      return focus != null;
    },
    get width() {
      return focus ? expandedSize(focus).w : undefined;
    },
    get height() {
      return focus ? expandedSize(focus).h : undefined;
    },

    sync() {
      const shown = shelfWidgets();
      // Switched off in Settings while it was expanded: back to the row.
      if (focus && !shown.includes(focus)) {
        widgets.get(focus)?.stop?.("switched off");
        focus = null;
      }
      drawRow(shown);
      render();
      paintAll();
    },

    closeWidget,

    showWidget(id) {
      if (!widgets.has(id)) return;
      focus = id;
      render();
      paintAll();
    },

    visible(on) {
      if (on === live) return;
      live = on;
      if (on) {
        paintAll();
        tickTimer = window.setInterval(tick, 1000);
        // Not a second late: what is asked of the system (the player) is asked now.
        tick();
      } else {
        window.clearInterval(tickTimer);
        tickTimer = 0;
        stopAll("the Shelf is off the screen");
        flushWidgets();
      }
    },

    leave() {
      if (document.activeElement instanceof HTMLElement && el.contains(document.activeElement)) document.activeElement.blur();
      stopAll("the island folded");
      if (focus) {
        focus = null;
        render();
      }
      flushWidgets();
    },
  };
}
