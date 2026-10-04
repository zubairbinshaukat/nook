// DEV ONLY. A made-up Nook for looking at the settings window in a plain
// browser: `npx vite`, then /settings.html?fake. Nothing here reads or writes
// the machine; the "writes" change a few variables of this page.
//
// It cannot be reached inside the app: backend.ts loads it only on a dev
// server, outside Tauri, with `?fake` in the address — and a build leaves this
// file out altogether.
//
// What it starts as is said in the address:
//   ?fake&section=claude|general|island|shelf|appearance|about
//        &theme=light|dark|system  &motion=system|on|off
//        &hooks=installed|none|legacy|both|relay|relay-none|unreadable
//        &usage=none|installed|chained|other
//        &reply=none|installed|outdated|unmarked|broken|missing
//        &shortcuts=ok|launch|off
//        &size=560x680            (the page drawn at that size, as the window is)

import type { CursorStatus, HookPreview, HookStatus, ReplyFormatStatus, ShortcutName, ShortcutStatus, UsageStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import type { Backend } from "./backend";

const HOME = "C:\\Users\\dev";
const SETTINGS_JSON = `${HOME}\\.claude\\settings.json`;
const RELAY = `${HOME}\\AppData\\Local\\Nook\\bin\\nook-hook.exe`;
const RELAY_BEFORE = `${HOME}\\Downloads\\Nook\\nook-hook.exe`;
const OWN_STATUS_LINE = "npx ccstatusline";
const CLAUDE_MD = `${HOME}\\.claude\\CLAUDE.md`;
const CURSOR_JSON = `${HOME}\\.cursor\\hooks.json`;
/** The block, as replyformat.rs writes it. */
const REPLY_BLOCK = [
  "<!-- nook:reply-format:start -->",
  "## Reply format",
  "- Start with a one-line summary.",
  "- Put anything I must decide in a > [!IMPORTANT] block, one per decision, with the options and your recommendation.",
  "- Put risks and unverified things in > [!WARNING].",
  "- Put recommendations in > [!TIP].",
  "- Use short sections with ## headings and bullets with **bold lead-ins**.",
  "- End with the next step.",
  "<!-- nook:reply-format:end -->",
];
const REPLY_OLD_LINE = "- Close with what happens next.";
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "SubagentStart", "SubagentStop", "Stop"];

/** The messages shortcut.rs refuses with. */
const TAKEN = "Already used by another app — pick another";
const TWICE = "Already another Nook shortcut — pick another";
/** Made up: what "another app" holds, so a refusal can be tried by hand. */
const HELD_ELSEWHERE = new Set(["Ctrl+Alt+T", "Ctrl+Shift+Escape"]);

const wait = (ms = 120) => new Promise<void>((done) => window.setTimeout(done, ms));
const stamp = () => {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
};

