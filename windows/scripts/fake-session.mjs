// Plays a pretend Claude Code session through the real relay, so the island,
// the relay and the socket/pipe can be tried end to end without Claude Code.
//
//   npm run fake-session               a whole session, ending on a permission request
//   npm run fake-session -- permission just the permission request
//   npm run fake-session -- --subagents a session that launches two subagents
//   npm run fake-session -- --mixed     two Claude Code and two Cursor sessions
//
// `--subagents` plays what Claude Code 2.1.288 sends when a session launches
// two subagents in the background (plans/subagents-plan.md, section 3): the
// `Agent` calls and the ids they come back with, tool events that say which
// subagent they come from, a Stop while both still run — the island must stay
// "at work", with no finish sound — a permission request from inside one of
// them, each SubagentStop, and the Stop that really ends the turn.
//
// Every event is piped into nook-hook exactly as Claude Code would do it.
// Nothing is ever executed: the "command" in the permission request is only
// text for the card. For the permission request the script prints what
// Claude Code would receive — the decision JSON, or nothing at all when the
// island did not answer and the terminal would have asked instead.
//
// The relay is looked up in $NOOK_HOOK, then $CARGO_TARGET_DIR, then
// windows/target, release build first.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? "nook-hook.exe" : "nook-hook";

function findHook() {
  if (process.env.NOOK_HOOK) return process.env.NOOK_HOOK;
  const targets = [process.env.CARGO_TARGET_DIR, join(root, "target")].filter(Boolean);
  for (const target of targets) {
    for (const profile of ["release", "debug"]) {
      const candidate = join(target, profile, exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const hook = findHook();
if (!hook) {
  console.error(`${exe} not found. Build it first: cargo build --release -p nook-hook`);
  process.exit(1);
}

const session = `fake-${Date.now()}`;
const cwd = process.cwd();
const base = { session_id: session, cwd };

const PERMISSION = {
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "rm -rf ./build  # fake — nothing runs" },
};

const SESSION = [
  { hook_event_name: "SessionStart", source: "startup" },
  { hook_event_name: "UserPromptSubmit", prompt: "Tidy up the build folder" },
  { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(cwd, "package.json") } },
  { hook_event_name: "PostToolUse", tool_name: "Read" },
  { hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "build" } },
  { hook_event_name: "PostToolUse", tool_name: "Grep" },
  PERMISSION,
  { hook_event_name: "Stop", message: "Build folder tidied" },
];

const COUNT = { id: "af3d8c03f03bd405d", type: "general-purpose", description: "Count files" };
const NOTE = { id: "a1d6303f7f7626095", type: "general-purpose", description: "Write a note" };
/** An event fired from inside a subagent: it carries the subagent's id and type. */
const from = (agent, event) => ({ ...event, agent_id: agent.id, agent_type: agent.type });
/** The session's `Agent` call, the subagent's start, and the call coming back with the id of what it launched. */
const launch = (agent) => {
  const tool_input = { description: agent.description, prompt: `${agent.description}, and report back.`, subagent_type: agent.type };
  return [
    { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input },
    { hook_event_name: "SubagentStart", agent_id: agent.id, agent_type: agent.type },
    {
      hook_event_name: "PostToolUse", tool_name: "Agent", tool_input,
      tool_response: { isAsync: true, status: "async_launched", agentId: agent.id, description: agent.description },
    },
  ];
};
/** What a Stop and a SubagentStop list as still in the background. */
const tasks = (...running) =>
  running.map((agent) => ({ id: agent.id, type: "subagent", status: "running", description: agent.description, agent_type: agent.type }));
const WRITE = { tool_name: "Write", tool_input: { file_path: join(cwd, "sub-b.txt"), content: "hello  # fake — nothing is written" } };
const LIST = { tool_name: "PowerShell", tool_input: { command: "Get-ChildItem -Force  # fake — nothing runs" } };

const SUBAGENTS = [
  { hook_event_name: "SessionStart", source: "startup" },
  { hook_event_name: "UserPromptSubmit", prompt: "Count the files and write a note, with two subagents" },
  ...launch(COUNT),
  ...launch(NOTE),
  from(COUNT, { hook_event_name: "PreToolUse", ...LIST }),
  // The session's own turn stops here, with both subagents still running: not the end.
  { hook_event_name: "Stop", last_assistant_message: "Two subagents are at work.", background_tasks: tasks(COUNT, NOTE) },
  from(NOTE, { hook_event_name: "PreToolUse", ...WRITE }),
  from(NOTE, { hook_event_name: "PermissionRequest", ...WRITE }),
  from(COUNT, { hook_event_name: "PostToolUse", ...LIST, tool_response: { stdout: "package.json\nsrc\n", stderr: "" } }),
  // A subagent still lists itself as running on its own stop.
  from(NOTE, { hook_event_name: "SubagentStop", last_assistant_message: "The note is written: sub-b.txt.", background_tasks: tasks(COUNT, NOTE) }),
  { hook_event_name: "UserPromptSubmit", prompt: `<task-notification> <task-id>${NOTE.id}</task-id> </task-notification>` },
  from(COUNT, { hook_event_name: "SubagentStop", last_assistant_message: "There are 2 entries in the folder.", background_tasks: tasks(COUNT) }),
  // Nothing runs in the background any more: this one is the end.
  { hook_event_name: "Stop", last_assistant_message: "Both subagents are back: 2 files counted, the note written.", background_tasks: [] },
];

// `--mixed`: two Claude Code sessions and two Cursor sessions at once, one
// folder ("api") open in both tools. Cursor's events are what its hooks.json
// hooks send, through `nook-hook --agent cursor <event>`: nothing is ever
// answered, and no Cursor session gets a card to answer.
const claudeOf = (name, folder) => {
  const id = `fake-${name}-${Date.now()}`;
  return (event) => ({ ...event, agent: "claude", session_id: id, cwd: join(cwd, folder) });
};
const cursorOf = (name, folder) => {
  const id = `fake-${name}-${Date.now()}`;
  return (event) => ({ ...event, agent: "cursor", conversation_id: id, workspace_roots: [join(cwd, folder)], model: "gpt-5" });
};
const c1 = claudeOf("c1", "api"), c2 = claudeOf("c2", "site");
const k1 = cursorOf("k1", "api"), k2 = cursorOf("k2", "docs");
const MIXED = [
  c1({ hook_event_name: "SessionStart", source: "startup" }),
  k1({ hook_event_name: "sessionStart" }),
  c2({ hook_event_name: "SessionStart", source: "startup" }),
  k2({ hook_event_name: "sessionStart" }),
  c1({ hook_event_name: "UserPromptSubmit", prompt: "Add a health endpoint" }),
  k1({ hook_event_name: "beforeSubmitPrompt", prompt: "Rename the config loader" }),
  k2({ hook_event_name: "beforeSubmitPrompt", prompt: "Write the install page" }),
  k1({ hook_event_name: "afterAgentThought", text: "The loader is used in three places." }),
  k1({ hook_event_name: "afterShellExecution", command: "rg loadConfig", output: "src/a.ts\nsrc/b.ts\n", duration: 90 }),
  k1({ hook_event_name: "afterFileEdit", file_path: join(cwd, "api", "src", "a.ts"), edits: [{ old_string: "loadConfig(", new_string: "readConfig(" }] }),
  c1({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(cwd, "api", "package.json") } }),
  k2({ hook_event_name: "afterFileEdit", file_path: join(cwd, "docs", "install.md"), edits: [{ old_string: "", new_string: "# Install\n\nRun the setup." }] }),
  k1({ hook_event_name: "afterAgentResponse", text: "Renamed loadConfig to readConfig in 3 files." }),
  k1({ hook_event_name: "stop", status: "completed" }),
  c2({ hook_event_name: "Stop", last_assistant_message: "The site builds again." }),
  k2({ hook_event_name: "stop", status: "error" }),
  c1({ hook_event_name: "Stop", last_assistant_message: "The endpoint is in." }),
];

