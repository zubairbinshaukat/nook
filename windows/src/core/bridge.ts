// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentsSnapshot } from "../agents/model";
import type { Dock } from "./layout";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[nook] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  /** The window's own logical size on that monitor: see layout.ts `Room`. */
  panel: PanelSize;
  version: string;
  hookPath: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
}

/** The full window's logical size, as Rust sized it for the display (the `panel-size` event carries one too). */
export interface PanelSize {
  width: number;
  height: number;
  /** The edge of the display the island hangs from. */
  dock: Dock;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /**
   * Gives the window the keyboard — a question's typed answer, the large panel
   * and its Escape, the sidebar's arrows — and hands it back to the window it
   * was taken from. The island never has it otherwise: its window does not activate.
   */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  /**
   * The ↗: brings forward the window a session runs in — its editor's, its
   * terminal's, the Claude app. Only the session is named: where it runs is
   * what Rust worked out from the relay, not something the page says.
   */
  focusSession: (sessionId: string) => call<boolean>("focus_session", { sessionId }),

  /**
   * Opens a file a reply names in the editor its session runs in. The session
   * is named, and the path as the reply wrote it: Rust looks up where the
   * session runs, resolves the path against its folder, and opens only a file
   * that exists, in an editor of its own choosing (lib.rs `open_session_file`).
   * False when it did not: no such file, or a session that is not in an editor.
   */
  openSessionFile: (sessionId: string, path: string, line: number | null) =>
    call<boolean>("open_session_file", { sessionId, path, line }),

  /**
   * Whether a full-screen app is in front on the island's display, right now:
   * asked when a hidden island is about to wake (Settings → Island, "Hide in
   * full-screen apps"). Always false where it cannot be told (Linux).
   */
  fullscreenNow: () => call<boolean>("fullscreen_now"),

  /**
   * Whether each of these names is a file `openSessionFile` would open, for
   * that session: a yes or a no per path, in order, and nothing else (lib.rs
   * `session_files_exist`). Twenty at most are looked at in one call.
   */
  sessionFilesExist: (sessionId: string, paths: string[]) =>
    call<boolean[]>("session_files_exist", { sessionId, paths }),

  quit: () => call<void>("quit_app"),

  // ── The Shelf's Media widget (src-tauri/src/media.rs): the system's player, asked a call at a time ──
  mediaState: () => call<MediaInfo>("media_state"),
  /** The current track's album art as a data: URL, read to memory. */
  mediaCover: () => call<string | null>("media_cover"),
  mediaControl: (action: "previous" | "toggle" | "next") => call<boolean>("media_control", { action }),
  /** The system's master volume, 0-100, or null when it cannot be read. */
  mediaVolume: () => call<number | null>("media_volume"),
  mediaSetVolume: (percent: number) => call<boolean>("media_set_volume", { percent }),

  // ── The Shelf's Projects widget (src-tauri/src/projects.rs) ───────────────
  /** The folders sessions have run in, most recent first: Rust's own list, only those still there. */
  projectsList: () => call<ProjectInfo[]>("projects_list"),
  /** A session was seen running in this folder. Rust keeps it if it is a folder it could launch. */
  projectsNote: (cwd: string) => call<void>("projects_note", { cwd }),
  /** Both launchers name a folder of the list; Rust checks it is on its own, and starts the program with the path as one argument. */
  projectsOpenCode: (path: string) => call<boolean>("projects_open_code", { path }),
  projectsNewSession: (path: string) => call<boolean>("projects_new_session", { path }),

  // ── The Shelf's saved state (shelf.json, src-tauri/src/shelf.rs) ──────────
  /** A widget's part of the file, or null when it has none yet. */
  shelfLoad: (widget: string) => call<unknown>("shelf_load", { widget }),
  /** Throws what Rust refused with: a widget that is not the page's to write, a part far too big. */
  shelfSave: (widget: string, value: unknown) => callOrThrow<void>("shelf_save", { widget, value }),

  openSettingsWindow: () => call<void>("open_settings_window"),

