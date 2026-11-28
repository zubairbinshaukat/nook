import { tIsland, type IslandTranslationKey, type Language } from "../core/i18n.ts";
import type { ActivityLabelKey, ActivityLine, SessionStep } from "../core/state.ts";

const STEP_NAMES: Readonly<Record<string, string>> = {
  AskUserQuestion: "Question",
  NotebookEdit: "Notebook",
  MultiEdit: "Edit",
  TodoWrite: "Todos",
  WebSearch: "Search",
  WebFetch: "Fetch",
  PowerShell: "Shell",
};

const STEP_NAME_KEYS: Readonly<Record<string, IslandTranslationKey>> = {
  WebSearch: "island.tool.search",
  WebFetch: "island.tool.fetch",
  Thinking: "island.tool.thinking",
  Note: "island.tool.note",
  Error: "island.tool.error",
  Notification: "island.tool.notification",
  "Cursor said": "island.tool.cursorSaid",
};

const TOOL_LABELS: Record<string, ActivityLabelKey> = {
  Bash: "island.tool.runs",
  PowerShell: "island.tool.runs",
  Read: "island.tool.reads",
  Write: "island.tool.writes",
  Edit: "island.tool.edits",
  MultiEdit: "island.tool.edits",
  Glob: "island.tool.finds",
  Grep: "island.tool.searches",
  Task: "island.tool.agent",
  LS: "island.tool.lists",
  TodoWrite: "island.tool.todos",
  NotebookEdit: "island.tool.notebook",
  WebSearch: "island.tool.searchesWeb",
  WebFetch: "island.tool.fetches",
};

const TOOL_ALIASES: Readonly<Record<string, string>> = {
  AskUserQuestion: "Question",
  NotebookEdit: "Notebook",
  MultiEdit: "Edit",
  TodoWrite: "Todos",
  PowerShell: "Shell",
};

function lastPathComponent(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  const index = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return index >= 0 ? cleaned.slice(index + 1) : cleaned;
}

/** Map known tool IDs for display; unknown IDs remain verbatim technical labels. */
export function stepActivityLine(tool: string, input: Record<string, unknown>): ActivityLine {
  const key = TOOL_LABELS[tool];
  const label = TOOL_ALIASES[tool] ?? tool;
  const value = (name: string) => typeof input[name] === "string" ? input[name] as string : null;
  const action = (target: string): ActivityLine => key ? { key, target } : { label, target };
  const command = value("command");
  if (command) return action(command.slice(0, 40));
  const path = value("path");
  if (path) return action(lastPathComponent(path));
  const file = value("file_path");
  if (file) return action(lastPathComponent(file));
  const query = value("query");
  if (query) return action(query.slice(0, 40));
  return key ? { key } : label;
}

/** Translate known event/tool IDs only; never inspect display or provider text. */
export function stepName(step: SessionStep, language?: Language): string {
  const key = STEP_NAME_KEYS[step.tool];
  if (key) return tIsland(key, {}, language);
  return STEP_NAMES[step.tool] ?? step.tool;
}

/** Resolve app-authored activity only at the current-language presentation boundary. */
export function activityLineText(line: ActivityLine, language?: Language): string {
  if (typeof line === "string") return line;
  const label = "key" in line ? tIsland(line.key, {}, language) : line.label;
  return line.target ? tIsland("island.tool.operation", { label, target: line.target }, language) : label;
}

export function stepMessage(step: SessionStep, language?: Language): string {
  return step.messageKey ? tIsland(step.messageKey, {}, language) : step.target ?? "";
}
