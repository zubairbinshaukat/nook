// Dev harness: the real island following a made-up Claude Code session, in a
// plain browser — the hook events a session sends, played through the island's
// own handler. Not part of the app bundle. `npm run dev`, then
// /dev/claude-preview.html.
//
// It is also a SCREENSHOT STAGE: the island on a made-up Windows desktop
// (dev/stage/), steered by the URL. Press S (or `) or the corner button for the
// sidebar; every control there writes the URL, so a state is a link. Full table
// and copy-paste links: dev/README.md. Unknown keys are ignored, invalid values
// fall back to their default.
//
//   Stage:    scene=desktop|browser|editor|terminal|none   theme=dark|light   taskbar=bottom|top|hidden
//             dock=top|bottom|left|right   time=HH:MM (10:09)   date=text   bg=#rrggbb|transparent (scene=none)
//             w=, h=  the display's size in px (default: the window)   scale=1.25 (alias zoom)  display scale
//             seed=n  the made-up CPU/GPU numbers      motion=reduce|full
//   Tooling:  ui=1 opens the sidebar   toggle=0 hides its corner button
//             shot=1 capture mode: no sidebar/button/cursor/hover, springs jumped, numbers frozen; sets
//             <html data-ready="1"> and window.__shotReady when settled (shot wins over ui)
//   Scenario: view=overview|session|question|approval|finished   home=0|1|4|8|9|needs|long   fold=1   tab=shelf
//             target=claude|vscode|cursor|wt|powershell|cmd|none   usage=   metrics=   subs=   subagents=1 ...
//             (each is described where it is read, below; the sidebar lists the usual ones)

import "../src/style.css";
import { CLAUDE_ID, QUIET_MS, State, subagentName, subagentTook, type Usage } from "../src/core/state";
import { Display } from "../src/core/layout";
import { handleHook, tellModel, type HookPayload } from "../src/island/hooks";
import { Island } from "../src/island/island";
import { Sound } from "../src/core/sound";
import { EXAMPLE_REPLY, LONG_REPLY } from "./preview-b/session-data";
import { checkAutoHide, checkShelfSwipe, checkSlots, checkSwipe, checkUsage, checkWake } from "./preview-b/island-check";
import { finishStage, installStage, placeIsland, rng } from "./stage";

const params = new URLSearchParams(location.search);
// The stage's layers, before the island: it sizes itself by the window it finds.
const stage = installStage(document.getElementById("root")!, params);
const view = params.get("view") ?? "overview";

const SESSION = "3f2a9c1e-preview";
const CWD = "C:\\Users\\nook\\code\\nook";
// Where a session runs, as Nook says it on each event (src-tauri/src/target.rs):
// in the app it is worked out from what the relay reports, here it is made up.
// `target` picks the first session's: claude (the default), vscode, cursor, wt,
// powershell, cmd — or none, a session nothing says the place of, which has no ↗.
const TARGETS = {
  claude: { entrypoint: "claude-desktop", target: { kind: "claude", label: "Claude", tabbed: false } },
  vscode: { entrypoint: "claude-vscode", target: { kind: "vscode", pid: 21004, label: "VS Code", tabbed: false } },
  cursor: { entrypoint: "claude-vscode", target: { kind: "cursor", pid: 18212, label: "Cursor", tabbed: false } },
  wt: { entrypoint: "cli", target: { kind: "terminal", pid: 20648, label: "Windows Terminal", tabbed: true } },
  powershell: { entrypoint: "cli", target: { kind: "terminal", pid: 22860, label: "PowerShell", tabbed: false } },
  cmd: { entrypoint: "cli", target: { kind: "terminal", pid: 9120, label: "Command Prompt", tabbed: false } },
  none: { entrypoint: "cli", target: { kind: "unknown", label: "", tabbed: false } },
} satisfies Record<string, Pick<HookPayload, "entrypoint" | "target">>;
const targetOf = (name: string | null) => TARGETS[(name && name in TARGETS ? name : "claude") as keyof typeof TARGETS];
const base: HookPayload = {
  session_id: SESSION, cwd: CWD, session_title: "Answer questions from the island", ...targetOf(params.get("target")),
};

State.loadIntegrationTasks();
State.setFocus(CLAUDE_ID);
// Pinned, so the island doesn't fold away while it's being looked at.
State.isPinned = true;

// Every sound the island asks for, by name and in order: a page has no way to
// hear one, and a check reads this instead (`sounds` in the console).
const sounds: string[] = [];
const playSound = Sound.play.bind(Sound);
Sound.play = (...args: Parameters<typeof Sound.play>) => {
  sounds.push(String(args[0]));
  return playSound(...args);
};

const island = new Island(document.getElementById("root")!);
placeIsland(stage, island, Number(params.get("screen")) || null);
const hook = (payload: HookPayload) => handleHook(island, { ...base, ...payload });
// From the console: `hook({ hook_event_name: "Stop" })` plays any event by hand,
// and `island.launch()` the greeting.
Object.assign(window, { hook, island });

const edit = (file: string, patch: string, created = false) => {
  const lines = patch.split("\n");
  const tool_name = created ? "Write" : "Edit";
  const tool_input = { file_path: `${CWD}\\${file}` };
  hook({ hook_event_name: "PreToolUse", tool_name, tool_input });
  hook({
    hook_event_name: "PostToolUse", tool_name, tool_input,
    change: {
      patch: `${patch}\n`, created, truncated: false,
      additions: lines.filter((l) => l.startsWith("+")).length,
      deletions: lines.filter((l) => l.startsWith("-")).length,
    },
  });
};

