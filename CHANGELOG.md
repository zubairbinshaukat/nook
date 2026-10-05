# Changelog

## 0.2.0

- Cursor's agent sessions in the island, next to Claude Code's, for their
  status only (no approvals). Hooks installed from Settings into
  `~/.cursor/hooks.json` with a diff, a dated backup and a click.
- Every session shows which tool it belongs to: a mark (Claude Code's sparkle,
  Cursor's cube) in the session list, the home view, the cards and the folded
  island, and an All / Claude Code / Cursor filter.
- "Show Cursor sessions" in Settings.
- Dock the island to the top, bottom, left or right of the screen. On the
  sides, Home, the Shelf and the compact island stand upright. It sits inside
  the work area, above the taskbar.
- An optional agents list window: one row per project with its status, elapsed
  time and context size. It stays on top and on every virtual desktop, can be
  resized, fades when idle, and a click goes to that session. Rows carry the
  Claude Code or Cursor mark.
- A global shortcut (Ctrl+Alt+N) and a tray item to hide and show the island.
  While it is hidden, it pops up for a request and hides again.
- A context meter for each session, green, amber or red, read from the Claude
  Code transcript. Cursor sessions show none.
- Reading protection: an agent that finishes no longer takes over what you are
  reading. The jump-to-end button, or the agent's row in the sidebar, wiggles
  instead. Permission requests and questions still appear at once.
- The expanded session view stays at the end of the conversation, and a small
  jump-to-end button appears when you scroll up.
- Settings reorganised into eight plain pages with coloured icons, a search and
  a reset for each section. Writing the Claude Code hooks is unchanged: a diff
  preview, a dated backup and an explicit click.
- The installer uses the Nook icon.
- Fixed: the island no longer ends up shifted after it is hidden and shown
  again.
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
