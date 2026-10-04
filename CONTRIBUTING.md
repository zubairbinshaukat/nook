# Contributing to Nook

Nook is a Tauri 2 desktop app for Windows that shows Claude Code sessions at the
top of the screen. All the code is in `windows/`: the Rust app in `src-tauri/`,
the relay in `hook/`, the front end in `src/`.

## Getting started

You need Rust (stable, MSVC), Visual Studio Build Tools with the MSVC x64/x86
tools and a Windows 11 SDK, and Node 20 or newer.

```powershell
cd windows
npm ci
npm run tauri dev
```

## Before you send a change

```powershell
npx tsc --noEmit
cargo test --workspace
```

All of these must pass with no warnings.

## House rules

- No dependencies without a real need.
- No telemetry and no network calls.
- Never block Claude Code: if the app does not answer, the relay exits right away.
- Never approve a permission without an explicit click.
- Never write `~/.claude/settings.json` without a preview, a dated backup and an
  explicit click.

## Pull requests

- One topic per pull request.
- For a bug fix, say how to reproduce the bug.