export function fakeBackend(): Backend {
  const q = new URLSearchParams(location.search);
  const hooksCase = q.get("hooks") ?? "installed";
  const usageCase = q.get("usage") ?? "none";
  let replyCase = q.get("reply") ?? "none";
  const shortcutCase = q.get("shortcuts") ?? "ok";

  const settings: Settings = { ...DEFAULT_SETTINGS };
  const theme = q.get("theme");
  if (theme === "light" || theme === "dark" || theme === "system") settings.theme = theme;
  const motion = q.get("motion");
  if (motion === "system" || motion === "on" || motion === "off") settings.reduceMotion = motion;

  const hooks = {
    installed: hooksCase === "installed" || hooksCase === "relay" || hooksCase === "both",
    legacy: hooksCase === "legacy" || hooksCase === "both",
    ready: hooksCase !== "relay" && hooksCase !== "relay-none",
    unreadable: hooksCase === "unreadable",
  };
  const cursor = { installed: q.get("cursor") === "installed" };
  const usage = { installed: usageCase === "installed" || usageCase === "chained", chained: usageCase === "chained", other: usageCase === "other" };
  /** Stands for the bytes of settings.json: every write changes it. */
  let revision = 1;

  const shortcuts: Record<ShortcutName, ShortcutStatus> = {
    expand: { accelerator: settings.expandShortcut, enabled: true, registered: true, error: null },
    goto: { accelerator: settings.gotoShortcut, enabled: shortcutCase !== "off", registered: shortcutCase !== "off", error: null },
    panel: { accelerator: settings.panelShortcut, enabled: true, registered: true, error: null },
  };
  if (shortcutCase === "launch") Object.assign(shortcuts.expand, { registered: false, error: TAKEN });

  let told: ((settings: Settings) => void) | null = null;

  const hookLines = (sign: string, exe: string) =>
    EVENTS.map((event) => `${sign}     "${event}": [{ "hooks": [{ "type": "command", "command": "${exe.replaceAll("\\", "\\\\")}", "args": ["${event}"] }] }]${event === "Stop" ? "" : ","}`);

  function hooksDiff(install: boolean): string {
    const head = ["  {", '    "model": "opus",', '    "permissions": { "allow": ["Bash(npm run test:*)"] },'];
    const legacy = hooks.legacy ? hookLines("-", `${HOME}\\AppData\\Local\\OldApp\\old-hook.exe`) : [];
    const own = hooks.installed ? hookLines("-", install ? RELAY_BEFORE : RELAY) : [];
    const next = install ? hookLines("+", RELAY) : [];
    const had = hooks.installed || hooks.legacy;
    return [...head, had ? '    "hooks": {' : '+   "hooks": {', ...legacy, ...own, ...next, had ? "    }" : "+   }", "  }"].join("\n");
  }

  function usageDiff(install: boolean): string {
    const relay = RELAY.replaceAll("\\", "/");
    const ours = (previous: boolean) =>
      `"statusLine": { "type": "command", "command": "${relay} statusline${previous ? " --previous eyJ0eXBlIjoiY29tbWFuZCIsImNvbW1hbmQiOiJucHggY2NzdGF0dXNsaW5lIn0" : ""}" }`;
    const theirs = `"statusLine": { "type": "command", "command": "${OWN_STATUS_LINE}" }`;
    const head = ["  {", '    "model": "opus",', '    "hooks": { … },'];
    const changed = install
      ? usage.other ? [`-   ${theirs}`, `+   ${ours(true)}`] : [`+   ${ours(false)}`]
      : [`-   ${ours(usage.chained)}`, ...(usage.chained ? [`+   ${theirs}`] : [])];
    return [...head, ...changed, "  }"].join("\n");
  }

  const preview = (diff: string): HookPreview => {
    if (hooks.unreadable) throw new Error(`${SETTINGS_JSON} is not valid JSON (expected value at line 4 column 3). Nook won't touch it — fix the file, then try again.`);
    return { diff, backup: `${SETTINGS_JSON}.bak-${stamp()}`, settingsPath: SETTINGS_JSON, fingerprint: String(revision) };
  };
  const written = (fingerprint: string): string => {
    if (fingerprint !== String(revision)) throw new Error(`${SETTINGS_JSON} changed since the preview. Nothing was written — review the new diff.`);
    revision++;
    return `${SETTINGS_JSON}.bak-${stamp()}`;
  };

  /** The made-up CLAUDE.md, before the block: a few lines of the user's own (none for `missing`). */
  const ownLines = () => (replyCase === "missing" ? [] : ["# My notes", "", "Prefer small commits."]);
  function replyDiff(action: string): string {
    const own = ownLines().map((line) => `  ${line}`);
    const gap = own.length ? [action === "install" ? "+ " : action === "remove" ? "- " : "  "] : [];
    if (action === "update") {
      return [...own, ...gap, ...REPLY_BLOCK.slice(0, -2).map((line) => `  ${line}`), `- ${REPLY_OLD_LINE}`, `+ ${REPLY_BLOCK[7]}`, `  ${REPLY_BLOCK[8]}`].join("\n");
    }
    const sign = action === "install" ? "+" : "-";
    const block = REPLY_BLOCK.map((line, i) => `${sign} ${replyCase === "outdated" && i === 7 ? REPLY_OLD_LINE : line}`);
    return [...own, ...gap, ...block].join("\n");
  }

  fakeFrame();

  return {
    fake: true,
    start: q.get("section") ?? undefined,
    async boot() {
      return { settings: { ...settings }, version: "0.0.0-fake" };
    },
    async saveSettings(next) {
      // As Rust does: the shortcuts are not a page's to write, and the page is told what was kept.
      Object.assign(settings, next, {
        expandShortcut: shortcuts.expand.accelerator, expandShortcutEnabled: shortcuts.expand.enabled,
        gotoShortcut: shortcuts.goto.accelerator, gotoShortcutEnabled: shortcuts.goto.enabled,
        panelShortcut: shortcuts.panel.accelerator, panelShortcutEnabled: shortcuts.panel.enabled,
      });
      await wait(20);
      told?.({ ...settings });
    },
    onSettingsChanged(handler) {
      told = handler;
      // What the island's own quick settings would do, to try from the console:
      // __fakeIsland({ soundEnabled: false, autoCloseInterval: 5 })
      (window as unknown as Record<string, unknown>).__fakeIsland = (patch: Partial<Settings>) => {
        Object.assign(settings, patch);
        handler({ ...settings });
      };
    },

    async hooksStatus(): Promise<HookStatus> {
      return { installed: hooks.installed, legacy: hooks.legacy, settingsPath: SETTINGS_JSON, hookPath: RELAY, hookReady: hooks.ready };
    },
    async hooksPreview(install) {
      await wait();
      return preview(hooksDiff(install));
    },
    async hooksApply(install, fingerprint) {
      await wait(300);
      const backup = written(fingerprint);
      hooks.installed = install;
      hooks.legacy = false;
      return backup;
    },

    async cursorStatus(): Promise<CursorStatus> {
      return {
        installed: cursor.installed, current: cursor.installed, fileExists: cursor.installed, cursorFound: true,
        hooksPath: CURSOR_JSON, hookPath: RELAY, hookReady: true, refused: null, unreadable: null,
      };
    },
    async cursorPreview(install) {
      await wait();
      const line = `"command": "${RELAY.replaceAll("\\", "/")} --agent cursor stop", "timeout": 5`;
      const diff = ['  {', '    "version": 1,', '    "hooks": {', install ? `+     "stop": [{ ${line} }]` : `-     "stop": [{ ${line} }]`, "    }", "  }"].join("\n");
      return { diff, backup: `${CURSOR_JSON}.bak-${stamp()}`, settingsPath: CURSOR_JSON, fingerprint: String(revision) };
    },
    async cursorApply(install, fingerprint) {
      await wait(300);
      const backup = written(fingerprint).replace(SETTINGS_JSON, CURSOR_JSON);
      cursor.installed = install;
      return backup;
    },

    async usageStatus(): Promise<UsageStatus> {
      return { installed: usage.installed, chained: usage.chained, otherStatusLine: usage.other, settingsPath: SETTINGS_JSON };
    },
    async usagePreview(install) {
      await wait();
      return preview(usageDiff(install));
    },
    async usageApply(install, fingerprint) {
      await wait(300);
      const backup = written(fingerprint);
      if (install) Object.assign(usage, { installed: true, chained: usage.other, other: false });
      else Object.assign(usage, { installed: false, other: usage.chained, chained: false });
      return backup;
    },

    async replyFormatStatus(): Promise<ReplyFormatStatus> {
      const state = replyCase === "installed" || replyCase === "outdated" || replyCase === "unmarked" ? replyCase
        : replyCase === "broken" ? "error" : "notInstalled";
      return {
        state,
        found: state === "unmarked" ? ["## Reply format", "- Lead with the answer, then the detail.", "- Put recommendations in > [!TIP]."] : [],
        error: state === "error"
          ? "Nook's reply-format markers in CLAUDE.md are broken: the start marker has no end marker. Nook won't change the file — fix or remove the marker lines by hand (<!-- nook:reply-format:start --> … <!-- nook:reply-format:end -->)."
          : null,
        path: CLAUDE_MD,
        exists: replyCase !== "missing",
      };
    },
    async replyFormatPreview(action) {
      await wait();
      return { diff: replyDiff(action), backup: `${CLAUDE_MD}.bak-${stamp()}`, settingsPath: CLAUDE_MD, fingerprint: String(revision) };
    },
    async replyFormatApply(action, fingerprint) {
      await wait(300);
      if (fingerprint !== String(revision)) throw new Error(`${CLAUDE_MD} changed since the preview. Nothing was written — review the new diff.`);
      revision++;
      replyCase = action === "remove" ? "none" : "installed";
      return `${CLAUDE_MD}.bak-${stamp()}`;
    },

    async shortcutStatus() {
      return { expand: { ...shortcuts.expand }, goto: { ...shortcuts.goto }, panel: { ...shortcuts.panel } };
    },
    async setShortcut(which, accelerator, enabled) {
      await wait(60);
      const parts = accelerator.split("+");
      if (!parts.some((p) => p === "Ctrl" || p === "Alt" || p === "Super")) throw new Error("Press a key together with Ctrl, Alt or Win");
      const others = (Object.keys(shortcuts) as ShortcutName[]).filter((name) => name !== which);
      if (others.some((name) => shortcuts[name].accelerator === accelerator)) throw new Error(TWICE);
      if (enabled && HELD_ELSEWHERE.has(accelerator)) throw new Error(TAKEN);
      shortcuts[which] = { accelerator, enabled, registered: enabled, error: null };
      return { ...shortcuts[which] };
    },

    async openLink(which) {
      console.info(`[fake] the system browser would open the "${which}" link`);
    },
    async dataPaths() {
      return { settings: `${HOME}\\AppData\\Roaming\\Nook`, local: `${HOME}\\AppData\\Local\\Nook` };
    },
    async openLogFolder() {
      console.info("[fake] the log folder would open in the file manager");
    },
    async restart() {
      console.info("[fake] Nook would close and start again");
      await wait(400);
      hooks.ready = true;
    },
  };
}

/** `?size=560x680`: the page at the window's size, in a browser that cannot be made that small. */
function fakeFrame() {
  const size = /^(\d{3,4})x(\d{3,4})$/.exec(new URLSearchParams(location.search).get("size") ?? "");
  if (!size) return;
  document.documentElement.classList.add("fake-frame");
  document.body.style.width = `${size[1]}px`;
  document.body.style.height = `${size[2]}px`;
}
