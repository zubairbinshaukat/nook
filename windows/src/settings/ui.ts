// The controls the settings window is made of — a toggle, a segmented control,
// a slider with its value, a list that reorders by drag — and the island's
// spring written as a CSS easing. Their looks are in settings.css.

import { h } from "../views/dom";
import { lucide } from "../views/iconset";

// ── The island's spring, as CSS ───────────────────────────────────────────────

/** core/anim.ts `Spring`'s defaults: what `Tracked.springTo` opens the island with. */
const SPRING_RESPONSE = 0.5;
const SPRING_DAMPING = 0.72;

/**
 * That spring's step response, sampled into a CSS `linear()` easing, and how
 * long it takes to settle. Closed form of the same equation anim.ts integrates.
 */
export function springEasing(response = SPRING_RESPONSE, damping = SPRING_DAMPING): { easing: string; ms: number } {
  const omega = (2 * Math.PI) / response;
  const decay = damping * omega;
  const ringing = omega * Math.sqrt(1 - damping * damping);
  // Settled when the envelope is under a thousandth of the way.
  const total = Math.log(1000) / decay;
  const steps = 30;
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (total * i) / steps;
    const x = 1 - Math.exp(-decay * t) * (Math.cos(ringing * t) + (decay / ringing) * Math.sin(ringing * t));
    points.push(i === steps ? "1" : String(Number(x.toFixed(4))));
  }
  return { easing: `linear(${points.join(", ")})`, ms: Math.round(total * 1000) };
}

export const SPRING = springEasing();

// ── Icons ─────────────────────────────────────────────────────────────────────

/** An icon of the set (views/iconset.ts `LUCIDE`), in the colour of the text around it. */
export const icon = lucide;
// ── Toggle ────────────────────────────────────────────────────────────────────

export interface Toggle {
  el: HTMLButtonElement;
  set(on: boolean): void;
}

export function toggle(on: boolean, label: string, onChange: (on: boolean) => void): Toggle {
  const el = h("button", { class: "sp-toggle", type: "button", role: "switch", "aria-label": label }, h("i"));
  const set = (v: boolean) => el.setAttribute("aria-checked", String(v));
  set(on);
  el.addEventListener("click", () => {
    const next = el.getAttribute("aria-checked") !== "true";
    set(next);
    onChange(next);
  });
  return { el, set };
}

// ── Segmented control ─────────────────────────────────────────────────────────

export interface Segmented<T extends string> {
  el: HTMLElement;
  /** Shows `value` as the one picked, without calling back. */
  set(value: T): void;
}

/** One of several, as a row of equal cells with a thumb that slides to the one picked. */
export function segmented<T extends string>(
  label: string,
  options: readonly (readonly [T, string])[],
  value: T,
  onPick: (value: T) => void,
): Segmented<T> {
  const el = h("div", { class: "sp-seg", role: "radiogroup", "aria-label": label }, h("i", { class: "sp-seg-thumb" }));
  el.style.setProperty("--n", String(options.length));
  const buttons = options.map(([id, text]) => {
    const button = h("button", { type: "button", role: "radio", text });
    button.addEventListener("click", () => pick(id));
    return button;
  });
  const set = (v: T) => {
    const at = Math.max(0, options.findIndex(([id]) => id === v));
    el.style.setProperty("--i", String(at));
    buttons.forEach((button, i) => {
      button.setAttribute("aria-checked", String(i === at));
      // One stop in the tab order: the arrows move inside the group.
      button.tabIndex = i === at ? 0 : -1;
    });
  };
  const pick = (v: T) => {
    set(v);
    onPick(v);
  };
  el.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const to = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : step ? (at + step + buttons.length) % buttons.length : -1;
    if (to < 0) return;
    e.preventDefault();
    pick(options[to][0]);
    buttons[to].focus();
  });
  el.append(...buttons);
  set(value);
  return { el, set };
}

// ── Slider ────────────────────────────────────────────────────────────────────

export interface Slider {
  el: HTMLElement;
  /** Shows `value`, without calling back. Left alone while the thumb is held. */
  set(value: number): void;
  setDisabled(disabled: boolean): void;
}

/** 0…100, with the value written beside it. */
export function slider(label: string, value: number, format: (v: number) => string, onInput: (v: number) => void): Slider {
  const input = h("input", { type: "range", min: "0", max: "100", step: "1", value: String(value), "aria-label": label });
  const out = h("output", { class: "sp-slider-value" });
  const paint = () => {
    input.style.setProperty("--p", `${input.value}%`);
    out.textContent = format(Number(input.value));
    input.setAttribute("aria-valuetext", out.textContent);
  };
  input.addEventListener("input", () => {
    paint();
    onInput(Number(input.value));
  });
  paint();
  // While the thumb is held, the value is the hand's: nothing sets it from outside.
  let held = false;
  input.addEventListener("pointerdown", () => (held = true));
  const release = () => (held = false);
  input.addEventListener("pointerup", release);
  input.addEventListener("pointercancel", release);
  input.addEventListener("blur", release);
  const el = h("div", { class: "sp-slider" }, input, out);
  return {
    el,
    set(next) {
      if (held || Number(input.value) === next) return;
      input.value = String(next);
      paint();
    },
    setDisabled(disabled) {
      input.disabled = disabled;
      el.classList.toggle("off", disabled);
    },
  };
}

