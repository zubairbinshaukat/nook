// The folded island (plans/design-plan.md §2): fixed slots, left to right —
// the bot, which speaks for the most urgent session; a dot per session, most
// urgent first; up to three metric cells picked in Settings. Each slot has its
// own width, an empty one goes with its gap, and what does not fit under the
// cap folds away: the last metric first, then dots into "+N". On a side the
// same slots stand top to bottom in a column (style.css, layout.ts
// `compactLayout`); nothing here differs.
//
// The bot is not drawn here: island.ts places its canvas over the first slot.
// A cell's number is written when a sample comes (State.onGauges) and at no
// other time: nothing here runs a frame.

import {
  COMPACT_BOT_SLOT, COMPACT_CELL_H, COMPACT_COLUMN_W, COMPACT_DOT, COMPACT_DOT_GAP, COMPACT_METRIC_GAP, COMPACT_MORE_W,
  COMPACT_PAD, COMPACT_SLOT_GAP, compactLayout, type CompactLayout,
} from "../core/layout";
import {
  State, USAGE_SOURCE_WORDS, compactMetrics, ramPercent, ramWords, usageLevel, usageShown,
  type CompactMetric, type Metrics, type Usage, type UsageLevel,
} from "../core/state";
import { clear, h } from "../views/dom";
import { LUCIDE, lucide } from "../views/iconset";
import { wear } from "../views/palette";
import { DOT_LEGEND, TOOL_NAME } from "../views/tool";
import { labelText, roster, stateWords, waitingCount, type Entry } from "../views/roster";

/** A cell's icon, and its number's size: the icons of the set, on their 24 px grid. */
const COMPACT_ICON = 14;
/** A cell that says a percentage is wide enough for "100%"; the count of sessions waiting, for "99". */
const PERCENT_W = 52;

/** Each cell, wide enough for the worst it can say. */
const METRIC: Record<CompactMetric, { width: number; name: string; icon: string }> = {
  cpu: { width: PERCENT_W, name: "CPU", icon: LUCIDE.cpu },
  gpu: { width: PERCENT_W, name: "GPU", icon: LUCIDE.gpu },
  ram: { width: PERCENT_W, name: "RAM", icon: LUCIDE.memoryStick },
  usage5h: { width: PERCENT_W, name: "5-hour usage", icon: LUCIDE.timer },
  usage7d: { width: PERCENT_W, name: "7-day usage", icon: LUCIDE.calendarDays },
  waiting: { width: 38, name: "Sessions waiting for you", icon: LUCIDE.bell },
};

/** A cell as it reads now: its number, what its tooltip adds, and — for usage — how it is coloured. */
export interface Reading {
  /** "—" where nothing is known yet, in the same cell. */
  text: string;
  more?: string;
  level?: UsageLevel;
  /** A usage window that has reset, or a number more than two hours old: drawn dimmed. */
  dim?: boolean;
}

/** What the cells are read from: the machine's last sample, Claude's usage, and how many sessions wait. */
export interface Gauges {
  metrics: Metrics | null;
  usage: Usage | null;
  waiting: number;
  /** The time the usage is read at (Unix ms): now, when not said. */
  now?: number;
}

const percent = (value: number | null | undefined): string => (value != null ? `${Math.round(value)}%` : "—");

/** What one cell says, from the gauges alone: nothing here looks at the island. */
export function reading(kind: CompactMetric, { metrics: m, usage, waiting, now = Date.now() }: Gauges): Reading {
  switch (kind) {
    case "cpu":
      return { text: percent(m?.cpu) };
    case "gpu":
      return { text: percent(m?.gpu) };
    case "ram":
      // The share in use; how many gigabytes that is stays in the tooltip.
      return { text: percent(ramPercent(m)), more: ramWords(m) };
    case "usage5h":
    case "usage7d": {
      const shown = usageShown(kind === "usage5h" ? usage?.fiveHour : usage?.sevenDay, usage?.updatedAt ?? now, now);
      if (!shown) return { text: "—" };
      // Past its reset the old number is not shown: 0 %, dimmed, and the tooltip says why.
      const reset = shown.state === "reset";
      return {
        text: `${shown.percent}%`,
        more: [shown.countdown, USAGE_SOURCE_WORDS].filter(Boolean).join(". "),
        level: reset ? undefined : usageLevel(shown.percent),
        dim: shown.state !== "fresh",
      };
    }
    case "waiting":
      return { text: String(Math.min(99, waiting)) };
  }
}

