// The button that goes to where a session runs: the ↗ of the session card and
// of the session panel. Its icon and its tooltip say where that is — an
// editor's window, a terminal's, the Claude app — and it is not there at all
// for a session nothing says the place of.

import { targetTip, type ClaudeSession, type TargetKind } from "../core/state";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";

/** What stands for each place: a stroked mark, drawn like the panel's others. */
const TARGET_ICONS: Record<Exclude<TargetKind, "unknown">, string> = {
  vscode: ICONS.editorWindow,
  cursor: ICONS.editorWindow,
  terminal: ICONS.terminalWindow,
  claude: ICONS.comment,
};

/** The mark of the place a session runs in; none for one nothing says the place of. */
export function targetIcon(kind: TargetKind, size: number): SVGElement | null {
  return kind === "unknown" ? null : svg(TARGET_ICONS[kind], size, { stroke: 2 });
}

export interface TargetButton {
  el: HTMLButtonElement;
  /** Follows a session: where it goes, or out of sight when it goes nowhere. */
  sync(session: ClaudeSession): void;
}

/**
 * `cls` is the button's own class, `size` its icon's; `open` goes to the
 * session in front.
 */
export function targetButton(cls: string, size: number, open: () => void): TargetButton {
  const el = h("button", { class: `${cls} to-target`, onclick: open });
  // Out of sight until a session has said where it runs.
  el.style.display = "none";
  let drawn = "";
  return {
    el,
    sync(session) {
      const tip = targetTip(session);
      const kind = session.target.kind;
      el.style.display = tip && kind !== "unknown" ? "" : "none";
      if (!tip || kind === "unknown") return;
      el.title = tip;
      el.setAttribute("aria-label", tip);
      el.dataset.target = kind;
      if (kind === drawn) return;
      drawn = kind;
      clear(el);
      el.append(svg(TARGET_ICONS[kind], size, { stroke: 2 }));
    },
  };
}
