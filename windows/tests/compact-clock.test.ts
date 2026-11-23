import assert from "node:assert/strict";
import test from "node:test";
import { compactClock, createCompactClock } from "../src/island/compact-clock.ts";
import { COMPACT_METRICS, compactMetrics, DEFAULT_SETTINGS, MAX_COMPACT_METRICS } from "../src/core/state.ts";

const at = (hour: number, minute: number) => new Date(2026, 0, 2, hour, minute).getTime();

test("clock delegates locale digits and day-period placement to Intl", () => {
  assert.equal(compactClock(at(0, 7), "en-US"), "12:07 AM");
  assert.equal(compactClock(at(13, 4), "en-US"), "1:04 PM");
  assert.equal(compactClock(at(0, 0), "en-US"), "12:00 AM");
  assert.equal(compactClock(at(12, 0), "en-US"), "12:00 PM");
  assert.equal(compactClock(at(0, 7), "en-GB"), "0:07");
  assert.equal(compactClock(at(13, 4), "en-GB"), "13:04");
  assert.equal(compactClock(at(0, 7), "ar-EG"), "١٢:٠٧ ص");
  assert.equal(compactClock(at(12, 0), "ar-EG"), "١٢:٠٠ م");
  assert.equal(compactClock(at(0, 7), "ko-KR"), "오전 12:07");
  assert.equal(compactClock(at(13, 4), "ko-KR"), "오후 1:04");
});

test("clock honors each Intl hour cycle, including both midnight conventions", () => {
  assert.equal(compactClock(at(0, 7), "en-US", "h11"), "0:07 AM");
  assert.equal(compactClock(at(13, 4), "en-US", "h11"), "1:04 PM");
  assert.equal(compactClock(at(0, 7), "en-US", "h12"), "12:07 AM");
  assert.equal(compactClock(at(12, 0), "en-US", "h12"), "12:00 PM");
  assert.equal(compactClock(at(0, 7), "en-US", "h23"), "0:07");
  assert.equal(compactClock(at(12, 0), "en-US", "h23"), "12:00");
  assert.equal(compactClock(at(0, 7), "en-US", "h24"), "24:07");
  assert.equal(compactClock(at(12, 0), "en-US", "h24"), "12:00");
});

test("compact clock text keeps locale cycle and day period while fitting measured 52px cell", () => {
  const cases: [string, Intl.DateTimeFormatOptions["hourCycle"], number, string][] = [
    ["en-GB", undefined, 19, "19:42"],
    ["en-US", "h12", 19, "7:42 PM"],
    ["en-US", "h12", 0, "12:42 AM"],
    ["ar-EG", "h12", 19, "٧:٤٢ م"],
    ["ko-KR", "h12", 19, "오후 7:42"],
    ["en-US", "h11", 19, "7:42 PM"],
    ["en-US", "h12", 19, "7:42 PM"],
    ["en-US", "h23", 19, "19:42"],
    ["en-US", "h24", 19, "19:42"],
    ["ar-EG", "h23", 19, "١٩:٤٢"],
    ["ko-KR", "h12", 19, "오후 7:42"],
  ];
  for (const [locale, hourCycle, hour, expected] of cases) {
    const text = compactClock(at(hour, 42), locale, hourCycle);
    assert.equal(text, expected);
    assert.ok(text.length <= 9, `${locale}/${hourCycle}: ${text}`);
  }
  assert.equal(compactClock(at(0, 0), "en-US", "h12"), "12:00 AM");
});

test("clock timer starts on activation and aligns each update to the minute", () => {
  let time = at(9, 14) + 23_000;
  let next = 0;
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  const shown: string[] = [];
  const clock = createCompactClock((text) => shown.push(text), () => time,
    (callback, delay) => { const id = ++next; tasks.set(id, { callback, delay }); return id; },
    (id) => { tasks.delete(id); }, (value) => String(value));
  clock.configure(true);
  assert.deepEqual(shown, [String(time)]);
  assert.equal(tasks.size, 1);
  assert.equal([...tasks.values()][0]!.delay, 37_000);
  time += 37_000;
  const task = tasks.values().next().value!;
  tasks.clear();
  task.callback();
  assert.deepEqual(shown, [String(at(9, 14) + 23_000), String(at(9, 15))]);
  assert.equal([...tasks.values()][0]!.delay, 60_000);
  clock.destroy();
  assert.equal(tasks.size, 0);
});

test("resync after clock changes recalculates alignment and updates immediately", () => {
  let time = at(9, 14) + 23_000;
  let next = 0;
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  const shown: number[] = [];
  const clock = createCompactClock((text) => shown.push(Number(text)), () => time,
    (callback, delay) => { const id = ++next; tasks.set(id, { callback, delay }); return id; },
    (id) => { tasks.delete(id); }, (value) => String(value));
  clock.configure(true);
  assert.equal([...tasks.values()][0]!.delay, 37_000);

  // A forward or backward system time change is reconciled at the next lifecycle resync.
  time = at(12, 42) + 11_000;
  clock.resync();
  assert.deepEqual(shown, [at(9, 14) + 23_000, at(12, 42) + 11_000]);
  assert.equal(tasks.size, 1);
  assert.equal([...tasks.values()][0]!.delay, 49_000);

  time = at(8, 5) + 42_000;
  clock.resync();
  assert.deepEqual(shown, [at(9, 14) + 23_000, at(12, 42) + 11_000, at(8, 5) + 42_000]);
  assert.equal(tasks.size, 1);
  assert.equal([...tasks.values()][0]!.delay, 18_000);
  clock.destroy();
  assert.equal(tasks.size, 0);
});

test("hidden and deselected states stop the clock, with no duplicate after repeated visibility changes", () => {
  let time = at(10, 0);
  let next = 0;
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  let calls = 0;
  const clock = createCompactClock(() => { calls++; }, () => time,
    (callback, delay) => { const id = ++next; tasks.set(id, { callback, delay }); return id; },
    (id) => { tasks.delete(id); });
  clock.configure(false);
  assert.equal(tasks.size, 0);
  clock.configure(true);
  clock.configure(true);
  clock.configure(true);
  assert.equal(tasks.size, 1);
  assert.equal(calls, 1);
  clock.configure(false);
  assert.equal(tasks.size, 0);
  clock.configure(false);
  clock.configure(true);
  assert.equal(tasks.size, 1);
  assert.equal(calls, 2);
  clock.destroy();
  clock.destroy();
  assert.equal(tasks.size, 0);
  clock.configure(true);
  assert.equal(tasks.size, 0);
});

test("legacy settings leave clock unpicked; the clock is a valid fourth choice, still capped at three", () => {
  assert.equal(COMPACT_METRICS.includes("clock"), true);
  assert.deepEqual(compactMetrics({ compactMetrics: DEFAULT_SETTINGS.compactMetrics }), ["cpu", "ram", "usage5h"]);
  assert.equal(compactMetrics({ compactMetrics: ["cpu", "ram", "usage5h", "clock"] }).length, MAX_COMPACT_METRICS);
  assert.deepEqual(compactMetrics({ compactMetrics: ["clock", "waiting", "usage7d", "cpu"] }), ["clock", "waiting", "usage7d"]);
});
