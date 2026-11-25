import assert from "node:assert/strict";
import test from "node:test";
import {
  batteryReading, batteryRingLevel, BATTERY_CELL_GAP, BATTERY_CELL_WIDTH, BATTERY_PERCENT_WIDTH,
  BATTERY_POLL_MS, BATTERY_RING_CIRCUMFERENCE, BATTERY_RING_SIZE, BATTERY_SIDE_CELL_GAP,
  BATTERY_SIDE_PERCENT_WIDTH, BATTERY_SIDE_RING_SIZE, BATTERY_SIDE_CELL_WIDTH, createCompactBatteryPoller,
} from "../src/island/compact-battery.ts";
import { COMPACT_METRICS, compactMetrics, DEFAULT_SETTINGS, MAX_COMPACT_METRICS } from "../src/core/state.ts";
import { COMPACT_BOT_SLOT, COMPACT_CELL_H, COMPACT_METRIC_GAP, COMPACT_PAD, COMPACT_SLOT_GAP, compactLayout } from "../src/core/layout.ts";
import { createCompactClock } from "../src/island/compact-clock.ts";
import type { BatteryStatus } from "../src/core/bridge.ts";

test("battery is off by default, selectable with clock, and stays within the three-cell cap", () => {
  assert.equal(COMPACT_METRICS.includes("battery"), true);
  assert.equal(compactMetrics(DEFAULT_SETTINGS).includes("battery"), false);
  assert.deepEqual(compactMetrics({ compactMetrics: ["clock", "battery"] }), ["clock", "battery"]);
  const capped = compactMetrics({ compactMetrics: ["clock", "battery", "waiting", "cpu"] });
  assert.deepEqual(capped, ["clock", "battery", "waiting"]);
  assert.equal(capped.length, MAX_COMPACT_METRICS);
});

test("battery percentage and color boundaries cover the full supported range", () => {
  const cases = [
    { percent: 0, progress: 0, level: "red" },
    { percent: 1, progress: 1, level: "red" },
    { percent: 19, progress: 19, level: "red" },
    { percent: 20, progress: 20, level: "amber" },
    { percent: 49, progress: 49, level: "amber" },
    { percent: 50, progress: 50, level: "green" },
    { percent: 99, progress: 99, level: "green" },
    { percent: 100, progress: 100, level: "green" },
  ] as const;
  for (const sample of cases) {
    const reading = batteryReading({ percent: sample.percent, acConnected: false, charging: false, batteryPresent: true });
    assert.equal(reading.text, `${sample.percent}%`);
    assert.equal(reading.progress, sample.progress);
    assert.equal(reading.level, sample.level);
    assert.equal(reading.showProgress, sample.percent > 0);
    assert.ok(Math.abs(reading.dashOffset - BATTERY_RING_CIRCUMFERENCE * (1 - sample.progress / 100)) < 1e-9);
  }
  assert.equal(batteryReading({ percent: 0, acConnected: false, charging: false, batteryPresent: true }).dashOffset, BATTERY_RING_CIRCUMFERENCE);
  assert.equal(batteryReading({ percent: 100, acConnected: false, charging: false, batteryPresent: true }).dashOffset, 0);
  assert.equal(batteryRingLevel(null), "unknown");
  assert.equal(batteryRingLevel(101), "unknown");
});

test("charging bolt requires confirmed charging and does not infer from AC", () => {
  const charging = batteryReading({ percent: 78, acConnected: true, charging: true, batteryPresent: true });
  assert.equal(charging.text, "78%");
  assert.equal(charging.showBolt, true);
  assert.equal(charging.accessible, "Battery: 78%, charging");
  assert.equal(batteryReading({ percent: 78, acConnected: true, charging: false, batteryPresent: true }).showBolt, false);
  assert.equal(batteryReading({ percent: 78, acConnected: true, charging: null, batteryPresent: true }).showBolt, false);
});

