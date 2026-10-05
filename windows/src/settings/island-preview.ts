// The folded (compact) island, as the Island and Look pages show it: a
// schematic at the real size, with sample sessions and sample numbers, Gullu
// in the colour picked.
//
// It is laid out by the island's own arithmetic — core/layout.ts
// `compactLayout` and its COMPACT_* slots — and drawn like island/compact.ts:
// the bot (the real engine), a dot per session, the metric cells picked — in
// a row, or in a column against the desk's edge for a side dock — and outlined
// by the island's own path (island/notch.ts). What
// it does not share with the island is the strip itself: island/compact.ts
// reads the live State and sits under the island's own canvas, neither of
// which this window has. When that strip can be built from a plan handed to
// it, `islandPreview` is the one place to swap it in: `update(kinds)` is all
// the section calls.

import { Tracked } from "../core/anim";
import {
  COMPACT_BOT_SLOT, COMPACT_CELL_H, COMPACT_COLUMN_W, COMPACT_DOT, COMPACT_DOT_GAP, COMPACT_METRIC_GAP, COMPACT_PAD,
  COMPACT_SLOT_GAP, EAR_COMPACT, NOTCH_H, ROUNDED_CORNER, botPosition, compactLayout, sideDock, type Dock,
} from "../core/layout";
import { notchPath } from "../island/notch";
import { usageLevel, type CompactMetric } from "../core/state";
import { clear, h } from "../views/dom";
import { LUCIDE, lucide } from "../views/iconset";
import type { Bot } from "./bots";

/**
 * Each cell as island/compact.ts `METRIC` has it — its fixed width, its name
 * in plain words and in short, its icon — with a sample of what it says.
 */
export const COMPACT_CELLS: Record<CompactMetric, { width: number; name: string; short: string; icon: string; sample: string }> = {
  cpu: { width: 52, name: "Processor (CPU)", short: "CPU", icon: LUCIDE.cpu, sample: "31%" },
  gpu: { width: 52, name: "Graphics (GPU)", short: "GPU", icon: LUCIDE.gpu, sample: "18%" },
  ram: { width: 52, name: "Memory (RAM)", short: "RAM", icon: LUCIDE.memoryStick, sample: "70%" },
  usage5h: { width: 52, name: "5-hour usage limit", short: "5-hour", icon: LUCIDE.timer, sample: "38%" },
  usage7d: { width: 52, name: "Weekly usage limit", short: "Weekly", icon: LUCIDE.calendarDays, sample: "12%" },
  waiting: { width: 38, name: "Sessions waiting for you", short: "Waiting", icon: LUCIDE.bell, sample: "1" },
};
/** The size the island draws a cell's icon at. */
const COMPACT_ICON = 14;

/** A cell's icon, at `size`, drawn as the island draws it. */
export const cellIcon = (kind: CompactMetric, size: number) => lucide(COMPACT_CELLS[kind].icon, size);

/** The bot's diameter in the folded island. */
export const COMPACT_BOT = botPosition("compact", "overview", NOTCH_H).diameter;

/** Three sample sessions: one calling for the user, one working, one done. */
const SAMPLE_DOTS: { color: string; calls?: boolean }[] = [{ color: "#FFB547", calls: true }, { color: "#5AA9FF" }, { color: "#4FD69C" }];
/** The desk on a side: the column with its three sample dots and three cells, its ears, and air above and below. */
const SIDE_DESK_H = compactLayout(SAMPLE_DOTS.length, [52, 52, 52], "left", Infinity).height + 2 * EAR_COMPACT + 24;
/** What the CPU cell goes through, so the preview shows that a number moves and its cell does not. */
const SAMPLE_CPU = ["31%", "34%", "28%", "47%", "39%", "100%", "36%"];

