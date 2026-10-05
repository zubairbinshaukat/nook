// The island's outline: one filled SVG path — concave "ears" flaring into the
// edge of the screen it is docked to, and squircle-like corners on the side
// away from it.
//
// One path, not a body plus two ears: there is no seam for a hairline to show
// through, and a vector edge stays crisp at any display scaling. The island
// (island.ts) drives its width, height, ear and corner on its own spring, and
// draws it again only when one of them has moved.

import type { Dock } from "../core/layout";

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
  /** Upside down, for an island standing on the bottom edge: the ears flare into the lower one. */
  flip?: boolean;
  /**
   * The edge the island is docked to; the top when not said. The bottom is
   * the same as `flip`. On a side the outline is the top one turned so that
   * its flat edge is the screen's side: the ears flare into it above and below
   * the island, and the round corners are on the side away from it.
   */
  dock?: Dock;
}

/**
 * The outline, with the island's body at x 0…w, y 0…h and the ears outside it.
 * A corner is one cubic that leaves each edge with no curvature and passes
 * where a circle of radius `corner` would: a superellipse to the eye. An ear is
 * never taller than the island: retracted, there is nothing left of it.
 *
 * It is worked out once, as for the top edge, in a frame of its own: `u` along
 * the screen's edge, `v` away from it, the body `along` × `depth`. Each point
 * is then put where the dock has it — mirrored for the bottom, turned for a
 * side — and an arc's sweep follows: a mirror (bottom), or a turn that is one
 * (left: `u` and `v` swap), draws it the other way round.
 */
export function notchPath({ w, h, ear, corner, flip = false, dock = flip ? "bottom" : "top" }: NotchSize): string {
  const side = dock === "left" || dock === "right";
  // The body in the outline's own frame: along the edge, and away from it.
  const along = side ? h : w;
  const height = side ? w : h;
  const e = Math.max(0, Math.min(ear, height));
  const reach = Math.max(0, Math.min(corner * SMOOTH_REACH, along / 2, height - e));
  const k = reach * SMOOTH_HANDLE;
  const n = (v: number) => Number(v.toFixed(3));
  // From the outline's frame (u along, v away) to the island's (x, y).
  const at = (u: number, v: number): [number, number] => {
    switch (dock) {
      case "bottom":
        return [u, height - v];
      case "left":
        return [v, u];
      case "right":
        return [height - v, u];
      default:
        return [u, v];
    }
  };
  const xy = (u: number, v: number) => at(u, v).map(n).join(" ");
  // A line straight away from the edge (`v` changes), and one along it (`u` changes):
  // upright or level on the screen, whichever the dock makes it.
  const away = (u: number, v: number) => (side ? `H${n(at(u, v)[0])}` : `V${n(at(u, v)[1])}`);
  const level = (u: number, v: number) => (side ? `V${n(at(u, v)[1])}` : `H${n(at(u, v)[0])}`);
  const sweep = dock === "bottom" || dock === "left" ? 0 : 1;
  const arc = (u: number, v: number) => `A${n(e)} ${n(e)} 0 0 ${sweep} ${xy(u, v)}`;
  return [
    `M${xy(-e, -ABOVE)}${away(-e, 0)}`,
    arc(0, e),
    away(0, height - reach),
    `C${xy(0, height - k)} ${xy(k, height)} ${xy(reach, height)}`,
    level(along - reach, height),
    `C${xy(along - k, height)} ${xy(along, height - k)} ${xy(along, height - reach)}`,
    away(along, e),
    arc(along + e, 0),
    `${away(along + e, -ABOVE)}Z`,
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