test("unknown and absent battery data remain unavailable rather than zero", () => {
  const unknown = batteryReading(null);
  assert.equal(unknown.text, "—");
  assert.equal(unknown.percent, null);
  assert.equal(unknown.progress, 0);
  assert.equal(unknown.showProgress, false);
  assert.equal(unknown.level, "unknown");
  assert.equal(unknown.showBolt, false);
  assert.equal(unknown.accessible, "Battery status unavailable");
  assert.equal(batteryReading({ percent: 42, acConnected: null, charging: null, batteryPresent: null }).percent, null);
  assert.equal(batteryReading({ percent: 80, acConnected: true, charging: false, batteryPresent: false }).more, "No battery detected");
  const missingPercent = batteryReading({ percent: null, acConnected: null, charging: null, batteryPresent: true });
  assert.equal(missingPercent.text, "—");
  assert.equal(missingPercent.level, "unknown");
  assert.equal(batteryReading({ percent: 120, acConnected: null, charging: true, batteryPresent: true }).showBolt, false);
});

test("clock and battery participate in horizontal and side slot planning", () => {
  // The existing clock cell is icon + gap + its longest supported label.
  const compactClockWidth = 14 + 5 + 68;
  assert.equal(BATTERY_CELL_WIDTH, BATTERY_RING_SIZE + BATTERY_CELL_GAP + BATTERY_PERCENT_WIDTH);
  assert.equal(BATTERY_CELL_WIDTH, 67);
  const horizontal = compactLayout(0, [compactClockWidth, BATTERY_CELL_WIDTH], "top");
  const side = compactLayout(0, [compactClockWidth, BATTERY_SIDE_CELL_WIDTH], "left");
  assert.ok(horizontal.width > compactLayout(0, [compactClockWidth], "top").width);
  assert.equal(BATTERY_SIDE_RING_SIZE + BATTERY_SIDE_CELL_GAP + BATTERY_SIDE_PERCENT_WIDTH, 46);
  assert.equal(BATTERY_SIDE_CELL_WIDTH, 46);
  assert.equal(side.height, COMPACT_CELL_H * 2 + COMPACT_METRIC_GAP + COMPACT_BOT_SLOT + COMPACT_SLOT_GAP + 2 * COMPACT_PAD);
  assert.equal(side.width, 46);
  // These assertions cover logical slot planning only. Browser/runtime text fit is verified separately.
});

function pollerHarness(read: () => Promise<BatteryStatus | null>) {
  let nextId = 0;
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  const updates: (BatteryStatus | null)[] = [];
  const poller = createCompactBatteryPoller(
    read,
    (status) => updates.push(status),
    (callback, delay) => { const id = ++nextId; tasks.set(id, { callback, delay }); return id; },
    (id) => { tasks.delete(id); },
  );
  const fireTimer = () => {
    const first = tasks.entries().next().value as [number, { callback: () => void; delay: number }] | undefined;
    assert.ok(first);
    tasks.delete(first[0]);
    first[1].callback();
  };
  return { poller, tasks, updates, fireTimer };
}

const flushPoll = async () => { await Promise.resolve(); await Promise.resolve(); };
const sample = (percent: number): BatteryStatus => ({ percent, acConnected: false, charging: false, batteryPresent: true });

test("initial fetch rejection leaves unavailable state and schedules a minute retry", async () => {
  let calls = 0;
  const harness = pollerHarness(async () => { calls++; throw new Error("read failed"); });
  harness.poller.configure(true);
  harness.poller.activate(true);
  await flushPoll();
  assert.equal(calls, 1);
  assert.equal(harness.poller.latest, null);
  assert.deepEqual(harness.updates, []);
  assert.equal(harness.tasks.size, 1);
  assert.equal([...harness.tasks.values()][0]?.delay, BATTERY_POLL_MS);
});

test("later fetch rejection preserves the last successful status and retries", async () => {
  let calls = 0;
  const harness = pollerHarness(async () => {
    calls++;
    if (calls === 2) throw new Error("temporary failure");
    return sample(57);
  });
  harness.poller.configure(true);
  harness.poller.activate(true);
  await flushPoll();
  assert.deepEqual(harness.poller.latest, sample(57));
  harness.fireTimer();
  await flushPoll();
  assert.deepEqual(harness.poller.latest, sample(57));
  assert.deepEqual(harness.updates, [sample(57)]);
  assert.equal(harness.tasks.size, 1);
  assert.equal([...harness.tasks.values()][0]?.delay, BATTERY_POLL_MS);
});

