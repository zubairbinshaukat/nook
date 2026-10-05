// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { Bridge, IS_TAURI, onEvent, type PanelSize } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, readMetrics, readUsage, type Settings } from "./core/state";
import { startAgentsFeed } from "./agents/feed";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { startWidgets } from "./widgets";

/**
 * Asks Rust for something that may not be there: a command of the usage
 * limits, which another build of the app may not have. Null then, and nothing
 * is said of it.
 */
async function ask(command: string): Promise<unknown> {
  if (!IS_TAURI) return null;
  try {
    return await invoke(command);
  } catch {
    return null;
  }
}

/** Whether usage limits are switched on in Settings, as far as Rust says: it words why no usage has come. */
async function readUsageInstalled() {
  const status = await ask("usage_status");
  const installed = (status as { installed?: unknown } | null)?.installed;
  if (typeof installed === "boolean") State.usageInstalled = installed;
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
    island.setRoom(boot.panel.width, boot.panel.height, boot.panel.dock);
    island.setScreenWidth(boot.screen.width, boot.screen.height);
  }
  // Another display, or the same one at another size: the window was sized again.
  await onEvent<PanelSize>("panel-size", ({ width, height, dock }) => {
    island.setRoom(width, height, dock);
    // The display's own width caps the folded island (its height, on a side): asked again, it may be another display.
    void Bridge.boot().then((again) => again && island.setScreenWidth(again.screen.width, again.screen.height));
  });

  // The machine, every 2.5 s while the island is on show, and Claude's usage
  // limits when Claude Code reports them. Neither wakes the island's frame
  // loop: each number is written where it shows (State.onGauges).
  await onEvent<unknown>("metrics", (payload) => {
    const metrics = readMetrics(payload);
    if (metrics) State.setMetrics(metrics);
  });
  await onEvent<unknown>("usage", (payload) => {
    const usage = readUsage(payload);
    if (!usage) return;
    // Usage that arrives was relayed: the limits are switched on.
    State.usageInstalled = true;
    State.setUsage(usage);
  });
  // What was last reported, before this page was listening.
  void ask("usage_last").then((last) => {
    const usage = readUsage(last);
    if (usage) State.setUsage(usage);
  });
  void readUsageInstalled();
  island.applySettings();
  // The Shelf's widgets read what they kept, and arm what must run on its own.
  startWidgets();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  const setPaused = (on: boolean) => {
    State.paused = on;
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // The window was hidden by the shortcut or the tray, and is on show again (Rust, visibility.rs).
  await onEvent<boolean>("island-shown", (shown) => {
    if (shown) island.onShown();
  });

  // A full-screen app came in front on the island's display, or left: said
  // by Rust's poll, which runs only while the island is on show.
  await onEvent<boolean>("fullscreen", (full) => island.onFullscreen(full === true));

  // A global shortcut, pressed anywhere: the session panel large or back to
  // its normal size, the panel at its normal size, or the way to the session that needs the user.
  await onEvent<string>("shortcut", (which) => {
    if (State.paused) return;
    if (which === "goto") island.goToNeedy();
    else if (which === "panel") island.summonPanelNormal();
    else island.summonPanel();
  });

  // The settings window writes preferences; apply them here without a restart.
  const agentsFeed = startAgentsFeed();
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    // The agents list may have just been turned on: it is sent the rows.
    agentsFeed.poke();
    State.loadIntegrationTasks();
    // Usage limits are switched on and off in that window too.
    void readUsageInstalled().then(() => State.setUsage(State.usage));
  });

  registerHookHandlers(island);
  // Switched on in the last run, the list is there at launch: it is sent the rows at once.
  agentsFeed.poke();

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