// The session says which model it runs on, as Claude Code does on SessionStart: here by its id alone.
hook({ hook_event_name: "SessionStart", model: "claude-opus-5-5" });
hook({ hook_event_name: "UserPromptSubmit", prompt: "Answer Claude's questions from the island" });
edit("windows\\src\\island\\hooks.ts", [
  "@@ -228,9 +228,14 @@",
  '       const tool = payload.tool_name ?? "Tool";',
  "       const input = payload.tool_input ?? {};",
  "-      State.pendingApproval = {",
  "-        requestId,",
  '-        sessionId: payload.session_id ?? "",',
  "-      };",
  '+      const sessionId = payload.session_id ?? "";',
  "+      // Claude's question tool asks for permission like any other.",
  "+      const questions = tool === QUESTION_TOOL ? questionsOf(input) : null;",
  "+      if (questions) State.pendingQuestion = { requestId, sessionId, questions };",
  "+      else State.pendingApproval = { requestId, sessionId, tool, command: approvalTarget(tool, input) };",
  "       if (requestId) void Bridge.approvalAck(requestId);",
].join("\n"));
edit("windows\\src\\views\\session.ts", [
  "@@ -0,0 +1,6 @@",
  "+// The session panel — what a Claude Code session did, read from the island.",
  "+",
  '+import { h, svg, clear, dot } from "./dom";',
  "+",
  "+/** The file whose diff is on screen; null is the list. */",
  "+let open: string | null = null;",
].join("\n"), true);
edit("windows\\hook\\src\\main.rs", [
  "@@ -66,8 +66,10 @@ fn main() {",
  '-    let waits_for_answer = event == "PermissionRequest";',
  "+    // Only a permission request waits for a human.",
  '+    let waits_for_answer = matches!(event.as_str(), "PermissionRequest" | "Stop");',
  '     let budget = if event == "PermissionRequest" { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };',
].join("\n"));
edit("windows\\src\\island\\hooks.ts", [
  "@@ -176,6 +181,8 @@",
  '     case "PostToolUse":',
  "+      if (answeredElsewhere(payload)) dropPending(island);",
  "+      recordChange(payload);",
  '       State.updateTask(CLAUDE_ID, "working");',
  "       break;",
].join("\n"));
edit("windows\\README.md", ["@@ -40,3 +40,4 @@", " ## Claude Code", "+Answer Claude's questions from the island.", " "].join("\n"));
const TESTS = [
  "running 12 tests",
  "test tests::an_edit_becomes_a_diff_with_its_line_numbers ... ok",
  "test tests::a_command_shows_the_end_of_what_it_printed ... ok",
  "test tests::a_file_read_shows_its_first_lines_with_their_numbers ... ok",
  "",
  "test result: ok. 12 passed; 0 failed; finished in 0.01s",
].join("\n");
const run = (command: string, printed: string | null) => {
  const tool_input = { command };
  hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input });
  if (printed != null) {
    hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input, result: { text: printed, start: null, truncated: false, tail: true } });
  }
};
const read = (file: string, start: number, text: string) => {
  const tool_input = { file_path: `${CWD}\\${file}` };
  hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input });
  hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input, result: { text, start, truncated: true, tail: false } });
};
// `step`: where the session is at — reading, running its tests, or (the default) done running them.
const at = params.get("step");
if (at === "read") {
  read("windows\\src\\island\\hooks.ts", 96, [
    "/** The session an event comes from, told what the event says of it. */",
    "function sessionOf(island: Island, payload: HookPayload): ClaudeSession {",
    "  const id = payload.session_id || ANONYMOUS;",
    "  let session = State.sessions.find((s) => s.id === id);",
    "  if (!session) {",
    "    session = newSession(id);",
  ].join("\n"));
} else {
  run("cargo test -p nook-hook", at === "run" ? null : TESTS);
}

// `sessions`: three more conversations going on behind the first, each
// somewhere else — one at work in a tab of Windows Terminal, one that has just
// finished in the Claude app, one in VS Code — so each has its own ↗.
const second: HookPayload = {
  session_id: "8b1d04e7-preview", cwd: "C:\\Users\\nook\\code\\atlas", session_title: "Course search", ...TARGETS.wt,
};
const third: HookPayload = {
  session_id: "c47e9a02-preview", cwd: CWD, session_title: "Fix the blurry island", ...TARGETS.claude,
};
const fourth: HookPayload = {
  session_id: "d5a1c3f9-preview", cwd: "C:\\Users\\nook\\code\\site", session_title: "Landing page copy", ...TARGETS.vscode,
};
if (params.has("sessions")) {
  hook({ ...fourth, hook_event_name: "UserPromptSubmit", prompt: "Tighten the landing page copy" });
  hook({ ...fourth, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "C:\\Users\\nook\\code\\site\\index.html" } });
  hook({ ...second, hook_event_name: "UserPromptSubmit", prompt: "Add a search to the course list" });
  // This one's model comes the other way: from the status line's relay, with a name of its own.
  tellModel({ sessionId: second.session_id, model: { id: "claude-sonnet-4-5", displayName: "Sonnet 4.5" } });
  hook({ ...second, hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "courses" } });
  hook({ ...third, hook_event_name: "UserPromptSubmit", prompt: "The island is blurry while it resizes" });
  hook({ ...third, hook_event_name: "Stop", last_message: "The island now stays on a whole pixel while it resizes." });
}

// `subagents`: the session launches four subagents, as Claude Code 2.1.288 says
// it (plans/subagents-plan.md): one that has finished, two at work, and one
// asking for permission. With `ids=missing`, as an older Claude Code would:
// tool events that do not say which subagent they come from. With `queued`, a
// second subagent asks while the first one's request is on the card. With
// `ask=question`, a subagent asks a question instead. With `stop=early`, the
// session's own turn stops while its subagents still run — it must stay at
// work; with `stop=real`, they all stop and the turn really ends.
interface FakeAgent {
  id: string;
  type: string;
  description: string;
  /** The model its launch says it runs on (`launched_model`); none for one whose launch does not say. */
  model?: string;
}
const AGENTS = {
  explore: { id: "a1f08c03f03bd405d", type: "Explore", description: "Map where hook events are routed" },
  writer: { id: "b27c5d1e90aa3417f", type: "general-purpose", description: "Write a note", model: "claude-haiku-4-5-20251001" },
  finder: { id: "c93e77b2046d18ac2", type: "Explore", description: "Find every journal renderer" },
  checker: { id: "e58b0f6c2d914a7b3", type: "general-purpose", description: "Check the relay forwards agent_id" },
} satisfies Record<string, FakeAgent>;
const noIds = params.get("ids") === "missing";
const launched: FakeAgent[] = [];
const stopped = new Set<string>();

