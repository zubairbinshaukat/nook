// Made-up sessions for the session panel preview, in the shapes the app keeps
// (ClaudeSession, SessionStep) plus the one plans/subagents-plan.md adds: a
// session's subagents, each with its own steps. Preview only.
//
// Everything a subagent has here is something the hooks carry (the plan,
// section 2): `agent_id` and `agent_type` from SubagentStart, the description
// from the parent's Agent call, its steps from the tool events that name it,
// and what it said last from SubagentStop.

import { newSession, type ClaudeSession, type Question, type SessionStep, type StepKind } from "../../src/core/state";
import type { BotStateName } from "../../src/core/layout";

/** A subagent of a session, as plans/subagents-plan.md section 6 shapes it. */
export interface Subagent {
  id: string;
  /** `agent_type`: Explore, general-purpose, Plan… */
  type: string;
  /** What it was launched to do; null when no event named it. */
  description: string | null;
  state: "running" | "done" | "failed";
  startedAt: number;
  endedAt: number | null;
  /** What it said last (done), or why it stopped (failed). */
  result: string | null;
  steps: SessionStep[];
}

/**
 * A line of the main journal: a step of the main session, or the place where it
 * launched a subagent. `when` keeps a launch for the scenario that shows it: the
 * one with five subagents, or the one where a new subagent starts.
 */
export type Item =
  | { kind: "step"; step: SessionStep }
  | { kind: "launch"; agent: Subagent; when?: "five" | "new" };

export interface PreviewSession {
  session: ClaudeSession;
  items: Item[];
}

const T0 = Date.now();
const ago = (seconds: number) => T0 - seconds * 1000;

function step(tool: string, kind: StepKind, target: string | null, secondsAgo: number, more: Partial<SessionStep> = {}): SessionStep {
  return { tool, kind, state: "done", target, result: null, patch: null, questions: null, answers: null, permission: null, at: ago(secondsAgo), ...more };
}

const printed = (lines: string[], start: number | null = null) => ({ text: lines.join("\n"), start, truncated: false, tail: start == null });
const item = (s: SessionStep): Item => ({ kind: "step", step: s });

function session(id: string, project: string, title: string, state: BotStateName, heardSecondsAgo: number): ClaudeSession {
  return { ...newSession(id), target: { kind: "terminal", label: "Windows Terminal", tabbed: true }, title, project, cwd: `D:\\work\\${project}`, state, heardAt: ago(heardSecondsAgo) };
}

// ── The session on show: nook, with its subagents ─────────────────────────────

const explore: Subagent = {
  id: "a1f08c03f03bd405d", type: "Explore", description: "Map where hook events are routed", state: "done",
  startedAt: ago(338), endedAt: ago(262),
  result: "Events are routed in `handleHook()`. Three places need `agent_id`: `sessionOf`, `recordStep` and the `PermissionRequest` branch.\n\nThe relay already passes `agent_id` and `agent_type` through; it drops `tool_response`, so the `Agent` call's `agentId` has to be lifted first.",
  steps: [
    step("Grep", "search", "handleHook|sessionOf", 334, { result: printed(["windows/src/island/hooks.ts:96:function sessionOf(island: Island, payload: HookPayload): ClaudeSession {", "windows/src/island/hooks.ts:171:export function handleHook(island: Island, payload: HookPayload) {"]) }),
    step("Read", "read", "windows/src/island/hooks.ts", 321, {
      result: printed([
        "export function handleHook(island: Island, payload: HookPayload) {",
        "  const session = sessionOf(island, payload);",
        "  switch (payload.hook_event_name) {",
        '    case "SubagentStart":',
        '      note(session, "A subagent started");',
      ], 171),
    }),
    step("Read", "read", "windows/hook/src/main.rs", 301),
    step("Bash", "command", 'rg -n "tool_response" windows/hook/src', 280, {
      permission: "allowed",
      result: printed(["windows/hook/src/main.rs:142:    // tool_response is dropped before forwarding: only a few lines of it are kept.", "windows/hook/src/main.rs:143:    payload.remove(\"tool_response\");"]),
    }),
  ],
};

