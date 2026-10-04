// The six widgets, by id: how each is built, and how they start.
// A widget that is not built yet has its place in the row (views/shelf.ts)
// and nothing in it.

import type { ShelfWidgetId } from "./defs";
import { buildMedia } from "./media";
import { buildMirror } from "./mirror";
import { buildProjects } from "./projects";
import { buildReminders, rearmReminders, startReminders } from "./reminders";
import { buildTimer, rearmTimer, startTimer } from "./timer";
import { buildTodo, startTodo } from "./todo";
import type { Widget, WidgetContext } from "./ui";

export const BUILDERS: Partial<Record<ShelfWidgetId, (ctx: WidgetContext) => Widget>> = {
  media: buildMedia,
  mirror: buildMirror,
  projects: buildProjects,
  todo: buildTodo,
  timer: buildTimer,
  reminders: buildReminders,
};

/** Once, at start: what each widget kept is read, and what must run on its own (a timer, a reminder) is armed. */
export function startWidgets() {
  void startTodo();
  void startTimer();
  void startReminders();
}

/** Settings → Shelf changed what is on: a widget that is off arms nothing. */
export function widgetsSettingsChanged() {
  rearmTimer();
  rearmReminders();
}