/** The session's `Agent` call, the subagent's start, and the call coming back with the id of what it launched. */
const launch = (agent: FakeAgent) => {
  const tool_input = { description: agent.description, prompt: `${agent.description}, and report back.`, subagent_type: agent.type };
  hook({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input });
  hook({ hook_event_name: "SubagentStart", agent_id: agent.id, agent_type: agent.type });
  hook({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input, ...(noIds ? {} : { launched_agent: agent.id, launched_model: agent.model }) });
  launched.push(agent);
};
/** An event fired from inside a subagent: it says whose it is, unless this Claude Code does not. */
const inside = (agent: FakeAgent, payload: HookPayload) => hook(noIds ? payload : { ...payload, agent_id: agent.id, agent_type: agent.type });
/** A tool a subagent ran, with what it gave back — or, with `null`, still running. */
const did = (agent: FakeAgent, tool_name: string, tool_input: Record<string, unknown>, text: string | null = "", start: number | null = null) => {
  inside(agent, { hook_event_name: "PreToolUse", tool_name, tool_input });
  if (text == null) return;
  inside(agent, { hook_event_name: "PostToolUse", tool_name, tool_input, ...(text ? { result: { text, start, truncated: false, tail: start == null } } : {}) });
};
/** What a Stop and a SubagentStop list as still in the background. */
const backgroundTasks = () =>
  noIds ? undefined : launched.map((a) => ({ id: a.id, type: "subagent", status: stopped.has(a.id) ? "completed" : "running", description: a.description, agent_type: a.type }));
