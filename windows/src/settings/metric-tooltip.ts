/** Keep battery availability text scoped to the battery picker row. */
export function updateBatteryTooltip(check: HTMLButtonElement, batteryAvailable: boolean): void {
  if (batteryAvailable) check.removeAttribute("title");
  else check.title = "Battery status is unavailable on this computer.";
}