const gauges = (): Gauges => ({ metrics: State.metrics, usage: State.usage, waiting: waitingCount() });

/** A session's dot, as it is drawn. */
export interface SlotDot {
  id: string;
  color: string;
  /** It asks for the user: it pulses. */
  calls: boolean;
  /** At rest. */
  rest: boolean;
  /** Its last reply waits on a decision. */
  decision: boolean;
  /** A Cursor session: its dot has a hole, where Claude Code's is solid. */
  cursor: boolean;
  title: string;
}

/** A metric cell, as it is drawn. */
export interface SlotCell extends Reading {
  kind: CompactMetric;
  title: string;
}

/** Everything the folded island shows beside its bot. */
export interface CompactSlots {
  dots: SlotDot[];
  /** "+N": the sessions with no dot of their own, in the colour of the most urgent of them. */
  more: { count: number; color: string; calls: boolean } | null;
  cells: SlotCell[];
}

/**
 * What the folded island shows, as a plain function of what it is given: the
 * plan (who is on the island, which cells were picked, what fits) and the
 * gauges. It is what `sync` draws — on any change of state, and at once when
 * the island comes back from hidden — and what the wake self-check reads
 * (dev/preview-b/island-check.ts).
 */
export function compactSlots(plan: CompactPlan, from: Gauges): CompactSlots {
  const shown = plan.live.slice(0, plan.dots);
  const hidden = plan.live.slice(plan.dots);
  return {
    dots: shown.map((entry) => ({
      id: entry.id, color: entry.color, calls: entry.rank === 0, rest: entry.lane === "done",
      decision: entry.decision && entry.lane === "done",
      cursor: entry.session?.agent === "cursor",
      title: `${entry.session ? `${TOOL_NAME[entry.session.agent]} · ` : ""}${labelText(entry)} — ${stateWords(entry)}${plan.live.some((e) => e.session?.agent === "cursor") ? `\n${DOT_LEGEND}` : ""}`,
    })),
    more: hidden.length ? { count: hidden.length, color: hidden[0].color, calls: hidden[0].rank === 0 } : null,
    cells: plan.kinds.map((kind) => {
      const read = reading(kind, from);
      return { kind, ...read, title: read.more ? `${METRIC[kind].name} — ${read.more}` : METRIC[kind].name };
    }),
  };
}

export interface CompactPlan extends CompactLayout {
  /** Everything with a place, most urgent first: the first `dots` are on show. */
  live: Entry[];
  kinds: CompactMetric[];
}

/** What the folded island holds now, and how wide that makes it. */
export function compactPlan(): CompactPlan {
  const { live } = roster();
  const kinds = compactMetrics(State.settings);
  const layout = compactLayout(live.length, kinds.map((k) => METRIC[k].width));
  return { ...layout, live, kinds: kinds.slice(0, layout.metrics) };
}

export interface CompactStrip {
  el: HTMLElement;
  /** Draws what the plan holds; nothing is rebuilt when it has not changed. */
  sync(plan: CompactPlan): void;
  /**
   * Builds every slot again, changed or not. The island comes back from hidden
   * in a window that is still the 6 px wake strip, and what was painted of the
   * slots then is what stays once the window has grown: nothing else writes to
   * them. New elements are painted in the window as it is.
   */
  redraw(plan: CompactPlan): void;
}