  // ── A reply to a session at rest (src-tauri/src/reply.rs) ─────────────────
  /** Which tools' command lines are on this machine: a reply runs through them. */
  replyTools: () => call<ReplyTools>("reply_tools"),
  /** Continues that conversation in the background with `text`. Throws what Rust refused with, as a sentence. */
  sessionReply: (tool: ReplyTool, sessionId: string, cwd: string, text: string) =>
    callOrThrow<void>("session_reply", { tool, sessionId, cwd, text }),
  /** Stops the run a reply started, if it is still going. */
  sessionReplyCancel: (tool: ReplyTool, sessionId: string) => call<void>("session_reply_cancel", { tool, sessionId }),

  // ── The agents list (src-tauri/src/agents.rs) ─────────────────────────────
  /** The island hands the list its rows: Rust keeps them and tells the list. Only the island's page is heard. */
  agentsSnapshot: (snapshot: AgentsSnapshot) => call<void>("agents_snapshot", { snapshot }),
  /** The latest rows, for a list that loaded after they were sent; null when none was. */
  agentsLast: () => call<unknown>("agents_last"),
  /** Whether the list is on show: for a page that loaded after it was shown. */
  agentsShown: () => call<boolean>("agents_shown"),
  /** What the list's rows need in height, in logical pixels, however tall the window is: Rust sizes the window within its limits and the user's cap. */
  agentsFit: (height: number) => call<void>("agents_fit", { height }),
  /** An edge or bottom corner of the list was grabbed: its width, or the most its height may be, is Rust's from here to `agentsResizeEnd`. */
  agentsResizeBegin: (side: "left" | "right" | "bottom" | "bottom-left" | "bottom-right") => call<void>("agents_resize_begin", { side }),
  /** The pointer moved with an edge held: Rust sets the size from where the cursor is. */
  agentsResizeMove: () => call<void>("agents_resize_move"),
  /** The edge was let go: the size is kept. */
  agentsResizeEnd: () => call<void>("agents_resize_end"),
  /** The header was double-clicked: back to the default width and height. */
  agentsResizeReset: () => call<void>("agents_resize_reset"),
  /** The list's ×. */
  agentsHide: () => call<void>("agents_hide"),

  // ── The global shortcuts ──────────────────────────────────────────────────
  /** Where each of the two stands: saved, on or off, and whether the OS has it. */
  shortcutStatus: () => call<Record<ShortcutName, ShortcutStatus>>("shortcut_status"),
  /**
   * Picks another combination for one of them, or switches it on or off. Rust
   * registers it before it saves it: one that is not a combination, that is
   * reserved, that is the other shortcut's, or that another program holds is
   * refused with the reason, and nothing changes.
   */
  setShortcut: (which: ShortcutName, accelerator: string, enabled: boolean) =>
    callOrThrow<ShortcutStatus>("set_shortcut", { which, accelerator, enabled }),

  /** Writes to %LOCALAPPDATA%\Nook\nook.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  // ── Cursor's hooks: the same flow, on ~/.cursor/hooks.json ─────────────────
  cursorStatus: () => call<CursorStatus>("cursor_status"),
  cursorPreview: (install: boolean) => callOrThrow<HookPreview>("cursor_preview", { install }),
  cursorApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("cursor_apply", { install, fingerprint }),

  // ── Codex's hooks: the same flow, on ~/.codex/hooks.json ───────────────────
  codexStatus: () => call<CodexStatus>("codex_status"),
  codexPreview: (install: boolean) => callOrThrow<HookPreview>("codex_preview", { install }),
  codexApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("codex_apply", { install, fingerprint }),

  approvalDecision: (requestId: string, decision: "allow" | "deny" | "skip") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),
  /** The answers to a question Claude asked, keyed by the question's own words. */
  approvalAnswer: (requestId: string, answers: Record<string, string>) =>
    call<void>("approval_answer", { requestId, answers }),

