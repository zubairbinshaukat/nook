import { currentIslandLanguage, localeFor } from "../core/i18n.ts";
import type { SessionStep } from "../core/state.ts";
import { stepMessage, stepName } from "./step-labels.ts";

export interface JournalEntryNode<T> {
  el: T;
  key: string;
}

export function cacheJournalEntry<T>(
  entries: WeakMap<SessionStep, JournalEntryNode<T>>,
  step: SessionStep,
  contentKey: string,
  render: () => T,
): { entry: JournalEntryNode<T>; previous: JournalEntryNode<T> | undefined; changed: boolean; localeChanged: boolean } {
  const language = currentIslandLanguage();
  const key = `${language}~${contentKey}`;
  const previous = entries.get(step);
  if (previous?.key === key) return { entry: previous, previous, changed: false, localeChanged: false };
  const entry = { el: render(), key };
  entries.set(step, entry);
  return { entry, previous, changed: true, localeChanged: previous != null && !previous.key.startsWith(`${language}~`) };
}

export function journalClock(at: number): string {
  return new Intl.DateTimeFormat(localeFor(currentIslandLanguage()), { hour: "2-digit", minute: "2-digit" }).format(new Date(at));
}

/** The locale-sensitive strings used by a journal row's production renderer. */
export function journalEntryCopy(step: SessionStep) {
  return { heading: stepName(step), message: stepMessage(step), time: journalClock(step.at) };
}