test("null invocation failure preserves the cache, retries, and accepts the later reading", async () => {
  let calls = 0;
  const harness = pollerHarness(async () => {
    calls++;
    if (calls === 2) return null;
    return sample(calls === 1 ? 63 : 64);
  });
  harness.poller.configure(true);
  harness.poller.activate(true);
  await flushPoll();
  assert.deepEqual(harness.poller.latest, sample(63));
  assert.equal(harness.tasks.size, 1);

  harness.fireTimer();
  await flushPoll();
  assert.deepEqual(harness.poller.latest, sample(63));
  assert.deepEqual(harness.updates, [sample(63)]);
  assert.equal(harness.tasks.size, 1);
  assert.equal([...harness.tasks.values()][0]?.delay, BATTERY_POLL_MS);

  harness.fireTimer();
  await flushPoll();
  assert.deepEqual(harness.poller.latest, sample(64));
  assert.deepEqual(harness.updates, [sample(63), sample(64)]);
  assert.equal(harness.tasks.size, 1);
});

test("structured unavailable and battery-absent responses update instead of retaining the cache", async () => {
  const unavailable: BatteryStatus = {
    percent: null, acConnected: null, charging: null, batteryPresent: null,
  };
  const absent: BatteryStatus = {
    percent: null, acConnected: false, charging: false, batteryPresent: false,
  };
  const responses: (BatteryStatus | null)[] = [sample(70), unavailable, absent];
  const harness = pollerHarness(async () => responses.shift() ?? null);
  harness.poller.configure(true);
  harness.poller.activate(true);
  await flushPoll();
  assert.deepEqual(harness.poller.latest, sample(70));

  harness.fireTimer();
  await flushPoll();
  assert.deepEqual(harness.poller.latest, unavailable);
  assert.equal(batteryReading(harness.poller.latest).text, "—");
  assert.deepEqual(harness.updates, [sample(70), unavailable]);

  harness.fireTimer();
  await flushPoll();
  assert.deepEqual(harness.poller.latest, absent);
  assert.equal(batteryReading(harness.poller.latest).more, "No battery detected");
  assert.deepEqual(harness.updates, [sample(70), unavailable, absent]);
  assert.equal(harness.tasks.size, 1);
});

test("the 60-second timer starts a second polling cycle", async () => {
  let calls = 0;
  const harness = pollerHarness(async () => sample(++calls === 1 ? 31 : 32));
  harness.poller.configure(true);
  harness.poller.activate(true);
  await flushPoll();
  assert.deepEqual(harness.updates, [sample(31)]);
  assert.equal(harness.tasks.size, 1);
  harness.fireTimer();
  await flushPoll();
  assert.equal(calls, 2);
  assert.deepEqual(harness.updates, [sample(31), sample(32)]);
  assert.equal(harness.tasks.size, 1);
});

for (const suspension of ["expanded", "hidden"] as const) {
  test(`${suspension} pauses timers and resume keeps cached content while refreshing`, async () => {
    const pending: ((status: BatteryStatus | null) => void)[] = [];
    const harness = pollerHarness(() => new Promise((resolve) => pending.push(resolve)));
    harness.poller.configure(true);
    harness.poller.activate(true);
    pending[0]!(sample(74));
    await flushPoll();
    assert.deepEqual(harness.poller.latest, sample(74));
    assert.equal(harness.tasks.size, 1);

    harness.poller.pause();
    assert.equal(harness.tasks.size, 0);
    assert.deepEqual(harness.poller.latest, sample(74));
    assert.deepEqual(harness.updates, [sample(74)]);

    harness.poller.activate(true);
    assert.equal(pending.length, 2);
    assert.deepEqual(harness.poller.latest, sample(74));
    assert.deepEqual(harness.updates, [sample(74)]);
    pending[1]!(sample(75));
    await flushPoll();
    assert.deepEqual(harness.updates, [sample(74), sample(75)]);
    assert.equal(harness.tasks.size, 1);
  });
}