const stopAgent = (agent: FakeAgent, last_message: string) => {
  // As Claude Code does: a subagent still lists itself as running on its own stop.
  const background_tasks = backgroundTasks();
  stopped.add(agent.id);
  hook({ hook_event_name: "SubagentStop", agent_id: agent.id, agent_type: agent.type, last_message, background_tasks });
};
/** The session's own turn stops while subagents still run: not the end. */
const EARLY_REPLY = "Three subagents are at work: the note, the journal renderers and the relay check. I will sum up when they are back.";
const earlyStop = () => hook({ hook_event_name: "Stop", last_message: EARLY_REPLY, background_tasks: backgroundTasks() });
/** Every subagent comes back, and the turn really ends. */
const realStop = () => {
  const said: Record<string, string> = {
    [AGENTS.writer.id]: "The note is written: `plans/notes/subagents.md`, four sections, one example per event.",
    [AGENTS.finder.id]: "Two renderers draw a journal line: `journalEntry()` in `session.ts` and `stepPreview()` in `step.ts`.",
    [AGENTS.checker.id]: "The relay forwards `agent_id` and `agent_type` untouched; `forwards_agent_id_and_type` passes.",
  };
  for (const agent of launched) if (!stopped.has(agent.id)) stopAgent(agent, said[agent.id] ?? "Done.");
  // Claude Code feeds itself what they came back with, and ends its turn on it.
  hook({ hook_event_name: "UserPromptSubmit", prompt: "<task-notification> <task-id>e58b0f6c2d914a7b3</task-id> </task-notification>" });
  hook({
    hook_event_name: "Stop", background_tasks: noIds ? undefined : [],
    last_message: "Each subagent now has **its own view**, reached from the sidebar or from the line where it was launched, and approval cards name the subagent that asks.",
  });
};
const asks = { tool_name: "Bash", tool_input: { command: "cargo test -p nook-hook forwards_agent" } };
if (params.has("subagents")) {
  hook({ hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "agent_id|SubagentStart|SubagentStop" } });
  hook({ hook_event_name: "PostToolUse", tool_name: "Grep", tool_input: { pattern: "agent_id|SubagentStart|SubagentStop" } });
  launch(AGENTS.explore);
  did(AGENTS.explore, "Grep", { pattern: "handleHook|sessionOf" }, "windows/src/island/hooks.ts:96:function sessionOf(island: Island, payload: HookPayload): ClaudeSession {");
  did(AGENTS.explore, "Read", { file_path: `${CWD}\\windows\\src\\island\\hooks.ts` }, "export function handleHook(island: Island, payload: HookPayload) {\n  const session = sessionOf(island, payload);", 171);
  did(AGENTS.explore, "Bash", { command: 'rg -n "tool_response" windows/hook/src' }, "windows/hook/src/main.rs:142:    // tool_response is dropped before forwarding.\nwindows/hook/src/main.rs:143:    payload.remove(\"tool_response\");");
  stopAgent(AGENTS.explore, "Events are routed in `handleHook()`. Three places need `agent_id`: `sessionOf`, `recordStep` and the `PermissionRequest` branch.\n\nThe relay already passes `agent_id` and `agent_type` through; it drops `tool_response`, so the `Agent` call's `agentId` has to be lifted first.");
  edit("windows\\src\\core\\state.ts", [
    "@@ -140,6 +140,8 @@ export interface SessionStep {",
    '   permission: "asked" | "allowed" | "denied" | null;',
    "+  /** The subagent this step belongs to; none for the main session. */",
    "+  agentId?: string;",
    "   /** When it started; once it has ended, when it ended. */",
    "   at: number;",
  ].join("\n"));
  launch(AGENTS.writer);
  launch(AGENTS.finder);
  launch(AGENTS.checker);
  did(AGENTS.writer, "Read", { file_path: `${CWD}\\plans\\subagents-plan.md` }, "# Subagents plan\n\nStatus: **plan + prototype only.**", 1);
  did(AGENTS.writer, "Grep", { pattern: "SubagentStop" }, 'windows/src/island/hooks.ts:216:    case "SubagentStop":');
  did(AGENTS.writer, "Write", { file_path: `${CWD}\\plans\\notes\\subagents.md` }, null);
  did(AGENTS.finder, "Grep", { pattern: "journalEntry|stepPreview" }, "windows/src/views/session.ts:214:function journalEntry(step: SessionStep, typed?: ToType[]): HTMLElement {");
  did(AGENTS.finder, "Read", { file_path: `${CWD}\\windows\\src\\views\\session.ts` });
  did(AGENTS.finder, "Grep", { pattern: "sess-journal|jr-step" }, null);
  did(AGENTS.checker, "Read", { file_path: `${CWD}\\windows\\hook\\src\\main.rs` }, "    // agent_id and agent_type pass through as they are.\n    forward(&payload)?;", 88);
  did(AGENTS.checker, "Grep", { pattern: "forwards_agent" }, "windows/hook/src/tests.rs:204:fn forwards_agent_id_and_type() {");
  hook({ hook_event_name: "PreToolUse", tool_name: "PowerShell", tool_input: { command: "npx tsc --noEmit" } });
  // One subagent asks: a permission, or a question. A second one can ask behind it.
  if (params.get("ask") === "question") {
    const ask = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Should a finished subagent's result open its whole last message?", header: "Journal", multiSelect: false,
          options: [
            { label: "Yes, in its view", description: "The subagent's own view ends with everything it said last." },
            { label: "No", description: "One line is enough: the rest is in Claude Code." },
          ],
        }],
      },
    };
    inside(AGENTS.finder, { hook_event_name: "PreToolUse", ...ask });
    inside(AGENTS.finder, { hook_event_name: "PermissionRequest", request_id: "preview-sub-q", ...ask });
  } else if (params.get("ask") !== "none") {
    inside(AGENTS.checker, { hook_event_name: "PreToolUse", ...asks });
    inside(AGENTS.checker, { hook_event_name: "PermissionRequest", request_id: "preview-sub-1", ...asks });
  }
  if (params.has("queued")) {
    const second = { tool_name: "Bash", tool_input: { command: 'rg -n "jr-step" windows/src' } };
    inside(AGENTS.finder, { hook_event_name: "PreToolUse", ...second });
    inside(AGENTS.finder, { hook_event_name: "PermissionRequest", request_id: "preview-sub-2", ...second });
  }
  if (params.get("stop") === "early") earlyStop();
  if (params.get("stop") === "real") realStop();
  // `stop=silent`: its own turn stops with nothing said while subagents run — nobody is told anything.
  if (params.get("stop") === "silent") hook({ hook_event_name: "Stop", background_tasks: backgroundTasks() });
  // `stop=both`: it replies while they run (told once), then the turn really ends on something new (told again).
  if (params.get("stop") === "both") {
    earlyStop();
    realStop();
  }
  // `stop=same`: it replies while they run, and the turn's real end says nothing new: told once, not twice.
  if (params.get("stop") === "same") {
    earlyStop();
    for (const agent of launched) if (!stopped.has(agent.id)) stopAgent(agent, "Done.");
    hook({ hook_event_name: "Stop", background_tasks: noIds ? undefined : [], last_message: EARLY_REPLY });
  }
}
// `phantoms`: what a real session sends that is no subagent of its own, as
// Claude Code 2.1.288 does it. Its side agents — the progress line of a
// background agent every half minute, a recap, a prompt suggestion — fire
// SubagentStop with an id nothing launched and an empty `agent_type`, and no
// SubagentStart; the island must list the subagents the session launched and
// nothing else, as Claude Code's own count does.
//   phantoms=one         one real general-purpose subagent, four typeless stop/start pairs → 1
//   phantoms=two         two real ones in parallel, typeless events between theirs → 2
//   phantoms=names       real ones nothing described: by type and the start of their task, by type alone, as "Subagent"
//   phantoms=foreground  a subagent the `Agent` call waited for: the call comes back after it has stopped → 1, timed
//   phantoms=late        Nook started mid-session: a stop for one it never saw launched → 0, then its call coming back → 1, "done" with no time
//   phantoms=resumed     one that stopped and runs a tool again → 1, running
let ghosts = 0;
/** A side agent of Claude Code's own stops — and, with `start`, had started: neither says a type. */
const ghost = (start = false) => {
  const agent_id = `ghost${String(++ghosts).padStart(12, "0")}`;
  if (start) hook({ hook_event_name: "SubagentStart", agent_id, agent_type: "" });
  hook({ hook_event_name: "SubagentStop", agent_id, agent_type: "", last_message: "Reading hooks.ts", background_tasks: backgroundTasks() });
};
/** The `Agent` call alone, with what it says of the subagent — a description, or none. */
const call = (subagent_type: string | undefined, description: string | undefined, prompt: string) => ({
  tool_name: "Agent", tool_input: { ...(subagent_type ? { subagent_type } : {}), ...(description ? { description } : {}), prompt },
});
const PHANTOMS: Record<string, () => void> = {
  one() {
    launch(AGENTS.writer);
    did(AGENTS.writer, "Read", { file_path: `${CWD}\\plans\\subagents-plan.md` }, "# Subagents plan", 1);
    for (let i = 0; i < 4; i++) ghost(true);
    did(AGENTS.writer, "Grep", { pattern: "SubagentStop" }, null);
  },
  two() {
    launch(AGENTS.writer);
    ghost();
    launch(AGENTS.finder);
    did(AGENTS.writer, "Read", { file_path: `${CWD}\\plans\\subagents-plan.md` }, "# Subagents plan", 1);
    ghost(true);
    did(AGENTS.finder, "Grep", { pattern: "journalEntry" }, null);
    ghost();
    // A side agent's own tool event, were it to send one, is nobody's step.
    hook({ hook_event_name: "PreToolUse", agent_id: "ghost-tool", agent_type: "", tool_name: "Read", tool_input: { file_path: `${CWD}\\README.md` } });
    earlyStop();
    ghost();
  },
  names() {
    // No description: its type and the start of what it was asked.
    const first = call("Explore", undefined, "Find every place where the island reads agent_type, and say which of them fall back to a made-up name.\nReport file and line.");
    hook({ hook_event_name: "PreToolUse", ...first });
    hook({ hook_event_name: "SubagentStart", agent_id: "name-task", agent_type: "Explore" });
    hook({ hook_event_name: "PostToolUse", ...first, launched_agent: "name-task", launched_async: true });
    // A start that says its type and answers no call: its type alone.
    hook({ hook_event_name: "SubagentStart", agent_id: "name-type", agent_type: "general-purpose" });
    // An older Claude Code: a call with no type, a start with none — "Subagent" and the start of its task.
    const bare = call(undefined, undefined, "Check that the relay still forwards every field.");
    hook({ hook_event_name: "PreToolUse", ...bare });
    hook({ hook_event_name: "SubagentStart", agent_id: "name-none" });
    ghost();
  },
  foreground() {
    const run = call("Explore", "Map where hook events are routed", "Map where hook events are routed, and report back.");
    hook({ hook_event_name: "PreToolUse", ...run });
    hook({ hook_event_name: "SubagentStart", agent_id: AGENTS.explore.id, agent_type: "Explore" });
    did(AGENTS.explore, "Grep", { pattern: "handleHook" }, "windows/src/island/hooks.ts:729:export function handleHook(");
    ghost();
    did(AGENTS.explore, "SubagentHandback", { message: "Events are routed in handleHook()." }, "");
    // It stops first; the call that waited for it comes back after, naming it.
    hook({ hook_event_name: "SubagentStop", agent_id: AGENTS.explore.id, agent_type: "Explore", last_message: "Events are routed in `handleHook()`." });
    hook({ hook_event_name: "PostToolUse", ...run, launched_agent: AGENTS.explore.id, launched_async: false });
    hook({ hook_event_name: "Stop", last_message: "The routing is in `handleHook()`." });
  },
  late() {
    // Its start, and the call that launched it, went by before Nook was looking.
    hook({ hook_event_name: "SubagentStop", agent_id: "late-one", agent_type: "Explore", last_message: "Done." });
    const run = call("Explore", "Count the hook events", "Count the hook events, and report back.");
    hook({ hook_event_name: "PostToolUse", ...run, launched_agent: "late-one", launched_async: false });
    // One in the background that Claude Code still lists, with all there is to say of it: taken from the list.
    hook({
      hook_event_name: "Stop", last_message: "One agent is still at work.",
      background_tasks: [
        { id: "late-two", type: "subagent", status: "running", description: "Write the release notes", agent_type: "general-purpose" },
        { id: "late-shell", type: "shell", status: "running", description: "npm run dev" },
        { id: "late-typeless", type: "subagent", status: "running", description: "", agent_type: "" },
      ],
    });
  },
  resumed() {
    launch(AGENTS.writer);
    did(AGENTS.writer, "Read", { file_path: `${CWD}\\plans\\subagents-plan.md` }, "# Subagents plan", 1);
    hook({ hook_event_name: "SubagentStop", agent_id: AGENTS.writer.id, agent_type: AGENTS.writer.type, last_message: "Half way." });
    hook({ hook_event_name: "SubagentStop", agent_id: AGENTS.writer.id, agent_type: AGENTS.writer.type });
    did(AGENTS.writer, "Write", { file_path: `${CWD}\\plans\\notes\\subagents.md` }, null);
  },
};
PHANTOMS[params.get("phantoms") ?? ""]?.();

