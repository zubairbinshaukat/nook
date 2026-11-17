export type UsageAgent = "claude" | "codex";

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
  configure(available: readonly UsageAgent[], enabled: boolean, visible: boolean): void;
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
  let enabled = false;
  let visible = false;
  let timer: number | null = null;
  let destroyed = false;

  const stop = () => {
    if (timer == null) return;
    cancel(timer);
    timer = null;
  };
  const canRotate = () => !destroyed && enabled && visible && available.length === 2;
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
    configure(next, isEnabled, isVisible) {
      if (destroyed) return;
      const normalized = ORDER.filter((candidate) => next.includes(candidate));
      const changedAvailability = normalized.join("|") !== available.join("|");
      const changedGate = isEnabled !== enabled || isVisible !== visible;
      if (changedAvailability || (isEnabled && normalized.length === 1)) {
        stop();
        available = normalized;
        agent = normalized.length === 1 ? normalized[0]! : normalized.includes(agent as UsageAgent) ? agent : normalized[0] ?? null;
      }
      enabled = isEnabled;
      visible = isVisible;
      if (!enabled) agent = "claude";
      if (changedGate && (!enabled || !visible)) stop();
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