const pusher: Subagent = {
  id: "0a7e303f7f7626095", type: "general-purpose", description: "Push the preview branch", state: "failed",
  startedAt: ago(148), endedAt: ago(121),
  result: "The push did not succeed: `git push origin subagents-preview` was denied by the permission system.",
  steps: [
    step("Bash", "command", "git status --short", 144, { result: printed([" M windows/src/core/state.ts", " M windows/src/island/hooks.ts"]) }),
    step("Bash", "command", "git push origin subagents-preview", 124, { state: "failed", permission: "denied", result: printed(["Permission to run this command was denied."]) }),
  ],
};

const writer: Subagent = {
  id: "b27c5d1e90aa3417f", type: "general-purpose", description: "Write a note", state: "running",
  startedAt: ago(83), endedAt: null, result: null,
  steps: [
    step("Read", "read", "plans/subagents-plan.md", 76, {
      result: printed(["# Subagents plan", "", "Status: **plan + prototype only.** Findings below come from a real session, not from documentation."], 1),
    }),
    step("Grep", "search", "SubagentStop", 61, { result: printed(['windows/src/island/hooks.ts:216:    case "SubagentStop":']) }),
    step("Write", "edit", "plans/notes/subagents.md", 9, {
      state: "running",
      patch: ["@@ -0,0 +1,4 @@", "+# Subagents: how their events reach the journal", "+", "+Every tool event fired inside a subagent carries `agent_id`.", "+The description comes from the parent's `Agent` call."].join("\n"),
    }),
  ],
};

const finder: Subagent = {
  id: "c93e77b2046d18ac2", type: "Explore", description: "Find every journal renderer", state: "running",
  startedAt: ago(81), endedAt: null, result: null,
  steps: [
    step("Grep", "search", "journalEntry|stepPreview", 70, { result: printed(["windows/src/views/session.ts:214:function journalEntry(step: SessionStep, typed?: ToType[]): HTMLElement {", "windows/src/views/step.ts:75:export function stepPreview(step: SessionStep, limit?: number, typed?: ToType[]): HTMLElement | null {"]) }),
    step("Read", "read", "windows/src/views/session.ts", 44),
    step("Grep", "search", "sess-journal|jr-step", 4, { state: "running" }),
  ],
};

const checker: Subagent = {
  id: "e58b0f6c2d914a7b3", type: "general-purpose", description: "Check the relay forwards agent_id", state: "running",
  startedAt: ago(55), endedAt: null, result: null,
  steps: [
    step("Read", "read", "windows/hook/src/main.rs", 47, {
      result: printed(["    // agent_id and agent_type pass through as they are.", "    forward(&payload)?;"], 88),
    }),
    step("Grep", "search", "forwards_agent", 31, { result: printed(["windows/hook/src/tests.rs:204:fn forwards_agent_id_and_type() {"]) }),
  ],
};

const reviewer: Subagent = {
  id: "f60d2a8e15c7039b4", type: "code-reviewer", description: "Review the state changes", state: "running",
  startedAt: T0, endedAt: null, result: null,
  steps: [step("Read", "read", "windows/src/core/state.ts", 0, { state: "running" })],
};

const STATE_PATCH = [
  "@@ -140,6 +140,8 @@ export interface SessionStep {",
  '   permission: "asked" | "allowed" | "denied" | null;',
  "+  /** The subagent this step belongs to; none for the main session. */",
  "+  agentId?: string;",
  "   /** When it started; once it has ended, when it ended. */",
  "   at: number;",
  "@@ -186,6 +188,8 @@ export interface ClaudeSession {",
  "   approval: ApprovalInfo | null;",
  "   question: QuestionInfo | null;",
  "+  /** The subagents it launched, in the order they started. */",
  "+  subagents: Subagent[];",
  "   /** What happened here while another session was in front, until it is looked at. */",
  "   news: PillBadge | null;",
].join("\n");