export interface IslandPreview {
  el: HTMLElement;
  /**
   * Shows these cells, in this order, folded as on this dock: a row hanging
   * from the top or standing on the bottom, a column flush with a side. The
   * island goes to its new length on its own spring unless `animate` is false.
   */
  update(kinds: readonly CompactMetric[], animate: boolean, dock?: Dock): void;
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
  // The slots' sizes, as the island's (style.css `#compact`): settings.css lays them out in a row, or a column on a side.
  const island = h("div", {
    class: "sp-ci",
    style: `--pad:${COMPACT_PAD}px;--slot-gap:${COMPACT_SLOT_GAP}px;--bot-slot:${COMPACT_BOT_SLOT}px;` +
      `--column-w:${COMPACT_COLUMN_W}px;--cell-h:${COMPACT_CELL_H}px`,
  }, h("div", { class: "sp-ci-bot" }, bot.el), dots, cells);
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

  // The island's own motion along its edge: the open spring when it grows, the close curve when it shrinks.
  const w = new Tracked(0);
  let wanted = 0;
  let moving = false;
  let last = 0;
  /** The dock it is drawn for; only a side's differs from the top. */
  let side: Dock | null = null;
  let drawnFor: Dock | null | undefined;
  const draw = () => {
    // The island's own outline (island/notch.ts), turned for a side as the island's is.
    path.setAttribute("d", side
      ? notchPath({ w: COMPACT_COLUMN_W, h: w.value, ear: EAR_COMPACT, corner: ROUNDED_CORNER, dock: side })
      : notchPath({ w: w.value, h: NOTCH_H, ear: EAR_COMPACT, corner: ROUNDED_CORNER }));
    // Centred on the island's box along its edge, as the island is on the screen.
    outline.style.left = side ? "" : `${(wanted - w.value) / 2}px`;
    outline.style.top = side ? `${(wanted - w.value) / 2}px` : "";
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
    update(kinds, animate, dock = "top") {
      side = sideDock(dock) ? dock : null;
      // Another dock: the island is drawn at once in its new shape, not sprung from the old one.
      if (side !== drawnFor) {
        drawnFor = side;
        animate = false;
        desk.dataset.dock = side ?? "";
        el.classList.toggle("side", side != null);
        // Tall enough for the longest column the samples make, whatever is picked: the page does not jump as cells come and go.
        desk.style.height = side ? `${SIDE_DESK_H}px` : "";
      }
      const layout = compactLayout(SAMPLE_DOTS.length, kinds.map((k) => COMPACT_CELLS[k].width), side ?? "top");
      const on = kinds.slice(0, layout.metrics);
      if (on.join() !== shown) {
        shown = on.join();
        clear(cells);
        for (const kind of on) {
          const cell = COMPACT_CELLS[kind];
          // A usage cell's number wears its level's colour, as on the island.
          const level = kind === "usage5h" || kind === "usage7d" ? usageLevel(parseInt(cell.sample, 10)) : undefined;
          cells.append(h("span", { class: "sp-ci-metric", style: `--w:${cell.width}px`, title: cell.name, "data-id": kind },
            cellIcon(kind, COMPACT_ICON), h("b", { text: cell.sample, "data-level": level })));
        }
      }
      wanted = side ? layout.height : layout.width;
      island.style.width = side ? "" : `${wanted}px`;
      island.style.marginLeft = side ? "" : `${-Math.round(wanted / 2)}px`;
      island.style.height = side ? `${wanted}px` : "";
      island.style.marginTop = side ? `${-Math.round(wanted / 2)}px` : "";
      if (!animate) w.jump(wanted);
      else if (wanted >= w.value) w.springTo(wanted);
      else w.curveTowards(wanted);
      if (animate && !moving) {
        moving = true;
        last = performance.now();
        requestAnimationFrame(frame);
      }
      draw();
      const names = on.map((k) => COMPACT_CELLS[k].short);
      words.textContent = names.length ? `Gullu · sessions · ${names.join(" · ")}` : "Gullu · sessions — no numbers, so the island is narrower";
      // Its length along the edge, ears included; on a side, the column's width beside it.
      width.textContent = side ? `${COMPACT_COLUMN_W} × ${wanted + 2 * EAR_COMPACT} px` : `${wanted + 2 * EAR_COMPACT} px`;
      desk.setAttribute("aria-label", `Preview of the compact island, with sample values: ${on.map((k) => COMPACT_CELLS[k].name).join(", ") || "no numbers"}`);
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
