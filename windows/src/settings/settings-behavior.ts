/** Snapshot keys changed by a Settings echo, including unrelated combined updates. */
export function changedSettingKeys(previous: Record<string, unknown>, next: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}

export interface SettingsEchoEffects {
  localize(): void;
  applyAppearance(): void;
  followFeatures(): void;
  paintResets(): void;
}

/** Resolves the shortcut error that the Settings row paints, using the current locale. */
export function shortcutProblemText<Locale>(
  error: string | null | undefined,
  refused: string | null,
  enabled: boolean,
  dormant: boolean,
  language: Locale,
  translate: (source: string, language: Locale) => string,
): string | null {
  const problem = refused ?? (enabled && !dormant ? error ?? null : null);
  return problem ? translate(problem.replace(/[.!?]+$/, ""), language) : null;
}

/** Joins a localized shortcut refusal to any follow-up sentence with clean punctuation. */
export function composeShortcutRefusal(
  problem: string,
  stillUsing: string | null,
  join: (reason: string, keys: string) => string,
): string {
  const reason = problem.replace(/[.!?…]+$/u, "");
  return stillUsing
    ? join(reason, stillUsing)
    : `${reason}.`;
}

/** Shared narrow, locale-aware labels for the duration choices in Island Settings. */
export function formatSettingsDuration<Locale>(
  seconds: number,
  language: Locale,
  neverLabel: string,
  formatSeconds: (seconds: number, language: Locale) => string,
): string {
  return seconds === 0 ? neverLabel : formatSeconds(seconds, language);
}

/** Routes an echo through the same Settings effects used by the real window. */
export function applySettingsEchoEffects(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  previousLanguage: string,
  currentLanguage: string,
  effects: SettingsEchoEffects,
): string[] {
  const changed = changedSettingKeys(previous, current);
  if (previousLanguage !== currentLanguage) effects.localize();
  if (changed.some((key) => key === "theme" || key === "reduceMotion" || key === "botTheme")) effects.applyAppearance();
  effects.followFeatures();
  effects.paintResets();
  return changed;
}

/** Keeps async and locale-triggered paints tied to the locale at invocation time. */
export function createLocalizedPainter<Locale>(getLocale: () => Locale, paint: (locale: Locale) => void): () => void {
  return () => paint(getLocale());
}
