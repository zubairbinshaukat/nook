// The pieces every widget is built from: the small card, the expanded view's
// frame, the fields that take the keyboard, a line with a box to tick.
//
// An element that is the same thing in both sizes carries `data-vt`: the name
// it shares with its counterpart. When a card expands (or goes back) the Shelf
// gives the two a common `view-transition-name`, and the browser moves the one
// into the other. `data-vtc="text"` asks for it to be moved without being
// stretched (style.css).

import { clear, h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { lucide } from "../views/iconset";
import { SHELF_WIDGETS, type ShelfWidgetId } from "./defs";

export interface Widget {
  id: ShelfWidgetId;
  /** The small card on the shelf. */
  small: HTMLElement;
  /** The expanded view. */
  card: HTMLElement;
  /** Repaints both from the widget's state. */
  paint(): void;
  /**
   * Once a second, while the Shelf is on show and this widget is on it (in the
   * row, or expanded): what grows old by itself — a countdown, a position.
   */
  tick?(): void;
  /** The widget was just expanded (`camera`: by its own "Turn camera on"). */
  opened?(opts: { camera?: boolean }): void;
  /** The widget is off the screen — the Shelf was left, an alert took over, the island folded: whatever it holds open is let go. */
  stop?(why: string): void;
}

export interface WidgetContext {
  /** The back pill of an expanded view. */
  back(): void;
  /** Expands a widget; Mirror's "Turn camera on" does, and asks for the camera there. */
  expand(id: ShelfWidgetId, opts?: { camera?: boolean }): void;
  /** A field wants the keyboard, or gives it back: the island never takes it on its own. */
  keyboard(on: boolean): void;
}

/** What in a card is a control: a tap on one acts, and never expands the card. */
export const CONTROL = "button, input, textarea, select, a, label";

const EXPAND = "M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7";
/** The same wait the question's field has: the window must have the keyboard before the field is given the focus. */
const FOCUS_MS = 120;

export function shared<T extends HTMLElement>(el: T, name: string, kind?: "text"): T {
  el.dataset.vt = name;
  if (kind) el.dataset.vtc = kind;
  return el;
}

/** A glyph in a button, drawn again only when it changes. */
export function setIcon(button: HTMLElement, path: string, size: number, stroke?: number) {
  if (button.dataset.icon === path) return;
  button.dataset.icon = path;
  clear(button);
  button.append(svg(path, size, stroke ? { stroke } : {}));
}

export const mark = (id: ShelfWidgetId, size: number) => lucide(SHELF_WIDGETS[id].icon, size);

/** The small card: the widget's mark and name, a corner to expand it, and its working body. */
export function mini(id: ShelfWidgetId, body: HTMLElement): HTMLElement {
  const def = SHELF_WIDGETS[id];
  const card = h("div", { class: `wmini wmini-${id}` },
    h("div", { class: "wmini-head" },
      shared(h("span", { class: "w-mark" }, mark(id, 13)), "icon"),
      shared(h("b", { text: def.name }), "title", "text"),
      h("button", { class: "wmini-expand", title: `Expand ${def.name}`, "aria-label": `Expand ${def.name}`, "data-expand": "" },
        svg(EXPAND, 11, { stroke: 2.4 }))),
    body);
  body.classList.add("wmini-body");
  card.dataset.id = id;
  card.style.setProperty("--c", def.accent);
  return shared(card, "card");
}

/** The expanded view: a back pill, the widget's mark and name, its body. */
export function frame(id: ShelfWidgetId, body: HTMLElement, onBack: () => void, aside?: HTMLElement): HTMLElement {
  const def = SHELF_WIDGETS[id];
  const head = h("div", { class: "fc-head" },
    h("button", { class: "back-pill", title: "Back to the Shelf (Esc, or swipe right)", onclick: onBack },
      svg(ICONS.chevronLeft, 11, { stroke: 2.6 }), "Shelf"),
    shared(h("span", { class: "w-mark fc-mark" }, mark(id, 13)), "icon"),
    shared(h("b", { text: def.name }), "title", "text"),
    aside ?? null);
  const card = h("div", { class: `card wash focus-card fc-${id}` }, head, h("div", { class: "fc-body" }, body));
  card.dataset.id = id;
  card.style.setProperty("--c", def.accent);
  card.style.setProperty("--wash", `color-mix(in srgb, ${def.accent} 30%, transparent)`);
  return shared(card, "card");
}

// ── Typing ────────────────────────────────────────────────────────────────────

/** The fields that want the keyboard now: it is given back when the last of them lets go. */
const wanting = new Set<HTMLElement>();

/**
 * A text field of the Shelf takes the keyboard the way the question's field
 * does: the island's window never activates by itself, so a press on the field
 * asks for it, and the field is given the focus once the window has it. The
 * island's own keys (Space, Backspace, the arrows) never reach a field: its
 * key handler leaves what is typed in alone. Escape leaves the field.
 */
export function takesKeys<T extends HTMLInputElement | HTMLTextAreaElement>(ctx: WidgetContext, field: T): T {
  field.addEventListener("mousedown", () => {
    wanting.add(field);
    ctx.keyboard(true);
    window.setTimeout(() => {
      if (wanting.has(field) && document.activeElement !== field) field.focus();
    }, FOCUS_MS);
  });
  field.addEventListener("blur", () => {
    wanting.delete(field);
    if (wanting.size === 0) ctx.keyboard(false);
  });
  field.addEventListener("keydown", ((e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") field.blur();
  }) as EventListener);
  return field;
}

/** A field that adds what was typed when Enter is pressed. */
export function addField(ctx: WidgetContext, label: string, placeholder: string, add: (text: string) => void, extra = "") {
  const field = takesKeys(ctx, h("input", {
    class: `island-field ${extra}`, type: "text", placeholder, maxlength: 200, "aria-label": label, spellcheck: "false",
  }));
  const commit = () => {
    const text = field.value.trim();
    if (!text) return;
    add(text);
    field.value = "";
  };
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
  });
  return { field, commit };
}

// ── Lines ─────────────────────────────────────────────────────────────────────

/** A line with a box to tick: the box and the words are one button; `extra` stands beside it. */
export function checkRow(o: {
  name: string; text: string; done: boolean; square: boolean; onToggle: () => void; extra?: (Node | null)[];
}) {
  const row = h("div", { class: `gh-row check-row${o.done ? " done" : ""}` },
    h("button", { class: "check-main", title: o.done ? "Mark as not done" : "Mark as done", onclick: o.onToggle },
      h("i", { class: `check${o.square ? " square" : ""}` }, o.done ? svg(ICONS.check, 9, { stroke: 3.4 }) : null),
      h("span", { class: "gh-row-title", text: o.text })),
    ...(o.extra ?? []));
  return shared(row, o.name, "text");
}

export const removeButton = (what: string, onRemove: () => void) =>
  h("button", { class: "row-x", title: `Remove ${what}`, "aria-label": `Remove ${what}`, onclick: onRemove },
    svg(ICONS.xmark, 9));