  // ── Claude's usage limits (step 2, system side) ───────────────────────────
  /** The latest usage Claude Code reported to its status line, or null when none has come yet. */
  usageLast: () => call<UsagePayload>("usage_last"),
  /** Whether the relay is Claude Code's status line command, which is how the numbers arrive. */
  usageStatus: () => call<UsageStatus>("usage_status"),
  /** Diff of the `statusLine` key to show before anything is written. `install: false` previews removal. */
  usagePreview: (install: boolean) => callOrThrow<HookPreview>("usage_preview", { install }),
  /** Writes ~/.claude/settings.json — after an explicit click, and only if it still matches the preview. */
  usageApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("usage_apply", { install, fingerprint }),
  // ── end of the usage block ────────────────────────────────────────────────

  // ── The reply format, in ~/.claude/CLAUDE.md ──────────────────────────────
  /** Where Nook's marked block stands in the user's global CLAUDE.md. */
  replyFormatStatus: () => call<ReplyFormatStatus>("reply_format_status"),
  /** Diff of CLAUDE.md to show before anything is written. */
  replyFormatPreview: (action: ReplyFormatAction) => callOrThrow<HookPreview>("reply_format_preview", { action }),
  /** Writes ~/.claude/CLAUDE.md — after an explicit click, and only if it still matches the preview. */
  replyFormatApply: (action: ReplyFormatAction, fingerprint: string) =>
    callOrThrow<string>("reply_format_apply", { action, fingerprint }),
};

/** A project folder, as Rust lists it. */
export interface ProjectInfo {
  path: string;
  /** The folder's own name. */
  name: string;
  /** When a session was last seen in it (Unix ms). */
  at: number;
}

/** What the system says is playing (src-tauri/src/media.rs). */
export interface MediaInfo {
  /** "session": something is on; "none": nothing is playing; "unavailable": the system cannot be asked ('reason' says why). */
  kind: "session" | "none" | "unavailable";
  reason: string | null;
  title: string;
  artist: string;
  album: string;
  /** The player, in plain words. */
  app: string;
  playing: boolean;
  /** Where the track is and how long it is, ms (the length is 0 when the player does not say). */
  positionMs: number;
  durationMs: number;
  canPrevious: boolean;
  canNext: boolean;
  canToggle: boolean;
  /** Changes when the track does. */
  trackKey: string;
}

/** What can be asked of the reply format's block: add it, bring it up to date, take it out. */
export type ReplyFormatAction = "install" | "update" | "remove";

/** Where the block stands (src-tauri/src/replyformat.rs). */
export interface ReplyFormatStatus {
  /**
   * "outdated": the markers are there, what is between them is not Nook's
   * current text. "unmarked": no markers, but the file already has a reply
   * format of its own (`found`). "error": the file cannot be read, or its
   * markers do not make one pair (`error`).
   */
  state: "notInstalled" | "installed" | "outdated" | "unmarked" | "error";
  found: string[];
  error: string | null;
  path: string;
  exists: boolean;
}

// ── Step 2, system side: the machine, the usage limits, the models ────────────
// Events Rust emits to the island window, and what the usage commands return.

/**
 * The `metrics` event: every 2.5 s while the island is not hidden, never
 * otherwise. `cpu` is the whole machine's, in percent (0–100, one decimal),
 * and null on the first reading after each wake. `gpu` is the busiest
 * graphics adapter's, 0–100 too: null on that first reading, and always on a
 * machine that does not report it. The two others are bytes.
 */
export interface MetricsPayload {
  cpu: number | null;
  gpu: number | null;
  ramUsed: number;
  ramTotal: number;
}

/** One usage window: how much of it is used, in percent (0–100), and when it resets (Unix ms). */
export interface UsageWindow {
  usedPercent: number;
  resetsAt: number;
}

/**
 * The `usage` event, and what `usageLast` returns: the 5-hour and weekly
 * limits as Claude Code last told its status line. A window it did not report
 * is null; `updatedAt` is when Nook was told (Unix ms).
 */
export interface UsagePayload {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  updatedAt: number;
}

/** The `session_model` event: the model a session runs on, from its status line. */
export interface SessionModelPayload {
  sessionId: string;
  model: { id: string; displayName: string };
  /** The size of its context window in tokens, when the status line said it. */
  contextWindow: number | null;
}

