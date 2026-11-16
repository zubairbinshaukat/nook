import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SETTINGS, State, readCodexQuota, readUsage } from "../src/core/state.ts";

const fresh = {
  generation: 1,
  quotas: {
    fiveHour: { usedPercent: 0, windowDurationMins: 300, resetsAt: Date.now() + 60_000 },
    sevenDay: { usedPercent: 41.5, windowDurationMins: 10_080, resetsAt: Date.now() + 86_400_000 },
  },
  updatedAt: Date.now(),
  stale: false,
  available: true,
  failureReason: null,
};

test("Codex quota access defaults to off", () => {
  assert.equal(DEFAULT_SETTINGS.codexQuotaEnabled, false);
});

test("a valid zero is quota data, while malformed windows are unavailable", () => {
  const parsed = readCodexQuota(fresh);
  assert.equal(parsed?.quotas?.fiveHour?.usedPercent, 0);
  assert.equal(parsed?.quotas?.sevenDay?.windowDurationMins, 10_080);
  assert.equal(readCodexQuota({ ...fresh, quotas: { fiveHour: { usedPercent: "0" } } }), null);
});

test("unavailable and stale results clear Codex quota values from the UI state", () => {
  State.setCodexQuota(readCodexQuota(fresh));
  assert.equal(State.codexQuota?.quotas?.fiveHour?.usedPercent, 0);

  State.setCodexQuota(readCodexQuota({ ...fresh, available: false, quotas: null }));
  assert.equal(State.codexQuota, null);

  State.setCodexQuota(readCodexQuota(fresh));
  State.setCodexQuota(readCodexQuota({ ...fresh, stale: true }));
  assert.equal(State.codexQuota, null);
});

test("Claude usage decoding remains independent", () => {
  const claude = readUsage({
    fiveHour: { usedPercent: 22, resetsAt: Date.now() + 60_000 },
    sevenDay: null,
    updatedAt: Date.now(),
  });
  assert.equal(claude?.fiveHour?.usedPercent, 22);
  assert.equal(claude?.sevenDay, null);
});
