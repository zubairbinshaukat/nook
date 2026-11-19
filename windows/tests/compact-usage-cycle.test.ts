import assert from "node:assert/strict";
import test from "node:test";
import { availableCompactUsageAgents, compactUsageReading, COMPACT_USAGE_ROTATION_MS, createCompactUsageCycle, type CompactUsageShown, type CompactUsageWindow, type UsageAgent } from "../src/island/compact-usage-cycle.ts";

const base = {
  metrics: null,
  waiting: 0,
  now: 50_000,
  usageRotationEnabled: true,
  usage: {
    fiveHour: { usedPercent: 21, resetsAt: 100_000 },
    sevenDay: { usedPercent: 37, resetsAt: 150_000 },
    updatedAt: 49_000,
  },
  codexQuota: {
    generation: 1,
    quotas: {
      fiveHour: { usedPercent: 64, resetsAt: 110_000, windowDurationMins: 300 },
      sevenDay: { usedPercent: 72, resetsAt: 160_000, windowDurationMins: 10080 },
    },
    updatedAt: 49_000,
    stale: false,
    available: true,
    failureReason: null,
  },
};

const show = (win: CompactUsageWindow | null | undefined, updatedAt: number, now: number): CompactUsageShown | null => {
  if (!win) return null;
  if (win.resetsAt > 0 && now >= win.resetsAt) return { percent: 0, state: "reset", countdown: "reset, waiting for new data" };
  const minutes = Math.floor(Math.max(0, win.resetsAt - now) / 60_000);
  const hours = Math.floor(minutes / 60);
  const countdown = win.resetsAt <= 0 ? "" : minutes < 1 ? "resets in <1m" : minutes < 60 ? `resets in ${minutes}m` : hours < 24 ? `resets in ${hours}h ${minutes % 60}m` : `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  return { percent: Math.round(win.usedPercent), state: now - updatedAt > 120_000 ? "old" : "fresh", countdown };
};
const level = (percent: number) => percent > 85 ? "hot" as const : percent >= 60 ? "warm" as const : "calm" as const;
const sourceWords = "Usage only updates while Claude Code runs.";

test("reading selects provider values and labels the displayed source", () => {
  const claude = compactUsageReading("usage5h", base.usage, base.codexQuota, true, "claude", show, level, sourceWords, 50_000);
  const codex = compactUsageReading("usage5h", base.usage, base.codexQuota, true, "codex", show, level, sourceWords, 50_000);
  assert.equal(claude.text, "21%");
  assert.match(claude.more ?? "", /Claude Code/);
  assert.equal(codex.text, "64%");
  assert.match(codex.more ?? "", /Codex/);
});

test("rotation setting disabled preserves the original Claude display", () => {
  const readingValue = compactUsageReading("usage5h", base.usage, base.codexQuota, false, "codex", show, level, sourceWords, 50_000);
  assert.equal(readingValue.text, "21%");
  assert.doesNotMatch(readingValue.more ?? "", /^(Codex|Claude Code) ·/);
});

test("Codex limits disabled gates rotation and provider marks", () => {
  const { cycle, pending } = clock();
  cycle.configure(["claude", "codex"], true, false, true);
  assert.equal(pending.size, 0);
  assert.equal(cycle.current(), "claude");
  const original = compactUsageReading("usage5h", base.usage, base.codexQuota, false, "claude", show, level, sourceWords, 50_000);
  assert.equal(original.text, "21%");
  cycle.destroy();
});

test("provider switching keeps the same metric cells, fixed width, and existing marks", () => {
  const width = 52;
  const cells = ["usage5h", "usage7d"].map((kind) => ({ kind, width, markNode: {} }));
  const before = cells.map((cell) => ({ ...cell }));
  for (const agent of ["claude", "codex"] as const) {
    const values = cells.map((cell) => compactUsageReading(cell.kind as "usage5h" | "usage7d", base.usage, base.codexQuota, true, agent, show, level, sourceWords, 50_000));
    assert.equal(values.length, 2);
  }
  assert.deepEqual(cells, before);
});

test("missing and stale provider readings never appear current", () => {
  const missing = compactUsageReading("usage5h", base.usage, null, true, "codex", show, level, sourceWords, 50_000);
  const stale = compactUsageReading("usage5h", { ...base.usage, updatedAt: 0 }, base.codexQuota, true, "claude", show, level, sourceWords, 50_000);
  assert.equal(missing.text, "—");
  assert.match(missing.more ?? "", /Codex usage unavailable/);
  assert.equal(stale.text, "—");
  assert.match(stale.more ?? "", /Claude Code usage unavailable/);
});

function clock() {
  let nextId = 0;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  const changed: (UsageAgent | null)[] = [];
  const cycle = createCompactUsageCycle(
    (agent) => changed.push(agent),
    (callback, delay) => { const id = ++nextId; pending.set(id, { callback, delay }); return id; },
    (id) => { pending.delete(id); },
  );
  return { cycle, pending, changed };
}

test("rotation is disabled by default and stays off when explicitly disabled", () => {
  const { cycle, pending, changed } = clock();
  cycle.configure(["claude", "codex"], false, true, true);
  assert.equal(cycle.current(), "claude");
  assert.equal(pending.size, 0);
  assert.deepEqual(changed, []);
  cycle.destroy();
});

test("two usable providers alternate at the proposed five-second interval", () => {
  const { cycle, pending, changed } = clock();
  cycle.configure(["claude", "codex"], true, true, true);
  assert.equal(cycle.current(), "claude");
  assert.equal([...pending.values()][0]?.delay, COMPACT_USAGE_ROTATION_MS);
  const first = [...pending.entries()][0]!;
  pending.delete(first[0]);
  first[1].callback();
  assert.equal(cycle.current(), "codex");
  assert.deepEqual(changed, ["codex"]);
  assert.equal([...pending.values()][0]?.delay, 5_000);
  cycle.destroy();
});

test("a sole available provider stays selected and no available providers show no provider", () => {
  const { cycle, pending } = clock();
  cycle.configure(["codex"], true, true, true);
  assert.equal(cycle.current(), "codex");
  assert.equal(pending.size, 0);
  cycle.configure([], true, true, true);
  assert.equal(cycle.current(), null);
  assert.equal(pending.size, 0);
  cycle.destroy();
});

test("provider eligibility excludes stale and reset windows without inventing quota", () => {
  const now = 50_000;
  assert.deepEqual(availableCompactUsageAgents(
    [{ fresh: false, resetsAt: now + 60_000 }],
    [{ fresh: true, resetsAt: now }],
    now,
  ), []);
  assert.deepEqual(availableCompactUsageAgents(
    [{ fresh: true, resetsAt: now + 60_000 }],
    [{ fresh: true, resetsAt: now + 60_000 }],
    now,
  ), ["claude", "codex"]);
});

test("hiding cancels the timer; showing resumes and teardown clears it", () => {
  const { cycle, pending } = clock();
  cycle.configure(["claude", "codex"], true, true, true);
  assert.equal(pending.size, 1);
  cycle.configure(["claude", "codex"], true, true, false);
  assert.equal(pending.size, 0);
  cycle.configure(["claude", "codex"], true, true, true);
  assert.equal(pending.size, 1);
  cycle.destroy();
  assert.equal(pending.size, 0);
  cycle.configure(["claude", "codex"], true, true, true);
  assert.equal(pending.size, 0);
});

test("hover pause restarts a full interval and expanded island remains inactive", () => {
  const { cycle, pending } = clock();
  cycle.configure(["claude", "codex"], true, true, true);
  const first = [...pending.keys()][0]!;
  cycle.configure(["claude", "codex"], true, true, false);
  assert.equal(pending.size, 0);
  cycle.configure(["claude", "codex"], true, true, true);
  assert.notEqual([...pending.keys()][0], first);
  cycle.configure(["claude", "codex"], true, true, false);
  assert.equal(pending.size, 0);
  cycle.destroy();
});

test("provider data changes during rotation cancel or restart only the display timer", () => {
  const { cycle, pending, changed } = clock();
  cycle.configure(["claude", "codex"], true, true, true);
  assert.equal(pending.size, 1);
  cycle.configure(["codex"], true, true, true);
  assert.equal(cycle.current(), "codex");
  assert.equal(pending.size, 0);
  cycle.configure(["claude", "codex"], true, true, true);
  assert.equal(cycle.current(), "codex", "returning data preserves the displayed provider");
  assert.equal(pending.size, 1);
  assert.deepEqual(changed, []);
  cycle.destroy();
});
