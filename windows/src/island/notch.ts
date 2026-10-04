// The island's outline: one filled SVG path — concave "ears" flaring into the
// top edge of the screen, and squircle-like bottom corners.
//
// One path, not a body plus two ears: there is no seam for a hairline to show
// through, and a vector edge stays crisp at any display scaling. The island
// (island.ts) drives its width, height, ear and corner on its own spring, and
// draws it again only when one of them has moved.

/** How far along each edge a bottom corner of radius r runs, and how square its curve is. */
const SMOOTH_REACH = 1.45;
const SMOOTH_HANDLE = 0.2;
/** The outline starts above the screen's edge: nothing can show between the two. */
const ABOVE = 2;

export interface NotchSize {
  w: number;
  h: number;
  ear: number;
  corner: number;
}

/**
 * The outline, with the island's body at x 0…w, y 0…h and the ears outside it.
 * A corner is one cubic that leaves each edge with no curvature and passes
 * where a circle of radius `corner` would: a superellipse to the eye. An ear is
 * never taller than the island: retracted, there is nothing left of it.
 */
export function notchPath({ w, h: height, ear, corner }: NotchSize): string {
  const e = Math.max(0, Math.min(ear, height));
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

export interface NotchShape {
  el: SVGSVGElement;
  /** Draws the outline at this size; nothing is touched when it has not changed. */
  draw(size: NotchSize): void;
}

/** The element that draws the outline: it goes first in the island, under everything else. */
export function createNotch(): NotchShape {
  const NS = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("id", "island-shape");
  el.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  el.append(path);
  let drawn = "";
  return {
    el,
    draw(size) {
      const d = notchPath(size);
      if (d === drawn) return;
      drawn = d;
      path.setAttribute("d", d);
    },
  };
}
