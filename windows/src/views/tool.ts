// Which tool a session belongs to, shown the same way wherever a session
// appears: a mark and a name. State colours say what a session is doing and are
// never used for this.

import type { SessionAgent } from "../core/state";
import { BRANDS, CLAUDE_MARK, CODEX_MARK, brand, lucide } from "./iconset";
import { h } from "./dom";

export const TOOL_NAME: Record<SessionAgent, string> = { claude: "Claude Code", cursor: "Cursor", codex: "Codex" };

/** Claude's warm orange; Cursor's and Codex's marks are the plain text colour. */
export const CLAUDE_ORANGE = "#D97757";

/** What the folded island's legend says, for the tooltip. */
export const DOT_LEGEND = "Solid dot: Claude Code or Codex · Ringed dot: Cursor";

/** The tool's mark at `size`: a sparkle in Claude orange, Cursor's cube or Codex's prompt in the colour of the text. */
export function toolMark(agent: SessionAgent, size = 12): HTMLElement {
  const svg = agent === "cursor" ? brand(BRANDS.cursor, size) : agent === "codex" ? lucide(CODEX_MARK, size, 2.4) : lucide(CLAUDE_MARK, size, 2.4);
  if (agent === "claude") svg.style.color = CLAUDE_ORANGE;
  const el = h("span", { class: `tool-mark ${agent}`, title: TOOL_NAME[agent], role: "img", "aria-label": TOOL_NAME[agent] });
  el.append(svg);
  return el;
}