const HOOKS_PATCH = [
  "@@ -171,7 +171,9 @@",
  " export function handleHook(island: Island, payload: HookPayload) {",
  "   const session = sessionOf(island, payload);",
  "-  const steps = session.steps;",
  "+  // A subagent's events go to its own list, not to the session's top level.",
  "+  const agent = payload.agent_id ? subagentOf(session, payload) : null;",
  "+  const steps = agent?.steps ?? session.steps;",
  "   switch (payload.hook_event_name) {",
].join("\n");

const nook: PreviewSession = {
  session: session("s-nook", "nook", "Show subagents in the sidebar", "working", 4),
  items: [
    item(step("Prompt", "prompt", "Give each subagent its own view, reached from the sidebar, and name the subagent on approval cards.", 372)),
    item(step("Grep", "search", "agent_id|SubagentStart|SubagentStop", 362, {
      result: printed(['windows/src/island/hooks.ts:212:    case "SubagentStart":', 'windows/src/island/hooks.ts:216:    case "SubagentStop":', "windows/hook/src/main.rs:88:    // agent_id and agent_type pass through as they are."]),
    })),
    { kind: "launch", agent: explore },
    item(step("Edit", "edit", "windows/src/core/state.ts", 236, { patch: STATE_PATCH })),
    item(step("Bash", "command", "cargo test -p nook-hook -- --nocapture && cargo clippy --workspace --all-targets -- -D warnings && npx tsc --noEmit -p windows/tsconfig.json", 196, {
      result: printed([
        "running 12 tests",
        "test tests::an_edit_becomes_a_diff_with_its_line_numbers ... ok",
        "test tests::a_command_shows_the_end_of_what_it_printed ... ok",
        "test tests::an_agent_call_keeps_the_id_of_the_agent_it_launched ... ok",
        "",
        "test result: ok. 12 passed; 0 failed; finished in 0.01s",
      ]),
    })),
    { kind: "launch", agent: pusher, when: "five" },
    item(step("Read", "read", "windows/src/views/session.ts", 131, {
      result: printed([
        "function journalEntry(step: SessionStep, typed?: ToType[]): HTMLElement {",
        '  if (step.kind === "prompt") {',
        '    return h("div", { class: "jr jr-asked" }, h("div", { class: "sess-asked", text: step.target ?? "" }));',
        "  }",
      ], 214),
    })),
    item(step("Edit", "edit", "windows/src/island/hooks.ts", 104, { patch: HOOKS_PATCH })),
    { kind: "launch", agent: writer },
    { kind: "launch", agent: finder },
    { kind: "launch", agent: checker },
    item(step("PowerShell", "command", "npx tsc --noEmit", 3, { state: "running" })),
    { kind: "launch", agent: reviewer, when: "new" },
  ],
};

// ── The sessions behind it ────────────────────────────────────────────────────

const api: PreviewSession = {
  session: session("s-api", "acme-api", "Fix the invoice rounding bug", "approval", 95),
  items: [
    item(step("Prompt", "prompt", "Totals are off by a cent on some invoices.", 410)),
    item(step("Read", "read", "src/invoice.ts", 396, { result: printed(["const TVA = 0.196", "", "export function total(items: Item[]) {"], 12) })),
    item(step("Edit", "edit", "src/invoice.ts", 351, {
      patch: ["@@ -18,3 +18,3 @@", "   const sum = items.reduce((s, i) => s + i.price, 0)", "-  return sum * (1 + TVA)", "+  return Math.round(sum * (1 + TVA) * 100) / 100", " }"].join("\n"),
    })),
    item(step("Bash", "command", "npm run build && npm test", 95, { state: "running", permission: "asked" })),
  ],
};

/** A session behind the one on show that has a subagent too: finished, so its row starts collapsed. */
const scout: Subagent = {
  id: "9c41e2b7a05f3d861", type: "Explore", description: "Find the course list queries", state: "done",
  startedAt: ago(226), endedAt: ago(201),
  result: "The list is loaded by `listCourses()` in `src/api/courses.ts`; nothing filters it yet.",
  steps: [
    step("Grep", "search", "listCourses", 222, { result: printed(["src/api/courses.ts:3:export async function listCourses() {", "src/routes/courses.tsx:21:  const courses = await listCourses()"]) }),
    step("Read", "read", "src/api/courses.ts", 210),
  ],
};

