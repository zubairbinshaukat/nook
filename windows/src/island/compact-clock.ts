/** Local time in the system's preferred 12- or 24-hour clock. */
export function compactClock(now = Date.now(), locale?: string, hourCycle?: Intl.DateTimeFormatOptions["hourCycle"]): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: hourCycle === "h11" || hourCycle === "h12" ? "numeric" : "2-digit",
    minute: "2-digit",
    ...(hourCycle ? { hourCycle } : {}),
  };
  const formatter = new Intl.DateTimeFormat(locale, options);
  const parts = formatter.formatToParts(now);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  const period = parts.find((part) => part.type === "dayPeriod")?.value;
  const separator = parts.find((part) => part.type === "literal" && part.value.includes(":"))?.value ?? ":";

  // Drop a leading zero only in a 24-hour cycle (or when Intl says the hour is
  // numeric); minutes and localized digits remain exactly as Intl supplied.
  const compactHour = options.hour === "2-digit" ? hour.replace(/^0(?=\p{Nd})/u, "") : hour;
  const time = `${compactHour}${separator}${minute}`;
  if (!period) return time;

  // The day period is essential to read a 12-hour time. Keep its locale-specific
  // wording, but omit only Intl's whitespace literal to fit compact cells.
  const periodSide = parts.findIndex((part) => part.type === "dayPeriod");
  const timeSide = parts.findIndex((part) => part.type === "hour");
  const separatorBeforePeriod = parts.slice(0, periodSide).some((part) => part.type === "literal" && /\s/u.test(part.value));
  const separatorAfterPeriod = parts.slice(periodSide + 1).some((part) => part.type === "literal" && /\s/u.test(part.value));
  return periodSide < timeSide
    ? `${period}${separatorAfterPeriod ? " " : ""}${time}`
    : `${time}${separatorBeforePeriod ? " " : ""}${period}`;
}

export interface CompactClock {
  configure(active: boolean): void;
  /** Re-read system local time and realign after a known lifecycle wake. */
  resync(): void;
  destroy(): void;
}

/** A one-shot timer aligned to each local minute, active only while selected and shown. */
export function createCompactClock(
  changed: (text: string) => void,
  now: () => number = Date.now,
  schedule: (callback: () => void, delay: number) => number = (callback, delay) => window.setTimeout(callback, delay),
  cancel: (id: number) => void = (id) => window.clearTimeout(id),
  format: (time: number) => string = compactClock,
): CompactClock {
  let timer: number | null = null;
  let active = false;
  let destroyed = false;

  const stop = () => {
    if (timer == null) return;
    cancel(timer);
    timer = null;
  };
  const tick = () => {
    timer = null;
    if (!active || destroyed) return;
    const time = now();
    changed(format(time));
    timer = schedule(tick, 60_000 - time % 60_000);
  };

  const resync = () => {
    if (!active || destroyed) return;
    stop();
    const time = now();
    changed(format(time));
    timer = schedule(tick, 60_000 - time % 60_000);
  };

  return {
    configure(shown) {
      if (destroyed || shown === active) return;
      active = shown;
      stop();
      if (active) resync();
    },
    resync,
    destroy() {
      if (destroyed) return;
      active = false;
      stop();
      destroyed = true;
    },
  };
}
