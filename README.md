<div align="center">

<a href="https://nook.zubyr.dev">
  <img src="site/assets/img/icon-512.png" alt="Nook, a Dynamic Island for Windows" width="128" height="128">
</a>

# Nook

**A Dynamic Island for Windows.**<br>
Every Claude Code and Cursor agent you run, at the top of your screen: status, usage limits, and approvals with one click.

<br>

[![Download](https://img.shields.io/github/v/release/zubairbinshaukat/nook?style=for-the-badge&label=Download&color=3ddc97&labelColor=0b0d10)](https://github.com/zubairbinshaukat/nook/releases/latest)
[![Website](https://img.shields.io/badge/Website-nook.zubyr.dev-5aa9ff?style=for-the-badge&labelColor=0b0d10)](https://nook.zubyr.dev)
[![Guides](https://img.shields.io/badge/Guides-read-a98bfa?style=for-the-badge&labelColor=0b0d10)](https://nook.zubyr.dev/guides/)

[![License: MIT](https://img.shields.io/badge/license-MIT-3ddc97?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4?style=flat-square&logo=windows11&logoColor=white)](#install)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-ffc131?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-dea584?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![No telemetry](https://img.shields.io/badge/telemetry-none-ffb547?style=flat-square)](#privacy)
[![Stars](https://img.shields.io/github/stars/zubairbinshaukat/nook?style=flat-square&color=f5a524)](https://github.com/zubairbinshaukat/nook/stargazers)

<br>

<a href="https://nook.zubyr.dev">
  <img src="site/assets/img/og.png" alt="Nook: sessions, usage limits and approvals in an island at the top of your screen" width="860">
</a>

</div>

<br>

## What is Nook?

You start a few Claude Code sessions in different projects, then lose track of
which one is working, which one finished, and which one has been waiting on you
for ten minutes. Nook puts them all in a small island at the top of your screen.

It folds to a thin pill, opens when you point at it, and opens by itself when a
session needs you. It is local from end to end: no account, no network, no
telemetry.

> [!NOTE]
> Nook is an independent project. It is not affiliated with or endorsed by
> Anthropic or Cursor.

## Screenshots

<div align="center">

<picture><source media="(prefers-color-scheme: light)" srcset="site/assets/img/shots/hero-light.webp"><img src="site/assets/img/shots/hero-dark.webp" alt="Nook open at the top of a Windows desktop: one session needs permission, two are working, one is done, with CPU, GPU, RAM and Claude usage beside them." width="860"></picture>

</div>

<table>
<tr>
<td width="50%"><picture><source media="(prefers-color-scheme: light)" srcset="site/assets/img/shots/over-browser-tabs-light.webp"><img src="site/assets/img/shots/over-browser-tabs-dark.webp" alt="The Nook island floating over the tab strip of a browser window, so it never takes space from the page." width="420"></picture><br><sub>Over a browser's tabs, never in the way.</sub></td>
<td width="50%"><picture><source media="(prefers-color-scheme: light)" srcset="site/assets/img/shots/over-editor-light.webp"><img src="site/assets/img/shots/over-editor-dark.webp" alt="A permission request for an edit in the Nook island, with the changed lines as a diff and Deny and Allow buttons, above a code editor." width="420"></picture><br><sub>An edit request with its diff, over an editor.</sub></td>
</tr>
<tr>
<td width="50%"><picture><source media="(prefers-color-scheme: light)" srcset="site/assets/img/shots/dock-bottom-light.webp"><img src="site/assets/img/shots/dock-bottom-dark.webp" alt="Nook docked to the bottom edge of the screen, standing on the taskbar." width="420"></picture><br><sub>Docked to the bottom edge.</sub></td>
<td width="50%"><picture><source media="(prefers-color-scheme: light)" srcset="site/assets/img/shots/session-agents-light.webp"><img src="site/assets/img/shots/session-agents-dark.webp" alt="A session page listing its subagents under the parent session, each with its own state." width="420"></picture><br><sub>A session and its subagents.</sub></td>
</tr>
<tr>
<td colspan="2" align="center"><picture><source media="(prefers-color-scheme: light)" srcset="site/assets/img/shots/settings-look-light.webp"><img src="site/assets/img/shots/settings-look-dark.webp" alt="Nook Settings, Look and colours page: theme, accent and the buddy." width="520"></picture><br><sub>Settings: colours, island, shortcuts and more.</sub></td>
</tr>
</table>

<!-- TODO screenshot: real-approval-terminal (see docs/screenshots.md) -->
<!-- TODO screenshot: agents-list-real (see docs/screenshots.md) -->

The images change with your GitHub theme. They are made by 
pm run shots from a
fake desktop and made-up sessions: see [docs/screenshots.md](docs/screenshots.md).
## Features

| | |
|---|---|
| **Every session at a glance** | One page for all running sessions: project, status, last message, subagents, and a button back to the window each one runs in. |
| **Approve from the island** | Permission requests and questions are answered from the island. Edits show a real diff. Nothing is approved without your click. |
| **Claude Code and Cursor** | Cursor's agent sessions appear next to Claude Code's, each with its own mark. Cursor is status only. |
| **Usage limits** | Your 5-hour and 7-day Claude limits, from Claude Code's own status line, with no network call. |
| **Resources** | CPU, GPU and RAM in the header of every screen. |
| **Gullu** | Nook's little buddy wears the status of your sessions and reacts to the pointer. |
| **The Shelf** | Small widgets: To-do, Timer, Reminders, Media, Mirror, Projects. Swipe between Home and Shelf. |
| **Keyboard** | `Ctrl+Alt+Space` opens the large panel, `Ctrl+Shift+Space` opens it at normal size, `Ctrl+Alt+Enter` jumps to the session that needs you. All configurable. |
| **Stays out of the way** | Hides in full-screen apps, folds on its own, uses almost no CPU while hidden. |

## How it works

```
Claude Code / Cursor  ──hook event──▶  nook-hook.exe  ──named pipe──▶  Nook
   (your terminal or editor)             (tiny relay)     (only you)    (the island)
```

Hooks run a tiny relay, `nook-hook.exe`. It sends each event to Nook over a
named pipe that only your Windows account can open, and answers back with your
click. If Nook is closed or slow, the relay exits at once and the tool carries
on as if Nook were not installed. Nook never blocks an agent.

## Install

1. Download `Nook-Windows-<version>-setup.exe` and `SHA256SUMS.txt` from the
   [latest release](https://github.com/zubairbinshaukat/nook/releases/latest).
2. Check the download:

   ```powershell
   Get-FileHash .\Nook-Windows-0.2.1-setup.exe -Algorithm SHA256
   ```

   The hash must match the installer's line in `SHA256SUMS.txt`.
3. Run the installer. It installs for your user, with no admin rights. The
   installer is not code-signed yet, so SmartScreen may say "Windows protected
   your PC": choose **More info**, then **Run anyway**.
4. Open **Settings → Connect → Connect…** and click through the
   preview. Start a new Claude Code session and it appears in the island.

Step-by-step guides, with fixes for common problems, are on
[nook.zubyr.dev/guides](https://nook.zubyr.dev/guides/).

<details>
<summary>My antivirus flags nook-hook.exe</summary>

Small unsigned programs are sometimes flagged by heuristics. The relay is open
source in [`windows/hook`](windows/hook) and makes no network calls. You can
report the false positive to Microsoft at
<https://www.microsoft.com/wdsi/filesubmission>.

</details>

## Cursor

Settings → **Connect** → **Cursor** → **Connect…** writes Nook's entries to
`~/.cursor/hooks.json`, after a diff preview and a dated backup. Nook follows
only the events that cannot change what Cursor does, so it can never allow,
deny or delay anything there. Restart Cursor afterwards. Details in
[`docs/AGENTS.md`](docs/AGENTS.md).

## Build from source

You need Rust (stable, MSVC), Visual Studio Build Tools with the MSVC x64/x86
tools and a Windows 11 SDK, and Node 20 or newer.

```powershell
cd windows
npm ci
npm run tauri dev       # development build
npm run pack            # release build, installer and release\SHA256SUMS.txt
npx tsc --noEmit
cargo test --workspace
```

[`windows/README.md`](windows/README.md) covers the hooks, where Nook keeps its
files, and the layout of the code. Contributions are welcome: see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Privacy

- No telemetry. No network calls from the app or from the relay.
- It never blocks Claude Code: if Nook is closed or slow, the relay exits and
  Claude Code asks in the terminal as usual.
- It never approves anything without a click.
- It never writes `~/.claude/settings.json` or `~/.cursor/hooks.json` without a
  preview, a dated backup and a click. Hooks that belong to other tools are never
  touched.
- What the relay reads (transcript tail, the file an edit targets, command
  output) goes only to the app over a local named pipe that only your account
  can open, and stays in memory. The log records event names and decisions,
  never content.

**Privacy policy.** Nook makes no network connections. It collects, stores and
sends nothing about you. Everything it keeps is in `%APPDATA%\Nook` and
`%LOCALAPPDATA%\Nook` on your own machine. (WebView2, the Microsoft component
that draws the window, is updated by Microsoft outside Nook's control.)

## Code signing policy

Releases are currently **unsigned**. Code signing is planned through the
[SignPath Foundation](https://signpath.org)'s free programme once the project
qualifies for it. When that happens:

- **What is signed:** the installer (`Nook-Windows-<version>-setup.exe`) and the
  two programs inside it, `nook.exe` and `nook-hook.exe`, built from a tagged
  commit by the public workflow in
  [`.github/workflows/release.yml`](.github/workflows/release.yml) and by nothing
  else.
- **Who approves:** the maintainer, Zubair Bin Shaukat, approves each signing
  request by hand.
- `SHA256SUMS.txt` is published with every release, signed or not.

## Security

Found a vulnerability? Please report it privately: see [`SECURITY.md`](SECURITY.md).

## Credits

Nook is a fork of [Coucou](https://github.com/Louis-CFM/coucou) by Louis Raillé
(MIT), built on the Windows multi-session work of PR #71 by
[Edurique](https://github.com/Edurique/coucou_edu_windows_implementation).
Interface icons are from [Lucide](https://lucide.dev) and
[Simple Icons](https://simpleicons.org); see [`NOTICE`](NOTICE). Gullu, the
icons and the sounds are Nook's own; see
[`LICENSE-ASSETS.md`](LICENSE-ASSETS.md).

"Claude" and "Claude Code" are trademarks of Anthropic. "Cursor" is a trademark
of Anysphere.

<br>

<div align="center">

**Built by [Zubair Bin Shaukat](https://zubyr.dev)** in Lahore

[Website](https://zubyr.dev) · [GitHub](https://github.com/zubairbinshaukat) · [LinkedIn](https://www.linkedin.com/in/zubairbinshaukat) · [X](https://x.com/zubyrdev)

<sub>If Nook saves you a trip to the terminal, a ⭐ helps others find it.</sub>

</div>