/** Every subagent the island lists, as it names it and says how it stands: what a check reads. */
const subagents = () =>
  State.sessions.flatMap((s) => s.subagents.map((a) => ({
    id: a.id, name: subagentName(a), type: a.type, state: a.state, timed: a.timed, took: subagentTook(a), steps: a.steps.length,
  })));

/**
 * Fast-forwards a session's silence: it was last heard from so long ago that
 * "No activity for 10 min" is due in `seconds` (0: now). `quiet=<seconds>` does
 * it on load. Any event after that clears it.
 */
const quietIn = (seconds = 0, sessionId = State.frontId) => {
  const session = State.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  session.heardAt = Date.now() - QUIET_MS + seconds * 1000;
  State.notify();
};
if (params.has("quiet")) window.setTimeout(() => quietIn(Number(params.get("quiet")) || 0), 0);

// From the console, or a page that drives this one: each of them by hand.
Object.assign(window, { AGENTS, launch, inside, did, stopAgent, earlyStop, realStop, State, ghost, subagents, quietIn, sounds });

const option = (label: string, description: string) => ({ label, description });
const engine = {
  question: "Which engine for the course search?",
  header: "Search",
  multiSelect: params.has("multi"),
  options: [
    option("Postgres full-text", "Already in the stack: no new service, good enough for a few thousand courses."),
    option("Meilisearch", "Typo-tolerant and fast, one more container to run."),
    option("Algolia", "Hosted, the best relevance out of the box, paid past the free tier."),
  ],
};
const more = [
  {
    question: "Index the course descriptions too, or only the titles?", header: "Scope", multiSelect: false,
    options: [option("Titles only", "Smaller index, exact matches."), option("Titles and descriptions", "Finds more, ranks titles first.")],
  },
  {
    question: "Ship it behind a flag?", header: "Rollout", multiSelect: false,
    options: [option("Yes", "Off by default, switched on per account."), option("No", "On for everyone at the next release.")],
  },
];

// `asked`: earlier in the turn, a question that was answered and a command that had to ask first.
if (params.has("asked")) {
  const ask = { tool_name: "AskUserQuestion", tool_input: { questions: [more[0]] } };
  hook({ hook_event_name: "PreToolUse", ...ask });
  hook({ hook_event_name: "PostToolUse", ...ask, answers: { [more[0].question]: "Titles and descriptions" } });
  const push = { tool_name: "Bash", tool_input: { command: "git push origin windows-claude-desktop" } };
  hook({ hook_event_name: "PreToolUse", ...push });
  hook({ hook_event_name: "PermissionRequest", request_id: "preview-0", ...push });
  hook({ hook_event_name: "PostToolUse", ...push, result: { text: ["To github.com:nook/nook.git", "   11bd082..848ca62  windows-claude-desktop -> windows-claude-desktop"].join("\n"), start: null, truncated: false, tail: true } });
  hook({ hook_event_name: "SubagentStart" });
}

