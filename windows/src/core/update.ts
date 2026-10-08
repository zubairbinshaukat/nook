// Whether a newer Nook is out, as the island knows it.
//
// Nook asks GitHub for its latest release only when the user has switched the
// daily check on (Settings → About), or presses "Check now" there
// (src-tauri/src/update.rs). The island never asks: it is told the result, and
// shows it — a mark in its header — only while the check is switched on.

import { Bridge, type UpdateInfo } from "./bridge";
import { State } from "./state";

let info: UpdateInfo | null = null;

function read(value: unknown): UpdateInfo | null {
  if (!value || typeof value !== "object") return null;
  const { current, latest, available, url, checkedAt } = value as Partial<UpdateInfo>;
  if (typeof latest !== "string" || !latest || typeof available !== "boolean") return null;
  return { current: typeof current === "string" ? current : "", latest, available, url: typeof url === "string" ? url : "", checkedAt: typeof checkedAt === "number" ? checkedAt : 0 };
}

export const Update = {
  /** What was last known, before this page was listening. */
  async load() {
    Update.checked(await Bridge.updateLast());
  },
  /** The `update_checked` event, or what `load` read. */
  checked(value: unknown) {
    const next = read(value);
    if (!next) return;
    info = next;
    State.notify();
  },
  /** The newer version to tell of, or null: none is out, or the user has not asked to be told. */
  get offered(): UpdateInfo | null {
    return info?.available && State.settings.checkUpdates ? info : null;
  },
  /** Opens the release page in the browser. */
  open: () => void Bridge.updateOpen(),
};