const atlas: PreviewSession = {
  session: session("s-atlas", "atlas", "Course search", "thinking", 12),
  items: [
    item(step("Prompt", "prompt", "Add a search to the course list.", 240)),
    item(step("Grep", "search", "courses", 232, { result: printed(["src/routes/courses.tsx:14:export function Courses() {", "src/api/courses.ts:3:export async function listCourses() {"]) })),
    { kind: "launch", agent: scout },
    item(step("Read", "read", "src/routes/courses.tsx", 190)),
  ],
};

const web: PreviewSession = {
  session: session("s-web", "acme-web", "Checkout page", "finished", 620),
  items: [
    item(step("Prompt", "prompt", "Validate the card number as it is typed.", 900)),
    item(step("Edit", "edit", "src/checkout/CardField.tsx", 760, {
      patch: ["@@ -9,2 +9,4 @@", " export function CardField({ value, onChange }: Props) {", "+  // Luhn, checked on every keystroke once the number is long enough.", "+  const valid = value.length < 13 || luhn(value)", "   return ("].join("\n"),
    })),
    item(step("Bash", "command", "npm test -- CardField", 700, { result: printed(["Test Files  1 passed (1)", "     Tests  6 passed (6)"]) })),
    item(step("Done", "reply", "The card number is now checked **as it is typed**, with `luhn()` from the payments package. All six tests pass.", 620)),
  ],
};

// ── A reply with everything the journal's Markdown draws ──────────────────────
// The five alerts, headings under their dividers, code chips, paths (with
// `path:line`), bullets that open on bold words. Some fifty lines: it is shown
// whole, with no button — only a very long reply is cut (`LONG_REPLY`, below).
// dev/claude-preview.ts plays the same reply through the real island.

export const EXAMPLE_REPLY = [
  "# Replies read better now",
  "",
  "The journal draws GitHub's alerts, a real heading hierarchy and the files a reply names. It is still `markdown()` in `windows/src/views/markdown.ts`, and it still builds nodes only: `<b>this</b>` stays text.",
  "",
  "> [!NOTE]",
  "> A reply is shown **whole**. Only a very long one, past about 150 lines, is cut near its end, with a button to the rest.",
  "",
  "## What changed",
  "",
  "- **Alerts**: a quote that opens on `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`",
  "- **Headings** — `#` and `##` stand out, `###` a little, deeper ones are bold body",
  "- **Paths**: `windows/src/views/session.ts:326` opens at its line, and so does [the style sheet](windows/src/style.css:2491)",
  "- **Long replies** are shown whole; a very long one is cut at about 150 lines, between two blocks",
  "- A plain item, with *italics*, a [link](https://example.com/docs) that goes nowhere and `Math.round()` that is no file",
  "",
  "> [!TIP]",
  "> In a session that runs in VS Code or Cursor, a path is a chip that opens the file. In a terminal it stays plain code: `README.md`.",
  "",
  "### Where to look",
  "",
  "1. `windows/src-tauri/src/openfile.rs:98` resolves a path to one existing file",
  "2. `C:\\Users\\nook\\code\\nook\\NOTICE` is absolute, and opens wherever it is",
  "3. A long one may break: `windows/src-tauri/target/release/bundle/nsis/Nook_0.1.0_x64-setup.exe`",
  "",
  "| Alert | Colour | Says |",
  "|---|---|---|",
  "| `NOTE`, `TIP` | blue, green | something to know, a recommendation |",
  "| `IMPORTANT`, `WARNING` | purple, amber | a decision to make, a risk |",
  "| `CAUTION` | red | what not to do |",
  "",
  "## Before you merge",
  "",
  "> [!IMPORTANT]",
  "> Two things need your decision:",
  "> - **Fade**: a session whose reply waits on a decision never leaves the home view until it is read",
  "> - Keep `--goto` for both editors, or add `--reuse-window`?",
  "",
  "> [!WARNING]",
  "> `open_session_file` opens **any** existing file given by its absolute path, not only files of the project.",
  "",
  "> [!CAUTION]",
  "> Do not run `cargo build --release` while the app is running: the build cannot replace `nook.exe`.",
  "",
  "#### The small print",
  "",
  "> A plain quote, with no marker: a rule on its left and quieter words.",
  "> It can run over several lines, and hold `code`.",
  "",
  "```rust",
  "pub fn resolve(cwd: Option<&str>, path: &str) -> Option<PathBuf> {",
  "    let canonical = std::fs::canonicalize(candidate).ok()?;",
  "    on_a_drive(&canonical)",
  "}",
  "```",
  "",
  "Tell me which way to go on the two points above.",
].join("\n");

