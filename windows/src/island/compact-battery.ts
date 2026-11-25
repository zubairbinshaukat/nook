import type { BatteryStatus } from "../core/bridge";

export const BATTERY_POLL_MS = 60_000;
export const BATTERY_RING_RADIUS = 9.5;
export const BATTERY_RING_SIZE = 22;
export const BATTERY_SIDE_RING_SIZE = 18;
export const BATTERY_CELL_GAP = 5;
export const BATTERY_SIDE_CELL_GAP = 2;
export const BATTERY_PERCENT_WIDTH = 40;
export const BATTERY_SIDE_PERCENT_WIDTH = 26;
export const BATTERY_CELL_WIDTH = BATTERY_RING_SIZE + BATTERY_CELL_GAP + BATTERY_PERCENT_WIDTH;
export const BATTERY_SIDE_CELL_WIDTH = BATTERY_SIDE_RING_SIZE + BATTERY_SIDE_CELL_GAP + BATTERY_SIDE_PERCENT_WIDTH;
export const BATTERY_RING_CIRCUMFERENCE = 2 * Math.PI * BATTERY_RING_RADIUS;

export type BatteryRingLevel = "green" | "amber" | "red" | "unknown";

export function batteryRingLevel(percent: number | null): BatteryRingLevel {
  if (percent == null || !Number.isInteger(percent) || percent < 0 || percent > 100) return "unknown";
  if (percent < 20) return "red";
  if (percent < 50) return "amber";
  return "green";
}

export interface BatteryReading {
  text: string;
  more: string;
  accessible: string;
  percent: number | null;
  progress: number;
  showProgress: boolean;
  dashOffset: number;
  level: BatteryRingLevel;
  charging: boolean;
  showBolt: boolean;
}

/** Values for the compact ring, keeping missing measurements distinct from zero. */
export function batteryReading(status: BatteryStatus | null): BatteryReading {
  const value = status?.batteryPresent === true
    && status.percent != null
    && Number.isInteger(status.percent)
    && status.percent >= 0
    && status.percent <= 100
    ? status.percent
    : null;
  const text = value == null ? "—" : `${value}%`;
  const level = batteryRingLevel(value);
  const charging = value != null && status?.charging === true;
  const showBolt = charging;
  const chargeState = value == null
    ? status?.batteryPresent === false ? "No battery detected" : "Battery status unavailable"
    : status?.charging === true ? "Charging" : status?.charging === false ? "Not charging" : "Charging state unknown";
  const powerSource = status?.acConnected === true ? "AC connected" : status?.acConnected === false ? "On battery power" : "Power source unknown";
  const accessible = value == null
    ? "Battery status unavailable"
    : status?.charging === true ? `Battery: ${text}, charging`
      : status?.charging === false ? `Battery: ${text}`
        : `Battery: ${text}, charging state unknown`;
  const progress = value ?? 0;
  return {
    text,
    more: value == null ? chargeState : `${chargeState} · ${powerSource}`,
    accessible,
    percent: value,
    progress,
    showProgress: value != null && value > 0,
    dashOffset: BATTERY_RING_CIRCUMFERENCE * (1 - progress / 100),
    level,
    charging,
    showBolt,
  };
}

/** Shared SVG construction for the live metric and Settings preview. */
export function batteryRingSvg(reading: BatteryReading, size: number): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("ci-battery-ring");
  svg.dataset.level = reading.level;
  svg.dataset.empty = String(!reading.showProgress);

  const track = document.createElementNS(ns, "circle");
  track.setAttribute("cx", "12");
  track.setAttribute("cy", "12");
  track.setAttribute("r", String(BATTERY_RING_RADIUS));
  track.classList.add("ci-battery-track");

  const progress = document.createElementNS(ns, "circle");
  progress.setAttribute("cx", "12");
  progress.setAttribute("cy", "12");
  progress.setAttribute("r", String(BATTERY_RING_RADIUS));
  progress.setAttribute("transform", "rotate(-90 12 12)");
  progress.classList.add("ci-battery-progress");
  progress.style.strokeDasharray = String(BATTERY_RING_CIRCUMFERENCE);
  progress.style.strokeDashoffset = String(reading.dashOffset);
  svg.append(track, progress);
  return svg;
}

/** One immediate read and one replaceable timeout while selected. */
export function createCompactBatteryPoller(
  read: () => Promise<BatteryStatus | null>,
  onStatus: (status: BatteryStatus | null) => void,
  schedule: (callback: () => void, delay: number) => number = (callback, delay) => window.setTimeout(callback, delay),
  cancel: (id: number) => void = (id) => window.clearTimeout(id),
) {
  let selected = false;
  let active = false;
  let disposed = false;
  let timer: number | null = null;
  let generation = 0;
  let latest: BatteryStatus | null = null;

  const clear = () => {
    if (timer != null) cancel(timer);
    timer = null;
  };

  const poll = async (current: number) => {
    let status: BatteryStatus | null = null;
    let succeeded = false;
    try {
      status = await read();
      succeeded = status !== null;
    } catch {
      // Keep the last successful reading and retry next minute.
    }
    if (!selected || !active || disposed || current !== generation) return;
    if (succeeded) {
      latest = status;
      onStatus(status);
    }
    timer = schedule(() => {
      timer = null;
      void poll(current);
    }, BATTERY_POLL_MS);
  };

  return {
    configure(on: boolean) {
      if (disposed || selected === on) return;
      selected = on;
      clear();
      generation++;
      if (!selected) {
        latest = null;
        active = false;
        onStatus(null);
      }
    },
    activate(on: boolean) {
      if (disposed || active === on) return;
      if (on && !selected) return;
      active = on;
      clear();
      generation++;
      if (active && selected) void poll(generation);
    },
    pause() {
      if (disposed || !active) return;
      active = false;
      clear();
      generation++;
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      selected = false;
      active = false;
      generation++;
      clear();
      latest = null;
    },
    get latest() { return latest; },
  };
}
