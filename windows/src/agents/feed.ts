// The island's page hands the agents list its rows. The island holds every
// session, so it works the rows out (model.ts) and sends them to Rust, which
// keeps the latest and tells the list. Only while the list is on in Settings,
// a moment after the last change, and only when the rows are not the ones the
// list already has. It runs whether or not the island is on show: it listens to
// the state, not to the island's frames.

import { Bridge, onEvent } from "../core/bridge";
import { State } from "../core/state";
import { snapshotOf } from "./model";

/** Changes come in runs: the rows go once, this long after the last of them. */
const DEBOUNCE_MS = 150;

/** Starts the feed. `poke` is for a change of settings: the list may just have been turned on. */
export function startAgentsFeed(): { poke: () => void } {
  let timer = 0;
  let last = "";

  const send = (force: boolean) => {
    timer = 0;
    if (!State.settings.showAgentsList) return;
    const snapshot = snapshotOf(State.sessions, State.usage, Date.now());
    const text = JSON.stringify(snapshot);
    if (!force && text === last) return;
    last = text;
    void Bridge.agentsSnapshot(snapshot);
  };

  const soon = () => {
    if (timer || !State.settings.showAgentsList) return;
    timer = window.setTimeout(() => send(false), DEBOUNCE_MS);
  };

  State.subscribe(soon);
  State.onGauges(soon);
  // The list was shown, or loaded: it has nothing yet, so the rows go whether they changed or not.
  void onEvent<null>("agents-wanted", () => send(true));
  return { poke: soon };
}