/**
 * A reply long enough to be cut: some two hundred lines — sections, a table
 * and a code block that the cut must not fall inside — with an IMPORTANT
 * alert near its end, in the part that is left out.
 */
export const LONG_REPLY = [
  "# A full audit of the relay",
  "",
  "Every hook event was traced from Claude Code to the island. This is the whole report: it is long on purpose.",
  "",
  ...Array.from({ length: 14 }, (_, i) => [
    `## Event ${i + 1}: \`${["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop"][i % 7]}\``,
    "",
    `The relay reads the event from its arguments, and the payload from stdin. Run ${i + 1} took ${12 + i} ms from the hook to the island.`,
    "",
    "- **Read**: the payload is parsed once, and nothing of it is kept",
    "- **Sent**: one line over the pipe, then the relay waits for the island's word",
    "- **Answered**: within the hook's own timeout, or Claude Code asks in its own window",
    "",
    "| Step | Time | Note |",
    "|---|---|---|",
    "| Start | 2 ms | process creation |",
    "| Pipe | 1 ms | connect and write |",
    "| Island | 9 ms | the event reaches the page |",
    "",
  ]).flat(),
  "```rust",
  ...Array.from({ length: 18 }, (_, i) => `    step_${i}(&mut state)?;`),
  "```",
  "",
  "## Before you merge",
  "",
  "> [!IMPORTANT]",
  "> One thing needs your decision: keep the 120 s timeout on `PermissionRequest`, or make it a setting?",
  "",
  "Tell me which, and I will finish the change.",
].join("\n");

/** What a subagent came back with: shown whole, like any reply of its length. */
const AUDIT_RESULT = [
  "## Contrast, measured",
  "",
  "Every alert's words were measured on its own wash, over the journal's ground. All of them pass 7:1.",
  "",
  "- **Body on the wash**: 11.2:1 at worst (amber)",
  "- **Title on the wash**: 8.4:1 at worst (purple)",
  "",
  "## Details",
  "",
  "| Alert | Title | Body |",
  "|---|---|---|",
  "| Note | 9.6:1 | 12.1:1 |",
  "| Tip | 10.9:1 | 12.0:1 |",
  "| Important | 8.4:1 | 11.9:1 |",
  "| Warning | 11.0:1 | 11.2:1 |",
  "| Caution | 8.0:1 | 11.6:1 |",
  "",
  "The figures above are made up for the preview.",
  "",
  "> [!WARNING]",
  "> A chip inside an alert sits on two washes at once: `src/style.css:2509` is where its ground is set.",
  "",
  "### Method",
  "",
  "1. Composite the wash over the panel's ground",
  "2. Composite the chip's plate over that",
  "3. Compare with the words' colour",
  "",
  "```js",
  "const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);",
  "for (const alert of document.querySelectorAll('.md-callout')) {",
  "  console.log(alert.className, ratio(luminance(words(alert)), luminance(ground(alert))));",
  "}",
  "```",
  "",
  "Nothing else was changed.",
].join("\n");

const auditor: Subagent = {
  id: "d71a9e4c8b2f60513", type: "general-purpose", description: "Measure the alerts' contrast", state: "done",
  startedAt: ago(196), endedAt: ago(151), result: AUDIT_RESULT,
  steps: [step("Read", "read", "windows/src/style.css", 188, { result: printed([".md-callout {", "  --c: var(--blue);"], 2700) })],
};

