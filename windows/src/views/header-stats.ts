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
import { State, ramPercent, ramWords, usageLevel, usageShown } from "../core/state";
import { currentIslandLanguage, formatPercent, tIsland, usageSourceDescription } from "../core/i18n";

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
  const codexFive = item("codex-5h", "Codex 5h", LUCIDE.timer, true);
  const codexSeven = item("codex-7d", "Codex 7d", LUCIDE.calendarDays, true);
  const el = h("div", { class: "hstats" }, h("div", { class: "hs-row" }, cpu.el, gpu.el, ram.el, five.el, seven.el, codexFive.el, codexSeven.el));
  // What each cell was last written for: nothing is touched when that has not changed.
  const keys = new Map<Item, string>();

  function machine(it: Item, name: string, percent: number | null, more = "") {
    const key = `${currentIslandLanguage()}|${percent == null ? "" : Math.round(percent)}|${more}`;
    if (keys.get(it) === key) return;
    keys.set(it, key);
    const known = percent != null;
    it.value.textContent = known ? formatPercent(percent, currentIslandLanguage()) : "—";
    it.value.classList.toggle("blank", !known);
    it.fill.style.width = `${percent ?? 0}%`;
    it.el.dataset.level = known ? usageLevel(percent) : "";
    it.el.title = known ? `${name} ${formatPercent(percent, currentIslandLanguage())}${more ? ` · ${more}` : ""}` : tIsland("island.usage.unknownYet", { label: name });
  }

  function usage(it: Item, name: string, provider: "claude" | "codex", win: ReturnType<typeof usageShown>) {
    const key = win ? `${currentIslandLanguage()}|${win.percent}|${win.state}|${win.countdown}` : "";
    if (keys.get(it) === key) return;
    keys.set(it, key);
    it.el.hidden = !win;
    if (!win) return;
    it.value.textContent = formatPercent(win.percent, currentIslandLanguage());
    it.value.classList.remove("blank");
    it.value.dataset.level = win.state === "reset" ? "" : usageLevel(win.percent);
    it.el.classList.toggle("dim", win.state !== "fresh");
    it.fill.style.width = `${win.percent}%`;
    it.fill.style.setProperty("--used", String(win.percent / 100));
    const source = usageSourceDescription(provider, currentIslandLanguage());
    it.el.title = tIsland("island.usage.used", {
      label: name,
      percent: formatPercent(win.percent, currentIslandLanguage()),
      countdown: win.countdown ? tIsland("island.usage.countdown", { time: win.countdown }) : "",
      source,
    });
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
      usage(five, tIsland("island.metric.claudeUsage5h"), "claude", usageShown(u?.fiveHour, u?.updatedAt ?? now, now, currentIslandLanguage()));
      usage(seven, tIsland("island.metric.claudeUsage7d"), "claude", usageShown(u?.sevenDay, u?.updatedAt ?? now, now, currentIslandLanguage()));
      const codex = State.settings.codexQuotaEnabled ? State.codexQuota : null;
      const codexFresh = codex?.updatedAt != null && now - codex.updatedAt <= 10 * 60_000 && !codex.stale;
      usage(codexFive, tIsland("island.metric.codexUsage5h"), "codex", usageShown(codexFresh ? codex.quotas?.fiveHour : null, codex?.updatedAt ?? now, now, currentIslandLanguage()));
      usage(codexSeven, tIsland("island.metric.codexUsage7d"), "codex", usageShown(codexFresh ? codex.quotas?.sevenDay : null, codex?.updatedAt ?? now, now, currentIslandLanguage()));
    },
  };
}