if (params.has("subagents") && (view === "question" || view === "approval")) {
  // The subagent's request is on the card already: nothing more to ask.
} else if (view === "question") {
  hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: params.has("many") ? [engine, ...more] : [engine] } });
  hook({
    hook_event_name: "PermissionRequest", request_id: "preview-1", tool_name: "AskUserQuestion",
    tool_input: { questions: params.has("many") ? [engine, ...more] : [engine] },
  });
  // A second session asks while the first one's question is on the card: it waits its turn.
  if (params.has("sessions")) {
    hook({ ...second, hook_event_name: "PermissionRequest", request_id: "preview-3", tool_name: "AskUserQuestion", tool_input: { questions: [more[0]] } });
  }
} else if (view === "approval") {
  hook(params.has("diff")
    ? {
        hook_event_name: "PermissionRequest", request_id: "preview-2", tool_name: "Edit",
        tool_input: { file_path: `${CWD}\\windows\\src\\core\\layout.ts` },
        proposal: {
          created: false, truncated: false, additions: 5, deletions: 1,
          patch: [
            "@@ -118,9 +118,13 @@",
            " export const NEWS_LINE = 28;",
            " ",
            " export function islandSize(",
            "   mode: IslandMode,",
            "   view: IslandViewName,",
            "   chatCount = 0,",
            "-  news = false,",
            "+  news = false,",
            "+  proposal = false,",
            " ): { w: number; h: number } {",
            "   switch (mode) {",
            '     case "hidden":',
            "+      // No notch to hide inside on a PC.",
            "+      return { w: NOTCH_W, h: 0 };",
            '+    case "compact":',
          ].join("\n"),
        },
      }
    : { hook_event_name: "PermissionRequest", request_id: "preview-2", tool_name: "Bash", tool_input: { command: "cargo test -p nook-hook" } });
} else if (view === "finished" || params.has("answered") || params.has("reply")) {
  // The turn ends on what Claude said. `reply`: on a reply with everything the journal's Markdown
  // draws — the five alerts, headings, chips, paths; some fifty lines, shown whole — and an
  // IMPORTANT alert in it, so the session says "Needs your decision". `reply=long`: a reply of
  // some two hundred lines, cut near its end, with its decision in the part left out. With `target=vscode` or
  // `cursor` its paths are chips that open (nothing opens from a browser: they say "not found");
  // with `target=wt` they stay code.
  hook({
    hook_event_name: "Stop",
    last_message: params.get("reply") === "long" ? LONG_REPLY : params.has("reply") ? EXAMPLE_REPLY : [
      "The question card now answers for real: the answer goes back on the permission request, in the tool's own input.",
      "## What changed",
      "- **Question card**: answers go back in the tool's own `answers`\n- Skip tells Claude the question was *skipped*\n  and it carries on without",
      "| Function | State |\n|---|---|\n| One choice | Checked |\n| Several choices | Checked, with `Send` |",
      "```rust\nfn reply_json(answer: &str) -> Option<String> {\n    decision_json(answer.trim())\n}\n```",
      "Do you want the README updated too?",
    ].join("\n\n"),
  });
  if (view === "session") island.alert("session");
} else if (view === "session") {
  if (params.has("idle")) {
    State.session.state = "idle";
    State.present();
  }
  island.alert("session");
  if (params.has("list")) {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".session-view .sess-files")?.click();
      if (params.has("file")) requestAnimationFrame(() => document.querySelector<HTMLElement>(".session-view .gh-row")?.click());
    });
  }
  // `live`: an edit lands while the panel is open, again every few seconds.
  if (params.has("live")) {
    const write = () => {
      hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: `${CWD}\\src\\invoice.ts` } });
      hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: `${CWD}\\src\\invoice.ts` } });
      edit("src\\invoice.ts", [
        "@@ -10,8 +10,9 @@",
        " import { Item } from './types'",
        " ",
        "-const TVA = 0.196",
        "+// The rate changed in 2014.",
        "+const TVA = 0.2",
        " ",
        " export function total(items: Item[]) {",
        "   const sum = items.reduce((s, i) => s + i.price, 0)",
        "   return sum * (1 + TVA)",
        " }",
      ].join("\n"));
      hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } });
    };
    window.setTimeout(write, 1200);
    window.setInterval(write, 6000);
  }
} else {
  island.alert("overview");
}

// ── The home view, the folded island, and what feeds them ─────────────────────
// None of the events below reach a plain browser, so they are made up here.
//
//   home=0|1|4|8|9|needs|long   that many sessions (the same eight as dev/home-preview), all eight asking,
//                               or four with a very long folder name among them; hooks=0: hooks not installed
//   subs=two|asking|stopped|six a subagent scenario on the first session
//   usage=fresh|stale|none|off  Claude's usage: 2 min old, 14 min old (not dimmed), never arrived, not switched on;
//   usage=reset|soon|old        the 5-hour window's reset has passed ("reset, waiting for new data"), passes in
//                               20 s (watch it happen), or the numbers are 3 hours old (dimmed);
//   usage=warm|hot|worst        the 5-hour window at 70 %, at 95 %, both windows used up; gpu=none: no GPU reported
//   metrics=live|worst|wait|off the machine: a sample every 2.5 s (the first with no CPU), the worst each cell
//                               can say, CPU never measured, no sample at all
//   cells=cpu,gpu,ram,usage5h,usage7d,waiting|none   the folded island's cells
//   fold=1                      folded; screen=800: the display's width, for the cap
//   (light=1 and zoom=1.25 still work: they are theme=light and scale=1.25 of the stage)
// From the console: ff(minutes) moves every session at rest that far back, wake() puts a finished one
// back to work, usage("stale"), metricsTick().
const MIN = 60_000;
const GB = 1024 ** 3;

const fakeUsage = (kind: string): Usage | null => {
  if (kind === "none" || kind === "off") return null;
  const now = Date.now();
  if (kind === "worst") {
    return { fiveHour: { usedPercent: 100, resetsAt: now + 9 * MIN }, sevenDay: { usedPercent: 100, resetsAt: now + 26 * 60 * MIN }, updatedAt: now };
  }
  const fiveHourResets = kind === "reset" ? now - 6 * MIN : kind === "soon" ? now + 20_000 : now + 134 * MIN;
  return {
    fiveHour: { usedPercent: kind === "hot" ? 95 : kind === "warm" ? 70 : kind === "reset" || kind === "soon" ? 83 : 20, resetsAt: fiveHourResets },
    sevenDay: { usedPercent: kind === "hot" ? 88 : kind === "warm" ? 61 : 12, resetsAt: now + (3 * 24 + 4) * 60 * MIN },
    updatedAt: now - (kind === "old" ? 180 : kind === "stale" ? 14 : kind === "reset" ? 40 : 2) * MIN,
  };
};
const usage = (kind = "fresh") => {
  State.usageInstalled = kind !== "off";
  State.setUsage(fakeUsage(kind));
  State.notify();
};

