import assert from "node:assert/strict";
import test from "node:test";
import { availableCompactUsageAgents, COMPACT_USAGE_ROTATION_MS, createCompactUsageCycle, type UsageAgent } from "../src/island/compact-usage-cycle.ts";

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
  cycle.configure(["claude", "codex"], false, true);
  assert.equal(cycle.current(), "claude");
  assert.equal(pending.size, 0);
  assert.deepEqual(changed, []);
  cycle.destroy();
});

test("two usable providers alternate at the proposed five-second interval", () => {
  const { cycle, pending, changed } = clock();
  cycle.configure(["claude", "codex"], true, true);
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
  cycle.configure(["codex"], true, true);
  assert.equal(cycle.current(), "codex");
  assert.equal(pending.size, 0);
  cycle.configure([], true, true);
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
  cycle.configure(["claude", "codex"], true, true);
  assert.equal(pending.size, 1);
  cycle.configure(["claude", "codex"], true, false);
  assert.equal(pending.size, 0);
  cycle.configure(["claude", "codex"], true, true);
  assert.equal(pending.size, 1);
  cycle.destroy();
  assert.equal(pending.size, 0);
  cycle.configure(["claude", "codex"], true, true);
  assert.equal(pending.size, 0);
});

test("provider data changes during rotation cancel or restart only the display timer", () => {
  const { cycle, pending, changed } = clock();
  cycle.configure(["claude", "codex"], true, true);
  assert.equal(pending.size, 1);
  cycle.configure(["codex"], true, true);
  assert.equal(cycle.current(), "codex");
  assert.equal(pending.size, 0);
  cycle.configure(["claude", "codex"], true, true);
  assert.equal(cycle.current(), "codex", "returning data preserves the displayed provider");
  assert.equal(pending.size, 1);
  assert.deepEqual(changed, []);
  cycle.destroy();
});
