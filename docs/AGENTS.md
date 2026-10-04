# Other agents in Nook

Nook is built for Claude Code. It also follows Cursor's agent sessions, status
only, and any tool that can run a command on a hook event can send events to it.

## The relay and the pipe

Hooks run `nook-hook.exe`, a small relay. It reads the event JSON on stdin,
adds what the app needs, and sends it down the named pipe `\\.\pipe\nook-<user SID>`.
Only your own user account can connect, and the relay checks that the other end
is your Nook before it sends anything. If Nook is closed or slow the relay prints
nothing and exits 0, so the tool carries on as if Nook were not installed.

## Cursor sessions

Nook follows Cursor's agent sessions next to Claude Code's, **for their status only**.

- **Install:** Settings → Cursor → Install hooks. Nook shows the diff, takes a dated
  backup (`hooks.json.bak-YYYYMMDD-HHMMSS`) and writes only after you click. It adds
  its own entries to `~/.cursor/hooks.json` (and creates the file, with
  `"version": 1`, if it is missing). Your other hooks and keys are kept; Uninstall
  removes only Nook's entries. A `hooks.json` with comments or trailing commas is
  refused, not rewritten. Restart Cursor afterwards.
- **Relay:** each entry is `nook-hook --agent cursor <event>`. The relay turns
  Cursor's payload into the same events Claude Code sends, keys the session as
  `cursor:<conversation_id>`, tags it `nook_tool: "cursor"`, always prints nothing
  and exits 0, even if Nook is closed.
- **Events followed:** `sessionStart`, `sessionEnd` (window closed only),
  `beforeSubmitPrompt`, `postToolUse`, `postToolUseFailure`, `afterShellExecution`,
  `afterFileEdit`, `afterMCPExecution`, `afterAgentResponse`, `afterAgentThought`,
  `subagentStop`, `preCompact`, `stop` (`completed` and `aborted` finish the
  session, `error` is an error).
- **Events never followed:** the ones that can allow, deny or hold something in
  Cursor: `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`,
  `preToolUse`, `subagentStart`. `beforeSubmitPrompt` is the one `before*` event
  Nook uses: empty output means "continue" in Cursor, so it cannot block or change
  a prompt.
- **What it does not do:** no Allow/Deny, no questions answered from the island,
  no usage limits for Cursor.
- **Claude Code hooks run by Cursor:** Cursor can also load `~/.claude/settings.json`
  hooks. If Nook's Cursor hooks are installed, the relay drops those events so a
  conversation is never shown twice; if not, they are shown as Cursor sessions
  (the relay sees Cursor's environment variables), and their permission requests
  are never taken.
- **In the island:** every session has a mark, the Claude Code sparkle or the
  Cursor cube; the session list has an All / Claude Code / Cursor filter when both
  exist; in the folded island a Cursor dot has a hole in it and a Claude Code dot
  is solid. "Show Cursor sessions" in Settings turns them off.
- **Sessions that never send `stop`:** after 10 minutes of silence they get the same
  "may be over" note as Claude Code's.

## Any other tool

Add the optional field `nook_agent` to a hook payload, or run the relay with
`--agent <name>`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "C:\\Users\\you\\AppData\\Local\\Nook\\bin\\nook-hook.exe --agent my-tool" }
    ]
  }
}
```

The name must match `^[a-z0-9-]{1,24}$` (lowercase letters, digits and hyphens).
An absent or invalid name routes the event to the Claude Code pill instead. The
relay adds `nook_agent` to the JSON it forwards:

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "my-session-1",
  "nook_agent": "my-tool",
  "prompt": "Running task…"
}
```

All standard Claude Code hook events are understood, **except `PermissionRequest`**:
approval cards exist for Claude Code only. A `PermissionRequest` from another tool
is answered at once with no decision, so the relay prints nothing and the tool asks
in its own terminal.

| Event | Effect |
|---|---|
| `SessionStart` | Creates the pill, state idle |
| `UserPromptSubmit` | Thinking; the prompt is shown |
| `PreToolUse` | Working; the tool is shown |
| `PostToolUse` / `PostToolUseFailure` | Working |
| `Notification` | Rate-limit or question state if it applies |
| `Stop` | Finished for a few seconds |
| `StopFailure` | Error |
| `SessionEnd` | The pill is removed |
| `SubagentStart` / `SubagentStop` | A step is added |

## Quick test

With Nook running, from `windows/`:

```powershell
npm run fake-session
npm run fake-session -- --mixed   # two Claude Code and two Cursor sessions
```
