// The folded island, as the Island section shows it: a schematic at the real
// size, with sample sessions and sample numbers.
//
// It is laid out by the island's own arithmetic — core/layout.ts
// `compactLayout` and its COMPACT_* slots — and drawn like island/compact.ts:
// the bot (the real engine), a dot per session, the metric cells picked. What
// it does not share with the island is the strip itself: island/compact.ts
// reads the live State and sits under the island's own canvas, neither of
// which this window has. When that strip can be built from a plan handed to
// it, `islandPreview` is the one place to swap it in: `update(kinds)` is all
// the section calls.

import { Tracked } from "../core/anim";
import {
  COMPACT_BOT_SLOT, COMPACT_DOT, COMPACT_DOT_GAP, COMPACT_METRIC_GAP, COMPACT_PAD, COMPACT_SLOT_GAP,
  EAR_COMPACT, NOTCH_H, ROUNDED_CORNER, botPosition, compactLayout,
} from "../core/layout";
import { usageLevel, type CompactMetric } from "../core/state";
import { clear, h } from "../views/dom";
import { LUCIDE, lucide } from "../views/iconset";
import type { Bot } from "./bots";

/**
 * Each cell as island/compact.ts `METRIC` has it — its fixed width, its name,
 * its icon — with a sample of what it says.
 */
export const COMPACT_CELLS: Record<CompactMetric, { width: number; name: string; icon: string; sample: string }> = {
  cpu: { width: 52, name: "CPU", icon: LUCIDE.cpu, sample: "31%" },
  gpu: { width: 52, name: "GPU", icon: LUCIDE.gpu, sample: "18%" },
  ram: { width: 52, name: "RAM", icon: LUCIDE.memoryStick, sample: "70%" },
  usage5h: { width: 52, name: "5-hour usage", icon: LUCIDE.timer, sample: "38%" },
  usage7d: { width: 52, name: "7-day usage", icon: LUCIDE.calendarDays, sample: "12%" },
  waiting: { width: 38, name: "Sessions waiting", icon: LUCIDE.bell, sample: "1" },
};
/** The size the island draws a cell's icon at. */
const COMPACT_ICON = 14;

/** A cell's icon, at `size`, drawn as the island draws it. */
export const cellIcon = (kind: CompactMetric, size: number) => lucide(COMPACT_CELLS[kind].icon, size);

/** The bot's diameter in the folded island. */
export const COMPACT_BOT = botPosition("compact", "overview", NOTCH_H).diameter;

/** Three sample sessions: one calling for the user, one working, one done. */
const SAMPLE_DOTS: { color: string; calls?: boolean }[] = [{ color: "#FFB547", calls: true }, { color: "#5AA9FF" }, { color: "#4FD69C" }];
/** What the CPU cell goes through, so the preview shows that a number moves and its cell does not. */
const SAMPLE_CPU = ["31%", "34%", "28%", "47%", "39%", "100%", "36%"];

// ── The island's outline: one filled path, ears and all ───────────────────────

/** How far along each edge a bottom corner of radius r runs, and how square its curve is. */
const SMOOTH_REACH = 1.45;
const SMOOTH_HANDLE = 0.2;
/** The outline starts above the screen's edge: nothing can show between the two. */
const ABOVE = 2;