/** One hook run: JSON on stdin, whatever the relay prints on stdout. */
function send(event) {
  const { agent, ...payload } = event;
  const args = agent === "cursor" ? ["--agent", "cursor", payload.hook_event_name] : [payload.hook_event_name];
  return new Promise((done) => {
    const child = spawn(hook, args, { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => done({ code, out: out.trim() }));
    child.stdin.end(JSON.stringify(agent ? payload : { ...base, ...payload }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const events = process.argv[2] === "permission" ? [PERMISSION] : process.argv.includes("--subagents") ? SUBAGENTS : process.argv.includes("--mixed") ? MIXED : SESSION;
console.log(`relay: ${hook}\nsession: ${session}\n`);

for (const event of events) {
  const name = event.hook_event_name;
  if (name === "PermissionRequest") {
    console.log(`${name}: waiting for Allow / Deny on the island…`);
  }
  const { code, out } = await send(event);
  if (name === "PermissionRequest") {
    console.log(out ? `  Claude Code would get: ${out}` : "  no answer — Claude Code would ask in the terminal");
  } else {
    const what = [event.tool_name, event.agent_id && `subagent ${event.agent_id.slice(0, 6)}`, event.background_tasks && `${event.background_tasks.length} in the background`];
    console.log(`${name}${what.some(Boolean) ? ` · ${what.filter(Boolean).join(" · ")}` : ""}${code === 0 ? "" : ` (exit ${code})`}`);
  }
  await sleep(900);
}
