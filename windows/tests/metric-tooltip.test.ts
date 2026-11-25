import assert from "node:assert/strict";
import test from "node:test";
import { updateBatteryTooltip } from "../src/settings/metric-tooltip.ts";

class FakeButton {
  title = "";
  removeAttribute(name: string) {
    if (name === "title") this.title = "";
  }
}

const GPU_TOOLTIP = "Shows — on a computer that does not report its graphics use.";

test("battery availability tooltip is scoped to the battery row", () => {
  const gpu = new FakeButton();
  gpu.title = GPU_TOOLTIP;
  const cpu = new FakeButton();
  cpu.title = "CPU metric tooltip";
  const battery = new FakeButton();

  updateBatteryTooltip(battery as unknown as HTMLButtonElement, false);
  assert.equal(battery.title, "Battery status is unavailable on this computer.");
  assert.equal(gpu.title, GPU_TOOLTIP);
  assert.equal(cpu.title, "CPU metric tooltip");

  updateBatteryTooltip(battery as unknown as HTMLButtonElement, true);
  assert.equal(battery.title, "");
  assert.equal(gpu.title, GPU_TOOLTIP);
  assert.equal(cpu.title, "CPU metric tooltip");
});

test("repeated Settings repaints preserve GPU and other metric tooltips", () => {
  const gpu = new FakeButton();
  gpu.title = GPU_TOOLTIP;
  const ram = new FakeButton();
  ram.title = "RAM metric tooltip";
  const battery = new FakeButton();

  for (const batteryAvailable of [false, true, false, true]) {
    updateBatteryTooltip(battery as unknown as HTMLButtonElement, batteryAvailable);
    assert.equal(gpu.title, GPU_TOOLTIP);
    assert.equal(ram.title, "RAM metric tooltip");
  }
});