/** The outline, with the island's body at x 0…w, y 0…h and the ears outside it. */
function notchPath(w: number, height: number, ear: number, corner: number): string {
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

export interface IslandPreview {
  el: HTMLElement;
  /** Shows these cells, in this order; the island goes to its new width on its own spring unless `animate` is false. */
  update(kinds: readonly CompactMetric[], animate: boolean): void;
  /** Starts the sample CPU number moving; the returned function stops it. */
  run(): () => void;
}

/** Made once: the bot in it is the one handed over, already mounted. */
export function islandPreview(bot: Bot): IslandPreview {
  const dots = h("div", { class: "sp-ci-dots", style: `gap:${COMPACT_DOT_GAP}px` });
  for (const d of SAMPLE_DOTS) {
    dots.append(h("i", { class: d.calls ? "calls" : "", style: `width:${COMPACT_DOT}px;height:${COMPACT_DOT}px;--c:${d.color}` }));
  }
  const cells = h("div", { class: "sp-ci-metrics", style: `gap:${COMPACT_METRIC_GAP}px` });
  const island = h("div", { class: "sp-ci", style: `height:${NOTCH_H}px;padding:0 ${COMPACT_PAD}px;gap:${COMPACT_SLOT_GAP}px` },
    h("div", { class: "sp-ci-bot", style: `flex-basis:${COMPACT_BOT_SLOT}px` }, bot.el), dots, cells);
  const words = h("span");
  const width = h("span");
  const desk = h("div", { class: "sp-desk", role: "img" }, island);
  const el = h("div", { class: "sp-live" }, desk, h("div", { class: "sp-live-caption" }, words, width));

  const NS = "http://www.w3.org/2000/svg";
  const outline = document.createElementNS(NS, "svg");
  outline.setAttribute("class", "sp-notch");
  outline.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  outline.append(path);
  island.prepend(outline);

  // The island's own motion: the open spring when it grows, the close curve when it shrinks.
  const w = new Tracked(0);
  let wanted = 0;
  let moving = false;
  let last = 0;
  const draw = () => {
    path.setAttribute("d", notchPath(w.value, NOTCH_H, EAR_COMPACT, ROUNDED_CORNER));
    // Centred on the island's box, as the island is on the screen.
    outline.style.left = `${(wanted - w.value) / 2}px`;
  };
  const frame = (now: number) => {
    w.step(Math.min(0.05, (now - last) / 1000));
    last = now;
    draw();
    if (w.animating) requestAnimationFrame(frame);
    else moving = false;
  };

  let shown: string | null = null;
  return {
    el,
    update(kinds, animate) {
      const layout = compactLayout(SAMPLE_DOTS.length, kinds.map((k) => COMPACT_CELLS[k].width));
      const on = kinds.slice(0, layout.metrics);
      if (on.join() !== shown) {
        shown = on.join();
        clear(cells);
        for (const kind of on) {
          const cell = COMPACT_CELLS[kind];
          // A usage cell's number wears its level's colour, as on the island.
          const level = kind === "usage5h" || kind === "usage7d" ? usageLevel(parseInt(cell.sample, 10)) : undefined;
          cells.append(h("span", { class: "sp-ci-metric", style: `width:${cell.width}px`, title: cell.name, "data-id": kind },
            cellIcon(kind, COMPACT_ICON), h("b", { text: cell.sample, "data-level": level })));
        }
      }
      wanted = layout.width;
      island.style.width = `${wanted}px`;
      island.style.marginLeft = `${-Math.round(wanted / 2)}px`;
      if (!animate) w.jump(wanted);
      else if (wanted >= w.value) w.springTo(wanted);
      else w.curveTowards(wanted);
      if (animate && !moving) {
        moving = true;
        last = performance.now();
        requestAnimationFrame(frame);
      }
      draw();
      const names = on.map((k) => COMPACT_CELLS[k].name);
      words.textContent = names.length ? `Bot · sessions · ${names.join(" · ")}` : "Bot · sessions — no metrics, so the island is narrower";
      width.textContent = `${wanted + 2 * EAR_COMPACT} px`;
      desk.setAttribute("aria-label", `Preview of the folded island, with sample values: ${words.textContent}`);
    },
    run() {
      let tick = 0;
      const timer = window.setInterval(() => {
        const cell = cells.querySelector('[data-id="cpu"] b');
        if (cell) cell.textContent = SAMPLE_CPU[++tick % SAMPLE_CPU.length];
      }, 2500);
      return () => window.clearInterval(timer);
    },
  };
}
