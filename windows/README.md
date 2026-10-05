# Nook

Nook is a small desktop app for Windows (Tauri 2: Rust and TypeScript). It shows
your Claude Code sessions in an island at the top of your screen and lets you
answer their permission requests and questions from there. The same code builds
for Linux.

## What it will not do

- No telemetry.
- No network calls.
- It never blocks Claude Code. The relay gives the app 300 ms to pick up and
  exits cleanly if Nook is closed, slow or crashed. If nobody answers a
  permission request in time, Nook says nothing and Claude Code asks in the
  terminal as usual.
- It never approves anything without a click.
- It never writes `~/.claude/settings.json` without a preview, a dated backup
  and a click.

## Build

You need:

- Rust, stable, MSVC toolchain ([rustup](https://rustup.rs))
- Visual Studio Build Tools with the MSVC x64/x86 build tools and a Windows 11 SDK
- Node 20 or newer

WebView2 ships with Windows 10 and 11.

```powershell
cd windows
npm ci
npm run tauri dev        # development build, live reload
npx tauri build          # release build and NSIS installer
npm run fake-session     # plays a pretend Claude Code session through the relay
```

`npm run fake-session` needs Nook running. Nothing is executed: the script
prints what Claude Code would have received. `npm run fake-session -- permission`
sends only a permission request.

Checks:

```powershell
npx tsc --noEmit
cargo test --workspace
```

To make a release:

```powershell
npm run pack             # release build, installer, and release\SHA256SUMS.txt
```

`release\` then holds `Nook-Windows-<version>-setup.exe` and `SHA256SUMS.txt`,
with the SHA-256 of the installer and of the two programs inside it
(`nook.exe`, `nook-hook.exe`).

## Installing

Nook's installer is not code-signed. Windows SmartScreen does not know an
unsigned program it has not seen often, so the first run may show
**"Windows protected your PC"**. If you got the installer from a place you
trust and its hash matches (below): choose **More info**, then **Run anyway**.

To check a download against `SHA256SUMS.txt`:

```powershell
Get-FileHash .\Nook-Windows-0.2.0-setup.exe -Algorithm SHA256
```

The hash printed must be the one on the installer's line in `SHA256SUMS.txt`.
The same works for an installed `nook.exe` or `nook-hook.exe`.

Both programs carry version information (Properties → Details): product
"Nook", author Zubair Bin Shaukat, and the version.

If an antivirus flags Nook, it is a false positive of the kind unsigned,
little-known programs get: `nook-hook.exe` is a small program that other
programs start often, which heuristics dislike. You can report it to Microsoft
at <https://www.microsoft.com/wdsi/filesubmission> ("Software developer",
"Incorrectly detected"), which usually clears Microsoft Defender within days.

## Claude Code hooks

Open **Settings… → Claude Code → Install hooks…**. Nook shows the exact diff of
what will change in `%USERPROFILE%\.claude\settings.json` and the path of the
dated backup it will take. Nothing is written until you click. Hooks that belong
to other tools are never touched, and **Uninstall hooks…** removes only Nook's
entries, the same way: preview, backup, click.

If hooks from Coucou are still in `settings.json`, the settings window says so,
and installing replaces them with Nook's.

Uninstalling the app does not edit `~/.claude/settings.json`. Remove the hooks
from the settings window first; otherwise the entries stay, pointing at a relay
that is no longer there.

## Cursor

Cursor's agent sessions show in the island next to Claude Code's, marked with
Cursor's cube, for their status only: Nook cannot approve or answer anything
in Cursor. Open **Settings… → Claude Code → Cursor → Install hooks…**. The same
rules as above apply to `%USERPROFILE%\.cursor\hooks.json`: diff, dated backup,
a click, other hooks never touched, Uninstall removes only Nook's entries. Nook
follows only events that cannot change what Cursor does. Cursor reloads
`hooks.json` when it is saved; restart Cursor if sessions do not show up. See
`docs/AGENTS.md` for the events.

## Where things live

| What | Where |
|---|---|
| Relay | `%LOCALAPPDATA%\Nook\bin\nook-hook.exe`, copied there at launch |
| Log | `%LOCALAPPDATA%\Nook\nook.log` |
| Preferences | `%APPDATA%\Nook\settings.json` |
| Named pipe | `\\.\pipe\nook-<your user SID>` |

On Linux: `~/.local/share/nook/` (relay and log), `~/.config/nook/`
(preferences), and the Unix socket `$XDG_RUNTIME_DIR/nook.sock`.
`NOOK_LAYER_SHELL=0` turns the layer-shell overlay off.

## Layout

```
windows/
  src/           front end (TypeScript, no framework)
  src-tauri/     Rust: window, relay server, hook installer, settings
  hook/          nook-hook, the relay Claude Code runs on each hook event
  scripts/       fake session, installer packaging, icon generator
```


## Character art and sounds

The character is Gullu, Nook's buddy: Nook's own, drawn in code
(`src/bot/engine.ts`) from `design/prototype/nook-buddy.html`, and the icons are
drawn from it by `scripts/gen-icons.mjs`. Gullu wears the status of your
sessions, and reacts to the pointer and to clicks (`src/bot/reactions.ts`);
Settings → Appearance → Playful reactions turns that off. The sounds are
Nook's own: synthesized from plain tones by `scripts/make-sounds.mjs` (see
`LICENSE-ASSETS.md`).

## Credits

Nook is a fork of [Coucou](https://github.com/Louis-CFM/coucou) by Louis Raillé,
built on the Windows multi-session work by
[Edurique](https://github.com/Edurique/coucou_edu_windows_implementation).
See the `README.md` and `NOTICE` at the root of the repository.
