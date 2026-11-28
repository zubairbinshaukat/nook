import { currentIslandLanguage, formatPercent, tIsland } from "../core/i18n.ts";

export type UsageAgent = "claude" | "codex";
export type CompactUsageReading = { text: string; more?: string; level?: "calm" | "warm" | "hot"; dim?: boolean };
export type CompactUsageWindow = { usedPercent: number; resetsAt: number };
export type CompactUsageShown = { percent: number; state: "fresh" | "old" | "reset"; countdown: string };

/** Compose the text that is actually assigned to a compact cell's tooltip. */
export function compactCellTooltip(name: string, more: string | undefined, rotationActive: boolean, isUsage: boolean, agent: UsageAgent | null): string {
  if (more) return tIsland("island.metric.tooltipMore", { name, more });
  const provider = rotationActive && isUsage && agent ? agent === "codex" ? "Codex" : "Claude Code" : "";
  return provider ? tIsland("island.metric.tooltipProvider", { name, provider }) : name;
}
export interface CompactUsageReadingOptions {
  kind: "usage5h" | "usage7d";
  usage: { fiveHour: CompactUsageWindow | null; sevenDay: CompactUsageWindow | null; updatedAt: number } | null;
  codexQuota: { quotas: { fiveHour: CompactUsageWindow | null; sevenDay: CompactUsageWindow | null } | null; updatedAt: number | null; stale: boolean; available: boolean } | null | undefined;
  rotationEnabled: boolean;
  codexLimitsEnabled: boolean;
  agent: UsageAgent | null;
  shownUsage: (window: CompactUsageWindow | null | undefined, updatedAt: number, now: number) => CompactUsageShown | null;
  levelFor: (percent: number) => "calm" | "warm" | "hot";
  sourceWords: string;
  now: number;
}

/** Select and label the usage window without consulting UI or island state. */
export function compactUsageReading({ kind, usage, codexQuota, rotationEnabled, codexLimitsEnabled, agent, shownUsage, levelFor, sourceWords, now }: CompactUsageReadingOptions): CompactUsageReading {
  const language = currentIslandLanguage();
  const localizedSourceWords = language === "en" ? sourceWords : tIsland("island.usage.sourceUsage", {}, language);
  const rotationActive = rotationEnabled && codexLimitsEnabled;
  if (rotationActive && !agent) return { text: "—", more: tIsland("island.metric.usageUnavailable"), dim: true };
  const fiveHour = kind === "usage5h";
  const window = rotationActive && agent === "codex"
    ? (fiveHour ? codexQuota?.quotas?.fiveHour : codexQuota?.quotas?.sevenDay)
    : (fiveHour ? usage?.fiveHour : usage?.sevenDay);
  const updatedAt = rotationActive && agent === "codex" ? codexQuota?.updatedAt ?? 0 : usage?.updatedAt ?? 0;
  const shown = shownUsage(window, updatedAt, now);
  if (!shown) return { text: "—", ...(rotationActive ? { more: tIsland("island.metric.providerUsageUnavailable", { provider: agent === "codex" ? "Codex" : "Claude Code" }) } : {}) };
  if (rotationActive && (shown.state !== "fresh" || updatedAt <= 0 || (agent === "codex" && (!codexQuota?.available || codexQuota.stale)))) {
    return { text: "—", more: tIsland("island.metric.providerUsageUnavailable", { provider: agent === "codex" ? "Codex" : "Claude Code" }), dim: true };
  }
  const reset = shown.state === "reset";
  const provider = rotationActive ? `${agent === "codex" ? "Codex" : "Claude Code"}` : "";
  return {
    text: formatPercent(shown.percent, language),
    more: rotationActive
      ? [provider, shown.countdown, agent === "claude" ? localizedSourceWords : ""].filter(Boolean).join(" · ")
      : [shown.countdown, localizedSourceWords].filter(Boolean).join(". "),
    level: reset ? undefined : levelFor(shown.percent),
    dim: shown.state !== "fresh",
  };
}

export const COMPACT_USAGE_ROTATION_MS = 5_000;
const ORDER: readonly UsageAgent[] = ["claude", "codex"];

/** A provider is usable only when it has at least one fresh, unexpired window. */
export function availableCompactUsageAgents(
  claude: readonly { fresh: boolean; resetsAt: number }[],
  codex: readonly { fresh: boolean; resetsAt: number }[],
  now: number,
): UsageAgent[] {
  const hasUsableWindow = (windows: readonly { fresh: boolean; resetsAt: number }[]) =>
    windows.some((window) => window.fresh && (window.resetsAt <= 0 || window.resetsAt > now));
  return [
    ...(hasUsableWindow(claude) ? ["claude" as const] : []),
    ...(hasUsableWindow(codex) ? ["codex" as const] : []),
  ];
}

export interface CompactUsageCycle {
  configure(available: readonly UsageAgent[], rotationEnabled: boolean, codexLimitsEnabled: boolean, active: boolean): void;
  current(): UsageAgent | null;
  destroy(): void;
}

/** A one-shot display timer; it never reads quota data or catches up after hiding. */
export function createCompactUsageCycle(
  changed: (agent: UsageAgent | null) => void,
  schedule: (callback: () => void, delay: number) => number = (callback, delay) => window.setTimeout(callback, delay),
  cancel: (id: number) => void = (id) => window.clearTimeout(id),
): CompactUsageCycle {
  let available: UsageAgent[] = [];
  let agent: UsageAgent | null = "claude";
  let rotationEnabled = false;
  let codexLimitsEnabled = false;
  let active = false;
  let timer: number | null = null;
  let destroyed = false;

  const stop = () => {
    if (timer == null) return;
    cancel(timer);
    timer = null;
  };
  const canRotate = () => !destroyed && rotationEnabled && codexLimitsEnabled && active && available.length === 2;
  const start = () => {
    if (timer != null || !canRotate()) return;
    timer = schedule(() => {
      timer = null;
      if (!canRotate()) return;
      agent = agent === "claude" ? "codex" : "claude";
      changed(agent);
      start();
    }, COMPACT_USAGE_ROTATION_MS);
  };

  return {
    configure(next, isRotationEnabled, areCodexLimitsEnabled, isActive) {
      if (destroyed) return;
      const normalized = ORDER.filter((candidate) => next.includes(candidate));
      const changedAvailability = normalized.join("|") !== available.join("|");
      const changedGate = isRotationEnabled !== rotationEnabled || areCodexLimitsEnabled !== codexLimitsEnabled || isActive !== active;
      if (changedAvailability || ((isRotationEnabled || areCodexLimitsEnabled) && normalized.length === 1)) {
        stop();
        available = normalized;
        agent = normalized.length === 1 ? normalized[0]! : normalized.includes(agent as UsageAgent) ? agent : normalized[0] ?? null;
      }
      rotationEnabled = isRotationEnabled;
      codexLimitsEnabled = areCodexLimitsEnabled;
      active = isActive;
      if (!rotationEnabled || !codexLimitsEnabled) agent = "claude";
      if (changedGate && (!rotationEnabled || !codexLimitsEnabled || !active)) stop();
      start();
    },
    current: () => agent,
    destroy() {
      if (destroyed) return;
      stop();
      destroyed = true;
      available = [];
    },
  };
}