/** Where the status line stands in ~/.claude/settings.json. */
export interface UsageStatus {
  /** The relay is Claude Code's status line command. */
  installed: boolean;
  /** And it runs the status line the user had before, which uninstalling puts back. */
  chained: boolean;
  /** A status line that is not Nook's is there: installing wraps it. */
  otherStatusLine: boolean;
  settingsPath: string;
}

/** The events of this block, by name. */
export type SystemEvent =
  | { name: "metrics"; payload: MetricsPayload }
  | { name: "usage"; payload: UsagePayload }
  | { name: "session_model"; payload: SessionModelPayload };
// ── end of the step 2 block ───────────────────────────────────────────────────

/** The global shortcuts: the panel's size, the way to the session that needs the user, hiding the island, and the agents list. */
export type ShortcutName = "expand" | "goto" | "panel" | "hide" | "agents";

/** One of them, as Rust has it (src-tauri/src/shortcut.rs). */
export interface ShortcutStatus {
  accelerator: string;
  enabled: boolean;
  /** The OS has it: pressing it works. */
  registered: boolean;
  /** Why it is not registered though it is on. */
  error: string | null;
}

export interface HookStatus {
  installed: boolean;
  /** Entries left by Coucou are still in settings.json. */
  legacy: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

/** Cursor's hooks (~/.cursor/hooks.json); the hooks follow its sessions for their status only. */
export interface CursorStatus {
  installed: boolean;
  /** Every entry is what Nook would write now: the relay has not moved. */
  current: boolean;
  fileExists: boolean;
  /** ~/.cursor is there: Cursor has run on this account. */
  cursorFound: boolean;
  hooksPath: string;
  hookPath: string;
  hookReady: boolean;
  /** Why Nook will not write its command (a relay path with a space in it). */
  refused: string | null;
  /** hooks.json is there but is not plain JSON (comments, a trailing comma): never written over. */
  unreadable: string | null;
}

/** The tools a reply can be sent to. */
export type ReplyTool = "claude" | "codex";
export type ReplyTools = Record<ReplyTool, boolean>;
/** The `reply_ended` event: the run a reply started is over. */
export interface ReplyEnded {
  tool: ReplyTool;
  /** The tool's own id of the session, as it was given to `sessionReply`. */
  sessionId: string;
  ok: boolean;
  error: string | null;
}

/** Codex's hooks (~/.codex/hooks.json); its sessions are followed and its permission requests answered. */
export interface CodexStatus {
  installed: boolean;
  /** Every entry is what Nook would write now: the relay has not moved. */
  current: boolean;
  fileExists: boolean;
  /** ~/.codex is there: Codex has run on this account. */
  codexFound: boolean;
  hooksPath: string;
  hookPath: string;
  hookReady: boolean;
  /** Why Nook will not write its command (a relay path with a space in it). */
  refused: string | null;
  /** hooks.json is there but is not plain JSON (comments, a trailing comma): never written over. */
  unreadable: string | null;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Nook");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}

// ── The settings window's own commands (src/settings) ─────────────────────────

/** The About section's links. The page names one; its address is a constant in Rust (about.rs). */
export type AboutLink = "portfolio" | "github" | "linkedin" | "x";

/** Where Nook keeps its files, as Rust works them out. */
export interface DataPaths {
  /** Preferences. */
  settings: string;
  /** The log and the relay. */
  local: string;
  /** Why the relay pipe is not open (Nook then hears no Claude Code events); null when it is. */
  relayError?: string | null;
}

export const SettingsBridge = {
  /** Opens one of the four fixed addresses in the system browser. */
  openLink: (which: AboutLink) => call<void>("open_link", { which }),
  dataPaths: () => call<DataPaths>("data_paths"),
  /** Opens the folder the log is in. Takes no path: the folder is Nook's own. */
  openLogFolder: () => call<void>("open_log_folder"),
  /** Closes Nook and starts it again: what puts a missing relay back. */
  restart: () => call<void>("restart_app"),
};
// ── end of the settings window's block ────────────────────────────────────────
