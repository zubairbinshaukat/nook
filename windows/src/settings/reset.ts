import type { Settings } from "../core/state";

/** Appearance defaults are independent from the persisted interface language. */
export const LOOK_RESET_FIELDS = ["botTheme", "playfulReactions", "theme", "reduceMotion"] as const satisfies readonly (keyof Settings)[];

export function lookResetPatch(defaults: Settings): Pick<Settings, (typeof LOOK_RESET_FIELDS)[number]> {
  return Object.fromEntries(LOOK_RESET_FIELDS.map((key) => [key, structuredClone(defaults[key])])) as Pick<Settings, (typeof LOOK_RESET_FIELDS)[number]>;
}

export function lookAtDefaults(settings: Settings, defaults: Settings): boolean {
  return LOOK_RESET_FIELDS.every((key) => JSON.stringify(settings[key]) === JSON.stringify(defaults[key]));
}
