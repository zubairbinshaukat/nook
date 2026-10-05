// Puts the island on the stage: the page's layers, the island's window where the
// app would place it (src-tauri/src/dock.rs), the sidebar and the "ready" signal
// for a capture. Preview only.

import { Display } from "../../src/core/layout";
import { State } from "../../src/core/state";
import type { Island } from "../../src/island/island";
import { geometry, parseOptions, type StageOptions } from "./options";
import { mountSidebar } from "./sidebar";
import { renderStage, wallpaperSettled } from "./stage";
import "./stage.css";
import "./sidebar.css";

export { rng } from "./options";

export interface Stage {
  /** What the URL says (kept current by live changes). */
  options: StageOptions;
  /** Parses the URL again and redraws: what a live change of the stage's own keys does. */
  relayout(): void;
}

/** Before the island exists: its layers, its window's size, its dock. */
export function installStage(rootEl: HTMLElement, params: URLSearchParams): Stage {
  const stage: Stage = { options: parseOptions(params), relayout: () => {} };
  const o = () => stage.options;

  const html = document.documentElement;
  html.classList.toggle("shot", o().shot);

  // The layers: the stage behind, the island's window over it.
  const stagebox = document.createElement("div");
  stagebox.id = "stagebox";
  const stageEl = document.createElement("div");
  stageEl.id = "stage";
  stagebox.append(stageEl);
  const rootbox = document.createElement("div");
  rootbox.id = "rootbox";
  rootEl.replaceWith(rootbox);
  rootbox.append(rootEl);
  document.body.prepend(stagebox);

  const view = () => geometry(o(), html.clientWidth, html.clientHeight);

  // The island sizes itself by its window's, which in a browser is the page's:
  // here it is the work area, as it is in the app. A top dock hangs from the display's edge.
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => view().root.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => view().root.height });

  const layout = () => {
    const g = view();
    const z = o().scale;
    Object.assign(stagebox.style, { width: `${g.w}px`, height: `${g.h}px` });
    Object.assign(rootbox.style, { left: `${g.root.left}px`, top: `${g.root.top}px`, width: `${g.root.width}px`, height: `${g.root.height}px` });
    stageEl.style.zoom = z === 1 ? "" : String(z);
    rootEl.style.zoom = z === 1 ? "" : String(z);
    Display.zoom = z;
    const bg = o().bg ?? (o().scene === "none" ? (o().theme === "dark" ? "#1b1d22" : "#e9ecf1") : "#2a2d34");
    html.style.setProperty("--page-bg", bg);
    renderStage(stageEl, o());
  };
  // Registered before the island's own listener, so it reads the new size.
  window.addEventListener("resize", layout);
  layout();

  State.settings.dock = o().dock;
  if (o().motion) State.settings.reduceMotion = o().motion === "reduce" ? "on" : "off";
  // A capture is the settled state: no spring on the way, nothing to catch half-drawn.
  else if (o().shot) State.settings.reduceMotion = "on";

  stage.relayout = () => {
    stage.options = parseOptions(new URLSearchParams(location.search));
    layout();
  };
  return stage;
}

/** Right after the island exists: the display it stands on (a `screen=` width wins), as the app tells it. */
export function placeIsland(stage: Stage, island: Island, screenWidth: number | null) {
  const o = stage.options;
  const g = geometry(o, document.documentElement.clientWidth, document.documentElement.clientHeight);
  island.setScreenWidth(screenWidth ?? g.w / o.scale, g.h / o.scale);
}

/** Once the scenario is set up: the sidebar (never in a capture) and the signal that the page is settled. */
export function finishStage(stage: Stage) {
  if (!stage.options.shot) mountSidebar(stage.options, { onLive: () => stage.relayout() });
  void ready(stage.options.shot);
}

/** `<html data-ready="1">` and `window.__shotReady`: fonts loaded, the island's springs at rest. */
async function ready(shot: boolean) {
  const frames = (n: number) => new Promise<void>((done) => {
    const step = () => (n-- > 0 ? requestAnimationFrame(step) : done());
    step();
  });
  try {
    await document.fonts.ready;
    await wallpaperSettled();
  } catch {
    /* no font loading API: nothing to wait for */
  }
  await frames(3);
  // Reduced motion jumps every spring to its end; this is the time the fold and the cards need to land.
  await new Promise((done) => window.setTimeout(done, shot ? 1500 : 300));
  await frames(2);
  document.documentElement.dataset.ready = "1";
  (window as unknown as { __shotReady: boolean }).__shotReady = true;
}
