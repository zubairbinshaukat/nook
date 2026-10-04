# Nook — guide for AI coding agents

Nook is a Tauri 2 desktop app for Windows (it also builds for Linux). It shows
Claude Code sessions in an island at the top of the screen and lets the user
answer their permission requests and questions. It is a fork of Coucou; see
`NOTICE`.

## Where things are
- `windows/src-tauri/` — the Rust app (crate `nook`): window, relay server (`pipe.rs`), hook installer (`hooks.rs`), settings, `platform/` for what differs between Windows and Linux.
- `windows/hook/` — `nook-hook`, the relay Claude Code runs on every hook event.
- `windows/src/` — the front end, TypeScript with no framework: `island/`, `views/`, `settings/`, `bot/` (the character), `widgets/` (the Shelf).
- `windows/scripts/` — fake session, installer packaging, icon generator.
- `plans/`, `docs/`, `design/` — notes and design prototypes; not part of the build. The website is in `site/`.

## Build and test
Run from `windows/`:
```
npm ci
npm run tauri dev
npx tsc --noEmit
cargo test --workspace
```

## Rules
- No new dependency unless there is a real need for it.
- No telemetry and no network calls.
- Never block Claude Code: if the app does not answer, the relay exits right away.
- Never approve a permission without an explicit click.
- Never write `~/.claude/settings.json` without a preview of the diff, a dated backup and an explicit click. Never touch another tool's hooks.
- The pipe name and the socket path each exist twice (app and relay) and must match exactly: `pipe.rs` and `hook/src/win.rs`; `platform/linux.rs` and `hook/src/unix.rs`.
- The character, icons and sounds are Nook's own (`LICENSE-ASSETS.md`); sounds come from `windows/scripts/make-sounds.mjs`. Nothing of Coucou's art is to come back.
- Builds must pass with no warnings.
