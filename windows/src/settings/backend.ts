// What the settings window asks of Nook, in one place: the commands of
// core/bridge.ts that it uses, and nothing else. The window is written against
// this, so the same page can be looked at in a plain browser on made-up data
// (fake.ts) without one line of it knowing.

import {
  Bridge, IS_TAURI, SettingsBridge, onEvent,
  type AboutLink, type CursorStatus, type DataPaths, type HookPreview, type HookStatus, type ReplyFormatAction, type ReplyFormatStatus, type ShortcutName,
  type ShortcutStatus, type UsageStatus,
} from "../core/bridge";
import type { Settings } from "../core/state";

export interface Backend {
  /** Made-up data, in a browser: the window says so. */
  fake: boolean;
  /** The section to open on, when something other than the first is asked for (the made-up one only). */
  start?: string;
  boot(): Promise<{ settings: Settings; version: string } | null>;
  saveSettings(settings: Settings): Promise<void>;
  onSettingsChanged(handler: (settings: Settings) => void): void;

  hooksStatus(): Promise<HookStatus | null>;
  /** Throws what Rust refused with: an unreadable settings.json is never treated as empty. */
  hooksPreview(install: boolean): Promise<HookPreview>;
  /** Writes — only ever called from the confirm button, with the fingerprint of the diff on show. */
  hooksApply(install: boolean, fingerprint: string): Promise<string>;

  /** Cursor's hooks.json: the same flow, status only. */
  cursorStatus(): Promise<CursorStatus | null>;
  cursorPreview(install: boolean): Promise<HookPreview>;
  cursorApply(install: boolean, fingerprint: string): Promise<string>;

  usageStatus(): Promise<UsageStatus | null>;
  usagePreview(install: boolean): Promise<HookPreview>;
  usageApply(install: boolean, fingerprint: string): Promise<string>;

  /** The reply format's block in ~/.claude/CLAUDE.md: the same flow, on another file. */
  replyFormatStatus(): Promise<ReplyFormatStatus | null>;
  replyFormatPreview(action: ReplyFormatAction): Promise<HookPreview>;
  replyFormatApply(action: ReplyFormatAction, fingerprint: string): Promise<string>;

  shortcutStatus(): Promise<Record<ShortcutName, ShortcutStatus> | null>;
  setShortcut(which: ShortcutName, accelerator: string, enabled: boolean): Promise<ShortcutStatus>;

  openLink(which: AboutLink): Promise<void>;
  dataPaths(): Promise<DataPaths | null>;
  openLogFolder(): Promise<void>;
  restart(): Promise<void>;
}

const nook: Backend = {
  fake: false,
  boot: () => Bridge.boot(),
  saveSettings: async (settings) => void (await Bridge.saveSettings(settings)),
  onSettingsChanged: (handler) => void onEvent<Settings>("settings-changed", handler),
  hooksStatus: () => Bridge.hooksStatus(),
  hooksPreview: (install) => Bridge.hooksPreview(install),
  hooksApply: (install, fingerprint) => Bridge.hooksApply(install, fingerprint),
  cursorStatus: () => Bridge.cursorStatus(),
  cursorPreview: (install) => Bridge.cursorPreview(install),
  cursorApply: (install, fingerprint) => Bridge.cursorApply(install, fingerprint),
  usageStatus: () => Bridge.usageStatus(),
  usagePreview: (install) => Bridge.usagePreview(install),
  usageApply: (install, fingerprint) => Bridge.usageApply(install, fingerprint),
  replyFormatStatus: () => Bridge.replyFormatStatus(),
  replyFormatPreview: (action) => Bridge.replyFormatPreview(action),
  replyFormatApply: (action, fingerprint) => Bridge.replyFormatApply(action, fingerprint),
  shortcutStatus: () => Bridge.shortcutStatus(),
  setShortcut: (which, accelerator, enabled) => Bridge.setShortcut(which, accelerator, enabled),
  openLink: async (which) => void (await SettingsBridge.openLink(which)),
  dataPaths: () => SettingsBridge.dataPaths(),
  openLogFolder: async () => void (await SettingsBridge.openLogFolder()),
  restart: async () => void (await SettingsBridge.restart()),
};

/**
 * Nook itself — always, inside the app. The made-up one needs all three of: a
 * dev server (`import.meta.env.DEV` is false in every build, so a bundle does
 * not even contain fake.ts), a plain browser (no Tauri), and `?fake` in the
 * address. Inside Nook the second is never true, whatever the address says.
 */
export async function connect(): Promise<Backend> {
  if (import.meta.env.DEV && !IS_TAURI && new URLSearchParams(location.search).has("fake")) {
    const { fakeBackend } = await import("./fake");
    return fakeBackend();
  }
  return nook;
}
