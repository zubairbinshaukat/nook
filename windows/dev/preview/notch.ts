// Preview only: the island's outline as one filled SVG path — concave "ears"
// flaring into the top edge of the screen, and squircle-like bottom corners.
//
// One path, not a body plus two ears: there is no seam for a hairline to show
// through, and a vector edge stays crisp at any display scaling (the old
// prototypes cut the ears out with a radial-gradient, which steps).
//
// Width, height, ear and corner are driven together by the app's own motion
// (core/anim.ts `Tracked`: the open spring when growing, the 340 ms close curve
// when shrinking), so the ears scale with the island as it changes size. The
// ear's current radius is also published as `--ear` on the island.

import { Tracked } from "../../src/core/anim";
import { h } from "../../src/views/dom";

/** Ear radius, folded and open. */
export const EAR_COMPACT = 9;
export const EAR_EXPANDED = 16;

/** How far along each edge a bottom corner of radius r runs, and how square its curve is. */
const SMOOTH_REACH = 1.45;
const SMOOTH_HANDLE = 0.2;
/** The outline starts above the screen's edge: nothing can show between the two. */
const ABOVE = 2;

export interface NotchSize { w: number; h: number; ear: number; corner: number }

/**
 * The outline, with the island's body at x 0…w, y 0…h and the ears outside it.
 * A corner is one cubic that leaves each edge with no curvature and passes
 * where a circle of radius `corner` would: a superellipse to the eye.
 */
export function notchPath({ w, h: height, ear, corner }: NotchSize): string {
  const e = Math.max(0, ear);
  const reach = Math.max(0, Math.min(corner * SMOOTH_REACH, w / 2, height - e));
  const k = reach * SMOOTH_HANDLE;
  const n = (v: number) => Number(v.toFixed(3));
  return [
    `M${n(-e)} ${-ABOVE}V0`,
    `A${n(e)} ${n(e)} 0 0 1 0 ${n(e)}`,
    `V${n(height - reach)}`,
    `C0 ${n(height - k)} ${n(k)} ${n(height)} ${n(reach)} ${n(height)}`,
    `H${n(w - reach)}`,
    `C${n(w - k)} ${n(height)} ${n(w)} ${n(height - k)} ${n(w)} ${n(height - reach)}`,
    `V${n(e)}`,
    `A${n(e)} ${n(e)} 0 0 1 ${n(w + e)} 0`,
    `V${-ABOVE}Z`,
  ].join("");
}

export class Notch {
  private w: Tracked;
  private h: Tracked;
  private ear: Tracked;
  private corner: Tracked;
  private path: SVGPathElement;
  private svg: SVGSVGElement;
  /** The size asked for last: what the ears toggle goes back to. */
  private wanted: NotchSize;

  constructor(private island: HTMLElement, size: NotchSize) {
    this.wanted = size;
    this.w = new Tracked(size.w);
    this.h = new Tracked(size.h);
    this.ear = new Tracked(earsOn ? size.ear : 0);
    this.corner = new Tracked(size.corner);

    const NS = "http://www.w3.org/2000/svg";
    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("class", "pv-notch");
    this.svg.setAttribute("aria-hidden", "true");
    this.path = document.createElementNS(NS, "path");
    this.svg.append(this.path);
    island.prepend(this.svg);
    notches.add(this);
    this.draw();
  }

  /** Goes to `size`: at once, or on the island's spring (growing) or close curve (shrinking). */
  set(size: NotchSize, animate = true) {
    this.wanted = size;
    const to = { ...size, ear: earsOn ? size.ear : 0 };
    const move = (value: Tracked, target: number) => {
      if (!animate) value.jump(target);
      else if (target >= value.value) value.springTo(target);
      else value.curveTowards(target);
    };
    move(this.w, to.w);
    move(this.h, to.h);
    move(this.ear, to.ear);
    move(this.corner, to.corner);
    if (animate) run();
    else this.draw();
  }

  refresh() {
    this.set(this.wanted);
  }

  get animating(): boolean {
    return this.w.animating || this.h.animating || this.ear.animating || this.corner.animating;
  }

  step(dt: number) {
    for (const v of [this.w, this.h, this.ear, this.corner]) v.step(dt);
    this.draw();
  }

  private draw() {
    const size = { w: this.w.value, h: this.h.value, ear: this.ear.value, corner: this.corner.value };
    this.path.setAttribute("d", notchPath(size));
    // Centred on the island's box, as the island is on the screen.
    this.svg.style.left = `${(this.wanted.w - size.w) / 2}px`;
    this.island.style.setProperty("--ear", `${size.ear.toFixed(2)}px`);
  }
}

// ── One loop for every outline, running only while one of them moves ──────────

const notches = new Set<Notch>();
let running = false;
let last = 0;

function run() {
  if (running) return;
  running = true;
  last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    let busy = false;
    for (const n of notches) {
      if (!n.animating) continue;
      n.step(dt);
      busy = busy || n.animating;
    }
    if (busy) requestAnimationFrame(frame);
    else running = false;
  };
  requestAnimationFrame(frame);
}

/** Keeps the page an even number of pixels wide, so what is centred in it lands on whole pixels. */
function snapToPixels() {
  const odd = document.documentElement.clientWidth % 2;
  document.documentElement.style.setProperty("--pv-odd", `${odd}px`);
}
snapToPixels();
// The page's width, not the window's: a scrollbar coming or going changes it too.
new ResizeObserver(snapToPixels).observe(document.documentElement);

// ── The stage: ears on or off, display scaling, a light backdrop ──────────────

let earsOn = true;
let zoom = 1;
const listeners: (() => void)[] = [];

export const earsShown = () => earsOn;
/** The stage's simulated display scaling: what a measured length must be divided by. */
export const stageZoom = () => zoom;
/** Called when ears or scaling change: a page that measures its islands measures again. */
export const onStageChange = (fn: () => void) => { listeners.push(fn); };

/** The controls every preview page offers for the island's outline. */
export function shapeControls(): HTMLElement {
  const ears = h("button", { class: "pv-btn on", text: "ears on" });
  ears.addEventListener("click", () => {
    earsOn = !earsOn;
    ears.textContent = earsOn ? "ears on" : "ears off";
    ears.classList.toggle("on", earsOn);
    for (const n of notches) n.refresh();
    for (const fn of listeners) fn();
  });

  const scale = h("button", { class: "pv-btn", text: "scaling 100%" });
  scale.addEventListener("click", () => {
    zoom = zoom === 1 ? 1.25 : 1;
    scale.textContent = `scaling ${zoom * 100}%`;
    scale.classList.toggle("on", zoom !== 1);
    document.documentElement.style.setProperty("--pv-zoom", String(zoom));
    for (const fn of listeners) fn();
  });

  const light = h("button", { class: "pv-btn", text: "light backdrop" });
  light.addEventListener("click", () => {
    light.classList.toggle("on", document.documentElement.classList.toggle("pv-light"));
  });

  return h("div", { class: "pv-group" }, h("span", { text: "Shape" }), ears, scale, light);
}