const metricsMode = params.get("metrics") ?? "live";
let sampled = 0;
let cpu = 31;
let gpu = 18;
// `seed=n` (a capture's default is 1) makes the CPU and GPU walk the same every time.
const random = stage.options.seed != null || stage.options.shot ? rng(stage.options.seed ?? 1) : Math.random;
const metricsTick = () => {
  if (metricsMode === "off") return;
  if (metricsMode === "worst") return State.setMetrics({ cpu: 100, gpu: 100, ramUsed: 16 * GB, ramTotal: 16 * GB });
  cpu = Math.max(4, Math.min(96, cpu + (random() - 0.5) * 22));

  gpu = Math.max(0, Math.min(100, gpu + (random() - 0.5) * 16));
  // CPU and GPU take two readings: the first sample after the island shows has neither. gpu=none: a machine that reports none.
  const first = metricsMode === "wait" || sampled++ === 0;
  State.setMetrics({ cpu: first ? null : cpu, gpu: first || params.get("gpu") === "none" ? null : gpu, ramUsed: 11.2 * GB, ramTotal: 15.9 * GB });
};

interface HomeSpec { cwd: string; state: string; doing: string; minutes: number; seen?: boolean; reply?: string }
const HOME: HomeSpec[] = [
  { cwd: "D:\\work\\personal\\nook", state: "working", doing: "cargo test --workspace", minutes: 2 },
  { cwd: "D:\\work\\acme\\api", state: "approval", doing: "npm run clean && npm run build", minutes: 4 },
  { cwd: "D:\\work\\acme\\web", state: "finished", doing: "Three files changed: the header, its styles and its test.", minutes: 1 },
  { cwd: "D:\\work\\personal\\nook", state: "thinking", doing: "How should the relay's statusline mode chain to an existing one?", minutes: 6 },
  { cwd: "D:\\work\\docs-site", state: "question", doing: "Which sidebar layout?", minutes: 9 },
  { cwd: "D:\\work\\ml-pipeline", state: "error", doing: "pytest tests/test_loader.py", minutes: 3 },
  { cwd: "D:\\work\\infra", state: "finished", doing: "The terraform plan is clean.", minutes: 3, seen: true },
  { cwd: "D:\\work\\mobile-app", state: "working", doing: "src/screens/Checkout.tsx", minutes: 1 },
  { cwd: "D:\\work\\scraper", state: "finished", doing: "One file changed.", minutes: 2, seen: true },
];
const LONG = "D:\\work\\client-with-an-unreasonably-long-repository-name-2026-rewrite";
const MODELS = ["claude-opus-5-5", "claude-sonnet-4-5", undefined, "claude-haiku-4-5-20251001"];

function homeSession(i: number, spec: HomeSpec) {
  const of: HookPayload = { session_id: `home-${i + 1}`, cwd: spec.cwd, session_title: undefined, ...TARGETS.wt };
  const send = (payload: HookPayload) => handleHook(island, { ...of, ...payload });
  const ago = Date.now() - spec.minutes * MIN;
  send({ hook_event_name: "SessionStart", model: MODELS[i % MODELS.length] });
  send({ hook_event_name: "UserPromptSubmit", prompt: spec.doing });
  switch (spec.state) {
    case "working":
      if (spec.doing.includes("/")) send({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: `${spec.cwd}\\${spec.doing}` } });
      else send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: spec.doing } });
      break;
    case "approval": {
      const asks = { tool_name: "Bash", tool_input: { command: spec.doing } };
      send({ hook_event_name: "PreToolUse", ...asks });
      send({ hook_event_name: "PermissionRequest", request_id: `home-req-${i}`, ...asks });
      break;
    }
    case "question": {
      const asks = { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: spec.doing, header: "Layout", multiSelect: false, options: [{ label: "Left" }, { label: "Right" }] }] } };
      send({ hook_event_name: "PreToolUse", ...asks });
      send({ hook_event_name: "PermissionRequest", request_id: `home-req-${i}`, ...asks });
      break;
    }
    case "error":
      send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: spec.doing } });
      send({ hook_event_name: "StopFailure" });
      break;
    case "finished":
      send({ hook_event_name: "Stop", last_message: spec.reply ?? spec.doing, background_tasks: [] });
      break;
  }
  const session = State.sessions.find((s) => s.id === of.session_id);
  if (!session) return;
  // Since when it has stood as it stands: what orders a lane, and what the fade counts from.
  const request = session.approval ?? session.question;
  if (request) request.askedAt = ago;
  if (session.restedAt) session.restedAt = ago;
  if (spec.state === "finished") session.unseen = !spec.seen;
}

/** A subagent scenario of plans/subagents-plan.md §9, on the first session. */
function homeSubagents(scenario: string) {
  const of: HookPayload = { session_id: "home-1", cwd: HOME[0].cwd, ...TARGETS.wt };
  const send = (payload: HookPayload) => handleHook(island, { ...of, ...payload });
  const names = scenario === "six" ? ["Map hooks", "Read relay", "Scan views", "List tests", "Check docs", "Audit CSS"] : ["Count files", "Write a note"];
  const agents = names.map((description, n) => ({ id: `home-agent-${n}`, type: "general-purpose", description, model: n === 0 ? "claude-haiku-4-5-20251001" : undefined }));
  for (const a of agents) {
    const tool_input = { description: a.description, prompt: `${a.description}, and report back.`, subagent_type: a.type };
    send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input });
    send({ hook_event_name: "SubagentStart", agent_id: a.id, agent_type: a.type });
    send({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input, launched_agent: a.id, launched_async: true, launched_model: a.model });
  }
  const running = agents.map((a) => ({ id: a.id, type: "subagent", status: "running", description: a.description, agent_type: a.type }));
  if (scenario === "asking") {
    const asks = { tool_name: "Write", tool_input: { file_path: `${HOME[0].cwd}\\sub-b.txt` } };
    const from = { agent_id: agents[1].id, agent_type: agents[1].type };
    send({ hook_event_name: "PreToolUse", ...from, ...asks });
    send({ hook_event_name: "PermissionRequest", request_id: "home-sub-req", ...from, ...asks });
    // It has waited longest: the session the bot speaks for.
    const session = State.sessions.find((s) => s.id === "home-1");
    if (session?.approval) session.approval.askedAt = Date.now() - 15 * MIN;
  }
  // `Stop` arrives with its subagents still running: it shows as working, not finished.
  if (scenario === "stopped") send({ hook_event_name: "Stop", last_message: "Two subagents are still at work.", background_tasks: running });
}

