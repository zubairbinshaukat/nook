# Nook

[Website](https://nook.zubyr.dev) · [Releases](../../releases) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [MIT licence](LICENSE)

Nook is a small desktop app for Windows. It puts your Claude Code sessions in an
island at the top of your screen and lets you answer their permission requests
and questions without going back to the terminal.

It is built with Tauri 2 (Rust and TypeScript). It makes no network connections.

## Features

- An island that sits at the top of the screen, folded to a thin pill and
  opening when you point at it or when a session needs you.
- Every running Claude Code session on one page: what it is doing, its last
  message, subagents, and a way back to the window it runs in.
- Permission requests and questions answered from the island. Edits show a real
  diff. Nothing is approved without a click.
- Claude's usage limits (5 h and 7 d) and the machine's CPU, GPU and RAM in the
  header.
- Gullu, Nook's buddy, who wears the status of your sessions and reacts to the
  pointer.
- A Shelf of small widgets: To-do, Timer, Reminders, Media, Mirror, Projects.
- Three global shortcuts, all configurable. Hides itself in full-screen apps.
- Hooks are installed from Settings, with a preview of the diff, a dated backup
  and a click. Hooks that belong to other tools are never touched.

## Install

Download `Nook-Windows-<version>-setup.exe` and `SHA256SUMS.txt` from the
[latest release](../../releases/latest).

The installer is not code-signed yet, so Windows SmartScreen may show
"Windows protected your PC" the first time. Check the download first:

```powershell
Get-FileHash .\Nook-Windows-0.1.0-setup.exe -Algorithm SHA256
```

The hash printed must be the one on the installer's line in `SHA256SUMS.txt`.
Then choose **More info**, then **Run anyway**. Little-known unsigned programs
are sometimes flagged by antivirus heuristics; false positives can be reported
to Microsoft at <https://www.microsoft.com/wdsi/filesubmission>.

Then open **Settings, Claude Code, Install hooks** and click through the preview.

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

[`windows/README.md`](windows/README.md) has the rest: the hooks, where Nook
keeps its files, and the layout of the code.

## Privacy

- No telemetry. No network calls from the app or from the relay.
- It never blocks Claude Code: if Nook is closed or slow, the relay exits and
  Claude Code asks in the terminal as usual.
- It never approves anything without a click.
- It never writes `~/.claude/settings.json` without a preview, a dated backup
  and a click.
- What the relay reads (transcript tail, the file an edit targets, command
  output) goes only to the app over a local named pipe that only your account
  can open, and stays in memory. The log records event names and decisions,
  never content.

### Privacy policy

Nook makes no network connections. It collects, stores and sends nothing about
you. Everything it keeps is in `%APPDATA%\Nook` and `%LOCALAPPDATA%\Nook` on your
own machine. (WebView2, the Microsoft component that draws the window, is
updated by Microsoft outside Nook's control.)

## Code signing policy

Releases are currently **unsigned**. Code signing is planned through the
[SignPath Foundation](https://signpath.org)'s free programme once the project
qualifies for it. When that happens:

- What is signed: the installer (`Nook-Windows-<version>-setup.exe`) and the two
  programs inside it, `nook.exe` and `nook-hook.exe`, built from a tagged
  commit by the public GitHub Actions workflow in `.github/workflows/release.yml`
  and by nothing else.
- Who approves: the maintainer, Zubair Bin Shaukat, approves each signing
  request by hand.
- `SHA256SUMS.txt` is published with every release, signed or not.

## Credits

Nook is a fork of [Coucou](https://github.com/Louis-CFM/coucou) by Louis Raillé
(MIT), built on the Windows multi-session work of PR #71 by
[Edurique](https://github.com/Edurique/coucou_edu_windows_implementation).
Interface icons are from Lucide and Simple Icons; see [`NOTICE`](NOTICE).
Gullu, the icons and the sounds are Nook's own; see
[`LICENSE-ASSETS.md`](LICENSE-ASSETS.md).

Nook is not affiliated with or endorsed by Anthropic or by Coucou's author.
"Claude" and "Claude Code" are trademarks of Anthropic.