/** In VS Code, so the paths of its reply open; and its reply waits on a decision. */
const docs: PreviewSession = {
  session: {
    ...session("s-docs", "nook-docs", "Render replies properly", "finished", 40),
    target: { kind: "vscode", label: "VS Code", tabbed: false },
    decision: true,
  },
  items: [
    item(step("Prompt", "prompt", "Make Claude's replies read better in the journal: alerts, headings, paths I can open.", 300)),
    item(step("Read", "read", "windows/src/views/markdown.ts", 280)),
    { kind: "launch", agent: auditor },
    item(step("Edit", "edit", "windows/src/views/markdown.ts", 120, {
      patch: ["@@ -31,2 +31,3 @@", " const HEADING = /^(#{1,6})\\s+(.*)$/;", "+const QUOTE = /^\\s{0,3}>\\s?(.*)$/;", " const ITEM = /^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$/;"].join("\n"),
    })),
    item(step("Done", "reply", EXAMPLE_REPLY, 40)),
  ],
};
/** The session with the example reply, and its subagent with a long result. */
export const EXAMPLE_ID = docs.session.id;
export const EXAMPLE_AGENT = auditor.id;

export const SESSIONS: PreviewSession[] = [nook, api, atlas, web, docs];
/** The session the scenarios are about. */
export const MAIN_ID = nook.session.id;
export const LONG_FOLDER = "client-with-an-unreasonably-long-repository-name-2026";

/** The subagents the preview's controls open by name. */
export const SHOWN = { running: writer.id, finished: explore.id, asking: checker.id };

/** The "long task title" control: what these subagents were launched to do, at length. */
export const LONG_TITLES: Record<string, string> = {
  [writer.id]: "Write a note that explains how hook events from subagents are routed, attributed and named on approval cards, with one worked example per event",
  [checker.id]: "Check that the relay forwards agent_id and agent_type on every tool event, including PermissionRequest, without dropping them",
};

// ── When the session ends ─────────────────────────────────────────────────────

/** What the subagents still running said last, once the session has ended. */
export const ENDED_RESULTS: Record<string, string> = {
  [writer.id]: "The note is written: `plans/notes/subagents.md`, four sections, one example per event.",
  [finder.id]: "Two renderers draw a journal line: `journalEntry()` in `session.ts` and `stepPreview()` in `step.ts`.",
  [checker.id]: "The relay forwards `agent_id` and `agent_type` untouched; `forwards_agent_id_and_type` passes.",
  [reviewer.id]: "No problem found in the state changes.",
};

/** How long before "now" the session's turn ended, in the scenario where it has. */
export const ENDED_AGO = 1000;

export const ENDED_REPLY: SessionStep = step(
  "Done", "reply",
  "Each subagent now has **its own view**, reached from the sidebar or from the line where it was launched, and approval cards name the subagent that asks.",
  0,
);

// ── What the cards ask ────────────────────────────────────────────────────────

/** A permission request, with who asks: a subagent by its id, or (null) the main session. */
export interface Request {
  agentId: string | null;
  tool: string;
  kind: StepKind;
  target: string;
}

/** The request of the default scenario: the subagent that checks the relay wants to run its test. */
export const REQUEST_SUBAGENT: Request = { agentId: checker.id, tool: "Bash", kind: "command", target: "cargo test -p nook-hook forwards_agent" };
/** The request waiting behind it, when two subagents ask at once. */
export const REQUEST_QUEUED: Request = { agentId: finder.id, tool: "Bash", kind: "command", target: 'rg -n "jr-step" windows/src' };
export const REQUEST_MAIN: Request = { agentId: null, tool: "Bash", kind: "command", target: "git commit -m \"Show subagents in the sidebar\"" };

/** The subagent that asks the question. */
export const ASKED_BY = finder.id;
export const QUESTION: Question = {
  question: "Should a finished subagent's result open its whole last message?",
  header: "Journal",
  multiSelect: false,
  options: [
    { label: "Yes, in its view", description: "The subagent's own view ends with everything it said last." },
    { label: "No", description: "One line is enough: the rest is in Claude Code." },
    { label: "Large panel only", description: "The whole message shows only when the panel is expanded." },
  ],
};