// ── Moving things: FLIP, and reordering by drag ───────────────────────────────

const place = (el: HTMLElement) => ({ x: el.offsetLeft, y: el.offsetTop });

function glide(el: HTMLElement, dx: number, dy: number) {
  if (!dx && !dy) return;
  const frames = [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }];
  try {
    el.animate(frames, { duration: SPRING.ms, easing: SPRING.easing });
  } catch {
    // An engine without linear() in script: the curve the island's CSS already uses.
    el.animate(frames, { duration: 300, easing: "cubic-bezier(0.3, 1.2, 0.4, 1)" });
  }
}

/** Runs `change` (which reorders `list`'s children), then lets each child travel from where it was. */
export function flip(list: HTMLElement, change: () => void, still: boolean, except?: HTMLElement) {
  const items = [...list.children] as HTMLElement[];
  const before = new Map(items.map((el) => [el, place(el)]));
  change();
  if (still) return;
  for (const el of [...list.children] as HTMLElement[]) {
    const was = before.get(el);
    if (!was || el === except) continue;
    const now = place(el);
    glide(el, was.x - now.x, was.y - now.y);
  }
}

export interface ReorderOptions {
  /** What can be picked up. An item with `data-fixed` stays where it is, and nothing is dropped past it. */
  item: string;
  /** Where a press picks the item up (default: anywhere on it)… */
  handle?: string;
  /** …and where it never does. */
  ignore?: string;
  /** No travelling: reduced motion. */
  still(): boolean;
  /** The items' `data-id`, in their new order. */
  onDrop(order: string[]): void;
}

/**
 * Reorder by drag, for a column or a grid: the item follows the pointer, and
 * takes the place of whichever item the pointer is over. `list` must be the
 * items' offset parent.
 */
export function reorderable(list: HTMLElement, opts: ReorderOptions) {
  let held: { el: HTMLElement; pointer: number; x0: number; y0: number; gx: number; gy: number; lifted: boolean } | null = null;

  const follow = (e: PointerEvent) => {
    if (!held) return;
    const box = list.getBoundingClientRect();
    const { el } = held;
    el.style.transform = `translate(${e.clientX - held.gx - box.left - el.offsetLeft}px, ${e.clientY - held.gy - box.top - el.offsetTop}px)`;
  };

  list.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const el = target.closest<HTMLElement>(opts.item);
    if (!el || el.parentElement !== list || el.dataset.fixed != null) return;
    if (opts.handle && !target.closest(opts.handle)) return;
    if (opts.ignore && target.closest(opts.ignore)) return;
    const r = el.getBoundingClientRect();
    held = { el, pointer: e.pointerId, x0: e.clientX, y0: e.clientY, gx: e.clientX - r.left, gy: e.clientY - r.top, lifted: false };
  });

  window.addEventListener("pointermove", (e) => {
    if (!held || e.pointerId !== held.pointer) return;
    if (!held.lifted) {
      if (Math.hypot(e.clientX - held.x0, e.clientY - held.y0) < 5) return;
      held.lifted = true;
      held.el.classList.add("lifted");
      list.classList.add("reordering");
    }
    e.preventDefault();
    const box = list.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    const { el } = held;
    // Where the others are laid out, not where they are mid-travel.
    const over = ([...list.querySelectorAll<HTMLElement>(`:scope > ${opts.item}`)]).find((other) =>
      other !== el && other.dataset.fixed == null &&
      px >= other.offsetLeft && px < other.offsetLeft + other.offsetWidth &&
      py >= other.offsetTop && py < other.offsetTop + other.offsetHeight);
    if (over) {
      const after = Boolean(el.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING);
      flip(list, () => (after ? over.after(el) : over.before(el)), opts.still(), el);
    }
    follow(e);
  });

  const drop = (e: PointerEvent) => {
    if (!held || e.pointerId !== held.pointer) return;
    const { el, lifted } = held;
    held = null;
    if (!lifted) return;
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    el.style.transform = "";
    el.classList.remove("lifted");
    list.classList.remove("reordering");
    if (!opts.still()) glide(el, m.m41, m.m42);
    // The press ends on the item: that is not a click on it.
    const swallow = (c: Event) => c.stopPropagation();
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    opts.onDrop(([...list.children] as HTMLElement[]).map((c) => c.dataset.id ?? "").filter(Boolean));
  };
  window.addEventListener("pointerup", drop);
  window.addEventListener("pointercancel", drop);
}
