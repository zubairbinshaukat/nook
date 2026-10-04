// The header's strip of numbers: the machine (CPU, GPU, RAM) and Claude's two
// usage windows, as small labelled bars. It reads what the home view's
// resources column reads (State.metrics, State.usage and the helpers beside
// them in core/state.ts), and is written only when a sample or a usage comes
// — nothing here animates by itself, so nothing is drawn while the island is
// hidden. How much of it shows depends on the width it is given (style.css
// `.hstats` container queries): 7 d goes first, then GPU, then the labels
// become icons, then the bars.

import { h } from "./dom";
import { LUCIDE, lucide } from "./iconset";
import { State, USAGE_SOURCE_WORDS, ramPercent, ramWords, usageLevel, usageShown } from "../core/state";

const ICON = 11;

interface Item {
  el: HTMLElement;
  value: HTMLElement;
  fill: HTMLElement;
}

function item(key: string, label: string, icon: string, usage: boolean): Item {
  const value = h("span", { class: "res-value hs-value blank", text: "—" });
  const fill = h("i");
  const el = h(
    "div", { class: `hs hs-${key}${usage ? " hs-usage" : ""}` },
    h("b", { class: "hs-label", text: label }),
    h("span", { class: "hs-icon" }, lucide(icon, ICON, 1.75)),
    h("div", { class: "res-bar hs-bar" }, fill),
    value,
  );
  return { el, value, fill };
}

export function buildHeaderStats(): { el: HTMLElement; draw(): void } {
  const cpu = item("cpu", "CPU", LUCIDE.cpu, false);
  const gpu = item("gpu", "GPU", LUCIDE.gpu, false);
  const ram = item("ram", "RAM", LUCIDE.memoryStick, false);
  const five = item("5h", "5h", LUCIDE.timer, true);
  const seven = item("7d", "7d", LUCIDE.calendarDays, true);
  const el = h("div", { class: "hstats" }, h("div", { class: "hs-row" }, cpu.el, gpu.el, ram.el, five.el, seven.el));
  // What each cell was last written for: nothing is touched when that has not changed.
  const keys = new Map<Item, string>();

  function machine(it: Item, name: string, percent: number | null, more = "") {
    const key = `${percent == null ? "" : Math.round(percent)}|${more}`;
    if (keys.get(it) === key) return;
    keys.set(it, key);
    const known = percent != null;
    it.value.textContent = known ? `${Math.round(percent)}%` : "—";
    it.value.classList.toggle("blank", !known);
    it.fill.style.width = `${percent ?? 0}%`;
    it.el.dataset.level = known ? usageLevel(percent) : "";
    it.el.title = known ? `${name} ${Math.round(percent)}%${more ? ` · ${more}` : ""}` : `${name}: not known yet`;
  }

  function usage(it: Item, name: string, win: ReturnType<typeof usageShown>) {
    const key = win ? `${win.percent}|${win.state}|${win.countdown}` : "";
    if (keys.get(it) === key) return;
    keys.set(it, key);
    it.el.hidden = !win;
    if (!win) return;
    it.value.textContent = `${win.percent}%`;
    it.value.classList.remove("blank");
    it.value.dataset.level = win.state === "reset" ? "" : usageLevel(win.percent);
    it.el.classList.toggle("dim", win.state !== "fresh");
    it.fill.style.width = `${win.percent}%`;
    it.fill.style.setProperty("--used", String(win.percent / 100));
    it.el.title = `${name}: ${win.percent}% used${win.countdown ? ` · ${win.countdown}` : ""}. ${USAGE_SOURCE_WORDS}`;
  }

  return {
    el,
    draw() {
      const m = State.metrics;
      machine(cpu, "CPU", m?.cpu ?? null);
      machine(gpu, "GPU", m?.gpu ?? null);
      machine(ram, "RAM", ramPercent(m), ramWords(m));
      const now = Date.now();
      const u = State.usage;
      usage(five, "Claude usage, 5 hours", usageShown(u?.fiveHour, u?.updatedAt ?? now, now));
      usage(seven, "Claude usage, 7 days", usageShown(u?.sevenDay, u?.updatedAt ?? now, now));
    },
  };
}