export function buildCompact(): CompactStrip {
  const dots = h("div", { class: "ci-dots", style: `gap:${COMPACT_DOT_GAP}px` });
  const metrics = h("div", { class: "ci-metrics", style: `gap:${COMPACT_METRIC_GAP}px` });
  // The slots' sizes, from layout.ts: style.css lays them out in a row, or in a
  // column on a side, from the same numbers — the dock can change under them.
  const el = h(
    "div",
    {
      id: "compact",
      style: `--pad:${COMPACT_PAD}px;--slot-gap:${COMPACT_SLOT_GAP}px;--bot-slot:${COMPACT_BOT_SLOT}px;` +
        `--column-w:${COMPACT_COLUMN_W}px;--cell-h:${COMPACT_CELL_H}px`,
    },
    // The bot's slot: empty, the island's own canvas sits over it.
    h("div", { class: "ci-bot" }),
    dots,
    metrics,
  );

  let dotsKey = "";
  let metricsKey = "";
  /** The number of each cell on show, by its kind. */
  const values = new Map<CompactMetric, HTMLElement>();

  function writeValues() {
    const from = gauges();
    for (const [kind, value] of values) {
      const { text, more, level, dim } = reading(kind, from);
      const title = more ? `${METRIC[kind].name} — ${more}` : METRIC[kind].name;
      const cell = value.parentElement!;
      if (cell.title !== title) cell.title = title;
      if (value.dataset.level !== (level ?? "")) value.dataset.level = level ?? "";
      value.classList.toggle("dim", dim === true);
      if (value.textContent === text) continue;
      value.textContent = text;
      value.classList.toggle("blank", text === "—");
    }
  }

  // A sample of the machine, or new usage: only the numbers change.
  State.onGauges(writeValues);

  return {
    el,
    sync(plan) {
      const slots = compactSlots(plan, gauges());
      const more = slots.more;
      const nextDots = `${slots.dots.map((d) => `${d.id}:${d.color}:${d.calls}:${d.rest}:${d.decision}:${d.cursor}:${d.title}`).join("|")}#${more ? `${more.count}:${more.color}:${more.calls}` : ""}`;
      if (nextDots !== dotsKey) {
        dotsKey = nextDots;
        clear(dots);
        dots.hidden = plan.live.length === 0;
        for (const dot of slots.dots) {
          dots.append(h("i", {
            class: `ci-dot${dot.calls ? " calls" : ""}${dot.rest ? " rest" : ""}${dot.decision ? " decide" : ""}${dot.cursor ? " cursor" : ""}`,
            style: `width:${COMPACT_DOT}px;height:${COMPACT_DOT}px;--c:${dot.color}`,
            title: dot.title,
          }));
        }
        if (more) {
          // "+N" wears the colour of the most urgent session it hides.
          const badge = h("span", {
            class: `ci-more${more.calls ? " calls" : ""}`, style: `width:${COMPACT_MORE_W}px`,
            text: `+${Math.min(99, more.count)}`, title: `${more.count} more`,
          });
          wear(badge, more.color);
          dots.append(badge);
        }
      }

      const nextMetrics = plan.kinds.join("|");
      if (nextMetrics !== metricsKey) {
        metricsKey = nextMetrics;
        clear(metrics);
        values.clear();
        metrics.hidden = plan.kinds.length === 0;
        for (const kind of plan.kinds) {
          const def = METRIC[kind];
          const value = h("b");
          values.set(kind, value);
          metrics.append(h(
            "span", { class: "ci-metric", style: `--w:${def.width}px`, title: def.name },
            lucide(def.icon, COMPACT_ICON),
            value,
          ));
        }
      }
      // Sessions waiting is not a sample: it follows the state.
      writeValues();
    },
    redraw(plan) {
      dotsKey = "\0";
      metricsKey = "\0";
      this.sync(plan);
    },
  };
}
