# Changelog

## Unreleased

- Cursor's agent sessions in the island, next to Claude Code's, for their
  status only (no approvals). Hooks installed from Settings into
  `~/.cursor/hooks.json` with a diff, a dated backup and a click.
- Every session shows which tool it belongs to: a mark (Claude Code's sparkle,
  Cursor's cube) in the session list, the home view, the cards and the folded
  island, and an All / Claude Code / Cursor filter.
- "Show Cursor sessions" in Settings.

## 0.1.0

First release of Nook, a fork of Coucou for Windows.

- An island at the top of the screen that folds to a thin pill, opens on hover
  or when a session needs you, and rests between beats.
- Claude Code sessions on one page, with their state, last message and
  subagents, and a button that goes to the window each one runs in.
- Permission requests and questions answered from the island, with a real diff
  for edits. No approval without a click; if nobody answers, Claude Code asks
  in the terminal.
- A relay (`nook-hook`) that Claude Code runs on each hook event. It never
  blocks Claude Code, checks it is talking to Nook (same user, `nook.exe`, no
  lower integrity level) and talks only over a named pipe that only the current
  user can open.
- Hooks installed and removed from Settings with a diff preview, a dated backup
  and a click.
- Claude usage limits and CPU, GPU and RAM in the header.
- Gullu, Nook's own buddy, with reactions to the pointer and to status.
- The Shelf: To-do, Timer, Reminders, Media, Mirror and Projects widgets.
- Three configurable global shortcuts, auto-hide in full-screen apps, and
  paging by swipe.
- No telemetry and no network calls.
- Own sounds, synthesized from plain tones; none of Coucou's art or sounds.
- Builds for Linux from the same code.