/** Every session at rest, moved `minutes` back: what five minutes passing does, at once. */
const ff = (minutes = 5) => {
  for (const s of State.sessions) {
    if (s.restedAt) s.restedAt -= minutes * MIN;
    else if (!s.approval && !s.question) s.heardAt -= minutes * MIN;
  }
  if (State.usage) State.usage.updatedAt -= minutes * MIN;
  State.setUsage(State.usage);
  State.notify();
};
/** A session that has finished — the one at rest longest first, a faded one if there is one — goes back to work. */
const wake = () => {
  const done = State.sessions.filter((s) => s.restedAt > 0 && (s.state === "idle" || s.state === "finished"));
  const session = [...done].sort((a, b) => a.restedAt - b.restedAt)[0];
  if (!session) return null;
  const of: HookPayload = { session_id: session.id, cwd: session.cwd ?? undefined, ...TARGETS.wt };
  handleHook(island, { ...of, hook_event_name: "UserPromptSubmit", prompt: "Run the tests again" });
  handleHook(island, { ...of, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } });
  return session.project;
};
Object.assign(window, { ff, wake, usage, metricsTick, Display });

if (params.has("home")) {
  // The session the page opened on gives way to the made-up ones.
  State.sessions.length = 0;
  State.changes.clear();
  State.frontId = "";
  State.settings.hooksInstalled = params.get("hooks") !== "0";
  const pick = params.get("home") ?? "4";
  const specs: HomeSpec[] = pick === "needs"
    ? HOME.slice(0, 8).map((s, i) => ({
        ...s, state: i % 3 === 2 ? "question" : "approval", minutes: 12 - i,
        doing: i % 3 === 2 ? "Keep the old migration?" : ["git push --force", "npm publish", "npm run clean", "docker system prune"][i % 4],
      }))
    : pick === "long"
      ? [{ cwd: LONG, state: "approval", doing: "pnpm --filter @client/core run build:production", minutes: 20 }, ...HOME.slice(0, 4)]
      : HOME.slice(0, Math.max(0, Math.min(HOME.length, Number(pick) || 0)));
  // `decision=1`: the first finished session's reply holds an IMPORTANT alert — its mini bot says so,
  // and it does not fade (`ff(60)` in the console leaves it there). `decision=main`: it is the only
  // session, so the bot's card speaks for it.
  const waits = params.get("decision");
  if (waits === "main") specs.splice(0, specs.length, { ...HOME[2], reply: EXAMPLE_REPLY });
  else if (waits) {
    const done = specs.findIndex((s) => s.state === "finished");
    if (done >= 0) specs[done] = { ...specs[done], reply: EXAMPLE_REPLY };
  }
  specs.forEach((spec, i) => homeSession(i, spec));
  if (params.has("subs") && specs.length > 0) homeSubagents(params.get("subs") ?? "two");
  State.present();
}

if (params.has("home") || params.has("fold") || params.has("metrics") || params.has("usage") || params.has("cells")) {
  const cells = params.get("cells");
  if (cells != null) State.settings.compactMetrics = cells === "none" ? [] : cells.split(",");
  if (params.has("screen")) island.setScreenWidth(Number(params.get("screen")) || 1920);
  usage(params.get("usage") ?? "fresh");
  metricsTick();
  // A capture takes the second sample at once (the first has no CPU) and keeps it: nothing moves after.
  if (stage.options.shot) metricsTick();
  else window.setInterval(metricsTick, 2500);
  // The folded island stays to be looked at: it does not retract a minute later.
  island.fsm.petitToHiddenDelay = 86_400;
  State.isPinned = true;
  island.fsm.pinned = true;
  // Folded, the page checks itself: the slots as a function of the state, and
  // the island hidden and woken again (the console says how it went).
  if (params.get("fold")) {
    window.setTimeout(() => {
      island.collapse();
      checkAutoHide();
      checkUsage();
      checkSlots();
      checkWake(island);
    }, 50);
  } else island.alert("overview");
}

// ── The Shelf ─────────────────────────────────────────────────────────────────
//   tab=shelf                 the island on its Shelf tab (it opens on Home, and is taken there)
//   hidden=all|mirror,timer   widgets switched off, as Settings → Shelf saves them
//   order=projects,timer      the saved order: these first, the others after them
//   motion=reduce             reduced motion, as Settings → Appearance would force it
//   scale=1.25 (zoom=)        the stage scaled as a display at 125 % would
// From the console: ask() sends a permission request (ask(true): a question), as a session would.
const SHELF_IDS = ["media", "todo", "timer", "reminders", "mirror", "projects"];
if (params.has("order")) State.settings.shelfOrder = (params.get("order") ?? "").split(",").filter(Boolean);
if (params.has("hidden")) State.settings.shelfHidden = params.get("hidden") === "all" ? SHELF_IDS : (params.get("hidden") ?? "").split(",");
if (params.get("motion") === "reduce") {
  State.settings.reduceMotion = "on";
  island.applySettings();
}
let asked = 0;
const ask = (question = false) => {
  const tool = question
    ? { tool_name: "AskUserQuestion", tool_input: { questions: [more[1]] } }
    : { tool_name: "Bash", tool_input: { command: "npm run build" } };
  const of: HookPayload = { session_id: State.frontId || SESSION };
  handleHook(island, { ...base, ...of, hook_event_name: "PreToolUse", ...tool });
  handleHook(island, { ...base, ...of, hook_event_name: "PermissionRequest", request_id: `shelf-ask-${++asked}`, ...tool });
};
Object.assign(window, { ask });
if (params.get("tab") === "shelf") {
  island.setView("shelf");
  // The swipe's rules on a clock moved by hand (the console says how it went). With check=swipe, on the
  // island itself too, with wheel events made here: it scrolls the row to its end and back, and ends on Home.
  checkSwipe();
  if (params.get("check") === "swipe") window.setTimeout(() => void checkShelfSwipe(island), 400);
}
State.notify();
finishStage(stage);
