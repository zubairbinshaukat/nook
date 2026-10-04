# Security

## Reporting a vulnerability

Please report it privately through GitHub: **Security, Report a vulnerability**
on this repository (a private advisory). Do not open a public issue for it.
Include the Nook version, what you did, and what you saw. You will get an
answer within a few days.

## Threat model

- Nook trusts the Windows account it runs as. Code that runs as you, at your
  integrity level, can edit `~/.claude/settings.json` or the relay itself;
  Nook does not try to defend against that.
- The relay pipe `\\.\pipe\nook-<your SID>` can be opened only by your account
  and SYSTEM, never remotely. The relay sends nothing unless the pipe's server
  is a process of your user called `nook.exe` at an integrity level no lower
  than its own.
- Permission requests are answered only by a click on the island. If the app is
  closed, slow, paused or crashes, the relay prints nothing and exits 0, and
  Claude Code asks in the terminal.
- Nothing is sent over the network, and the window's content security policy
  forbids it. Event text is rendered as text, never as HTML.
- The hook installer writes `~/.claude/settings.json` only after a diff
  preview, a dated backup and a click, and touches only Nook's own entries.
- The installer is not code-signed yet; check releases against `SHA256SUMS.txt`.
