/** Keep battery availability text scoped to the battery picker row. */
export function updateBatteryTooltip(check: HTMLButtonElement, batteryAvailable: boolean, translate: (source: string) => string = (source) => source): void {
  if (batteryAvailable) check.removeAttribute("title");
  else check.title = translate("Battery status is unavailable on this computer.");
}