test("pause invalidates the in-flight read without clearing cached status", async () => {
  const pending: ((status: BatteryStatus | null) => void)[] = [];
  const harness = pollerHarness(() => new Promise((resolve) => pending.push(resolve)));
  harness.poller.configure(true);
  harness.poller.activate(true);
  pending[0]!(sample(52));
  await flushPoll();
  harness.fireTimer();
  assert.equal(pending.length, 2);
  harness.poller.pause();
  assert.deepEqual(harness.poller.latest, sample(52));
  pending[1]!(sample(1));
  await flushPoll();
  assert.deepEqual(harness.poller.latest, sample(52));
  assert.deepEqual(harness.updates, [sample(52)]);
  assert.equal(harness.tasks.size, 0);
});

test("explicit deselection clears cached status and ignores stale responses", async () => {
  let resolveRead!: (status: BatteryStatus) => void;
  const harness = pollerHarness(() => new Promise((resolve) => { resolveRead = resolve; }));
  harness.poller.configure(true);
  harness.poller.activate(true);
  harness.poller.configure(false);
  resolveRead(sample(20));
  await flushPoll();
  assert.equal(harness.poller.latest, null);
  assert.deepEqual(harness.updates, [null]);
  assert.equal(harness.tasks.size, 0);
});

test("destroy clears timer and invalidates an in-flight read", async () => {
  let resolveRead!: (status: BatteryStatus) => void;
  const harness = pollerHarness(() => new Promise((resolve) => { resolveRead = resolve; }));
  harness.poller.configure(true);
  harness.poller.activate(true);
  harness.poller.destroy();
  harness.poller.destroy();
  resolveRead(sample(20));
  await flushPoll();
  assert.equal(harness.poller.latest, null);
  assert.deepEqual(harness.updates, []);
  assert.equal(harness.tasks.size, 0);
});

test("repeated activation never creates duplicate requests or timers", async () => {
  let resolveRead!: (status: BatteryStatus) => void;
  let calls = 0;
  const harness = pollerHarness(() => { calls++; return new Promise((resolve) => { resolveRead = resolve; }); });
  harness.poller.configure(true);
  harness.poller.activate(true);
  harness.poller.activate(true);
  assert.equal(calls, 1);
  assert.equal(harness.tasks.size, 0);
  resolveRead(sample(45));
  await flushPoll();
  harness.poller.activate(true);
  assert.equal(calls, 1);
  assert.equal(harness.tasks.size, 1);
});

test("battery can be paired with clock while the three-cell limit stays enforced", () => {
  const picked = compactMetrics({ compactMetrics: ["clock", "battery"] });
  assert.deepEqual(picked, ["clock", "battery"]);
  assert.equal(picked.length, 2);
  const capped = compactMetrics({ compactMetrics: ["clock", "battery", "waiting", "cpu"] });
  assert.deepEqual(capped, ["clock", "battery", "waiting"]);
  assert.equal(capped.length, MAX_COMPACT_METRICS);
});

test("pausing battery polling leaves the selected clock timer running", async () => {
  let nextClockId = 0;
  const clockTasks = new Map<number, () => void>();
  const clock = createCompactClock(() => {}, () => 12_000,
    (callback) => { const id = ++nextClockId; clockTasks.set(id, callback); return id; },
    (id) => { clockTasks.delete(id); }, String);
  const battery = pollerHarness(async () => sample(64));
  clock.configure(true);
  battery.poller.configure(true);
  battery.poller.activate(true);
  await flushPoll();
  assert.deepEqual(compactMetrics({ compactMetrics: ["clock", "battery"] }), ["clock", "battery"]);
  assert.equal(clockTasks.size, 1);
  assert.equal(battery.tasks.size, 1);

  battery.poller.pause();
  assert.equal(clockTasks.size, 1);
  assert.equal(battery.tasks.size, 0);
  clock.destroy();
  battery.poller.destroy();
  assert.equal(clockTasks.size, 0);
  assert.equal(battery.tasks.size, 0);
});
