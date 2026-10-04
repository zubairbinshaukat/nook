// The settings window: a sidebar of sections — Claude Code, General, Island,
// Shelf, Appearance, About — and one section on show at a time.
//
// Every setting applies at once. Only what writes to Claude Code's
// settings.json asks first: Nook shows the diff, and nothing is written until
// the button under it is pressed — with the fingerprint of the diff on show,
// so a file that changed in between is refused by Rust rather than written over.

import "./settings.css";
import type { AboutLink, CursorStatus, DataPaths, HookPreview, HookStatus, ReplyFormatAction, ReplyFormatStatus, ShortcutName, ShortcutStatus, UsageStatus } from "../core/bridge";
import { COMPACT_METRICS, DEFAULT_SETTINGS, FOLDED_AUTO_HIDE, MAX_COMPACT_METRICS, compactMetrics, foldedAutoHide, type CompactMetric, type Settings } from "../core/state";
import { BOT_THEMES } from "../bot/engine";
import { clear, h } from "../views/dom";
import { BRANDS, LUCIDE, brand } from "../views/iconset";
import { connect, type Backend } from "./backend";
import { isBotTheme, mountBot, refreshBots, startBots, wearBotTheme } from "./bots";
import { COMPACT_BOT, COMPACT_CELLS, cellIcon, islandPreview } from "./island-preview";
import { SPRING, flip, icon, reorderable, segmented, slider, toggle, type Segmented, type Toggle } from "./ui";

// ── What the window knows ─────────────────────────────────────────────────────

const SECTIONS = ["claude", "general", "island", "shelf", "appearance", "about"] as const;
type Section = (typeof SECTIONS)[number];
type Theme = Settings["theme"];
type Motion = Settings["reduceMotion"];

let nook: Backend;
let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";
let hooks: HookStatus | null = null;
let usage: UsageStatus | null = null;
let reply: ReplyFormatStatus | null = null;
let cursor: CursorStatus | null = null;
/** The last write of the reply format created CLAUDE.md: there was no previous file to save. */
let wasCreated = false;
let paths: DataPaths | null = null;
let shortcutsNow: Record<ShortcutName, ShortcutStatus> | null = null;
let section: Section = "claude";

const page = document.documentElement;
const root = document.getElementById("settings-root")!;

/** What Rust, or the bridge, refused with — as a sentence, without the "Error:" a thrown one carries. */
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error:\s*/, "");

// ── Saving: at once, and in step with the island ──────────────────────────────

/** When each setting was last changed here: an echo of an older save does not undo it. */
const touched = new Map<string, number>();
const OWN_FOR_MS = 500;
let saveTimer = 0;

function save() {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  void nook.saveSettings(settings);
}

/**
 * A setting changed in this window: kept, and written — at once, or a moment
 * after the last of a run of changes (`soon`: a slider being dragged).
 */
function change(patch: Partial<Settings>, soon = false) {
  settings = { ...settings, ...patch };
  const now = performance.now();
  for (const key of Object.keys(patch)) touched.set(key, now);
  applyAppearance();
  if (!soon) return save();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 140);
}

/** What the section on show does when the settings change under it. Emptied when another takes its place. */
let followers: (() => void)[] = [];
/** What it must stop when it goes. */
let leavers: (() => void)[] = [];

/**
 * `settings-changed`: Rust has saved — this window's own change coming back,
 * or one made in the island's quick settings. What was changed here a moment
 * ago is not taken back from an older echo.
 */
function settingsChanged(next: Settings) {
  const now = performance.now();
  const mine: Record<string, unknown> = {};
  for (const [key, at] of touched) {
    if (now - at < OWN_FOR_MS) mine[key] = (settings as unknown as Record<string, unknown>)[key];
    else touched.delete(key);
  }
  settings = { ...settings, ...next, ...(mine as Partial<Settings>) };
  applyAppearance();
  for (const follow of followers) follow();
}

// ── Theme and motion ──────────────────────────────────────────────────────────

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const systemStill = window.matchMedia("(prefers-reduced-motion: reduce)");
const resolvedTheme = (): "light" | "dark" => (settings.theme === "system" ? (systemDark.matches ? "dark" : "light") : settings.theme);
/** Nothing travels or fades. */
const still = (): boolean => (settings.reduceMotion === "system" ? systemStill.matches : settings.reduceMotion === "on");

/** The window in the theme, the motion and the bot colours the settings say. */
function applyAppearance() {
  page.dataset.theme = resolvedTheme();
  page.dataset.motion = still() ? "reduce" : "full";
  wearBotTheme(settings.botTheme);
}

page.style.setProperty("--spring", SPRING.easing);
page.style.setProperty("--spring-ms", `${SPRING.ms}ms`);
applyAppearance();

// ── The bot: three of him, made once ──────────────────────────────────────────

const sideBot = mountBot(20);
const islandBot = mountBot(COMPACT_BOT);
const aboutBot = mountBot(46);
sideBot.setState("idle");
islandBot.setState("approval");
aboutBot.setState("idle");

// ── The window ────────────────────────────────────────────────────────────────

const TABS: Record<Section, { name: string; icon: string }> = {
  claude: { name: "Claude Code", icon: LUCIDE.squareTerminal },
  general: { name: "General", icon: LUCIDE.slidersHorizontal },
  island: { name: "Island", icon: LUCIDE.panelTop },
  shelf: { name: "Shelf", icon: LUCIDE.layoutGrid },
  appearance: { name: "Appearance", icon: LUCIDE.palette },
  about: { name: "About", icon: LUCIDE.info },
};

const navMark = h("i", { class: "sp-nav-mark" });
const nav = h("div", { class: "sp-nav", role: "tablist", "aria-orientation": "vertical", "aria-label": "Settings sections" }, navMark);
const tabs = new Map<Section, HTMLButtonElement>();
for (const id of SECTIONS) {
  const tab = h("button", {
    class: "sp-tab", type: "button", role: "tab", id: `tab-${id}`, "aria-controls": "sp-pane",
    // The name stays on the tab when the sidebar folds to its icons.
    "aria-label": TABS[id].name, title: TABS[id].name,
  }, icon(TABS[id].icon, 17, 1.9), h("span", { text: TABS[id].name }));
  tab.addEventListener("click", () => setSection(id));
  tabs.set(id, tab);
  nav.append(tab);
}

// One stop in the tab order: Up, Down, Home and End move between the sections.
nav.addEventListener("keydown", (e) => {
  const at = SECTIONS.indexOf(section);
  const to =
    e.key === "ArrowDown" ? (at + 1) % SECTIONS.length
    : e.key === "ArrowUp" ? (at - 1 + SECTIONS.length) % SECTIONS.length
    : e.key === "Home" ? 0
    : e.key === "End" ? SECTIONS.length - 1
    : -1;
  if (to < 0) return;
  e.preventDefault();
  setSection(SECTIONS[to]);
  tabs.get(SECTIONS[to])!.focus();
});

const main = h("main", { class: "sp-main" });
/** Says what a move or a refusal did, to a screen reader. */
const live = h("div", { class: "sp-sr", role: "status", "aria-live": "polite" });
const say = (text: string) => (live.textContent = text);
const versionLine = h("span");

// ── Small pieces every section uses ───────────────────────────────────────────

type Kid = Node | string | null | undefined | false;

const title = (text: string, lede?: string): Kid[] => [
  h("h1", { class: "sp-title", text }),
  lede ? h("p", { class: "sp-lede", text: lede }) : null,
];

const group = (label: string | null, ...kids: Kid[]) =>
  h("section", { class: "sp-group" }, label ? h("h2", { class: "sp-group-label", text: label }) : null, ...kids);

/** A setting: its name and help on the left, its control on the right. */
const row = (label: string, help: string | null, control: Kid, extra = "") =>
  h("div", { class: `sp-row ${extra}` },
    h("div", { class: "sp-row-text" },
      h("div", { class: "sp-row-label", text: label }),
      help ? h("p", { class: "sp-help", text: help }) : null),
    control);

/** A path, free to wrap after any of its separators and nowhere else. */
const breakable = (path: string): Kid[] =>
  path.split(/(?<=[\\/])/).flatMap((part, i) => (i ? [h("wbr"), part] : [part]));

const button = (text: string, kind: string, onClick: () => void) =>
  h("button", { class: `sp-btn ${kind}`, type: "button", text, onclick: onClick });

// ── Claude Code ───────────────────────────────────────────────────────────────

/**
 * What Nook writes for Claude Code: the hooks and the status line the usage
 * limits come through, in ~/.claude/settings.json; the reply format, in
 * ~/.claude/CLAUDE.md. One flow for the three: the diff, then an explicit click.
 */
type Change = "hooks" | "usage" | "reply" | "cursor";
const CHANGES: readonly Change[] = ["hooks", "usage", "reply", "cursor"];
/** The file each one changes, as the panel names it. (Cursor's is ~/.cursor/hooks.json: the same flow.) */
const CHANGED_FILE: Record<Change, string> = { hooks: "settings.json", usage: "settings.json", reply: "CLAUDE.md", cursor: "hooks.json" };

/** Where a part's install flow is at: its status, or the diff to confirm. */
type Flow =
  | { at: "status"; error?: string; done?: { install: boolean; backup: string }; note?: string }
  | { at: "confirm"; install: boolean; preview: HookPreview; error?: string; busy?: boolean; action?: ReplyFormatAction };

const flows: Record<Change, Flow> = { hooks: { at: "status" }, usage: { at: "status" }, reply: { at: "status" }, cursor: { at: "status" } };

/** What the preview panel says of each change, before and after it is written. */
const CHANGE_WORDS: Record<Change, { install: string; remove: string; done: string }> = {
  hooks: {
    install: "This is exactly what will change in your settings.json. Your own hooks are left untouched.",
    remove: "This removes Nook's entries only. Your own hooks are left untouched.",
    done: "Open a new Claude Code session to pick the hooks up.",
  },
  usage: {
    install: "This is exactly what will change in your settings.json: the statusLine key, and nothing else. A status line you already have is kept inside the new command, as the long word after --previous: it still runs, and Uninstall puts it back as it was.",
    remove: "This takes Nook out of the statusLine key only. The status line you had before comes back exactly as it was; with none, the key is removed.",
    done: "Claude Code picks the change up when it reloads its settings; a new session does for sure.",
  },
  reply: {
    install: "This is exactly what will change in your CLAUDE.md: the block between the two marker lines, and nothing outside them.",
    remove: "This removes the two marker lines, what is between them, and the blank line Nook added before them. Everything else in your CLAUDE.md stays as it is.",
    done: "Applies to new sessions.",
  },
  cursor: {
    install: "This is exactly what will change in your Cursor hooks.json: Nook's entries, and nothing else. Your own hooks and any other key are left as they are.",
    remove: "This removes Nook's entries only. Your own hooks are left untouched.",
    done: "Cursor reloads hooks.json when it is saved. If sessions do not show up, restart Cursor.",
  },
};

type Tone = "ok" | "off" | "warn" | "error";
const TONE_ICON: Record<Tone, string> = {
  ok: LUCIDE.circleCheck, off: LUCIDE.circleMinus, warn: LUCIDE.triangleAlert, error: LUCIDE.circleX,
};

interface Spec {
  name: string;
  tone: Tone;
  title: string;
  text: string;
  /** Quiet lines under the text: what to know before saying yes. */
  notes?: string[];
  facts: [string, string][];
  /** The one filled button, if the state calls for one. `blocked`: why it cannot be pressed. */
  primary?: { label: string; act: "install" | "restart"; blocked?: string };
  /** Lines of the user's own file, shown as they are and never changed. */
  found?: string[];
  /** A quiet way to write the entries again. */
  again?: string;
  remove?: string;
}

const RELAY_MISSING = "The relay isn't installed yet.";
const UNREACHABLE: Omit<Spec, "name"> = {
  tone: "off", title: "Not available",
  text: "Nook did not answer, so there is nothing to show here. Close this window and open it again from the island or the tray.",
  facts: [],
};

function hooksSpec(): Spec {
  const s = hooks;
  if (!s) return { name: "Hooks", ...UNREACHABLE };
  const file: [string, string] = ["settings.json", s.settingsPath];
  const relay: [string, string] = ["Relay", s.hookPath];
  const relayName = s.hookPath.split(/[\\/]/).pop() || "The relay";
  if (!s.hookReady) {
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook: installing is not on offer.
    return {
      name: "Hooks", tone: "error", title: "Relay missing",
      text: s.installed
        ? `The hooks are installed, but ${relayName} is not where they point, so no session can reach Nook. Restarting Nook puts it back.`
        : `${relayName} is not in place yet, and hooks installed now would point at nothing. Restarting Nook puts it back.`,
      notes: ["Still missing after a restart? Installing Nook again puts it back; from the source, cargo build -p nook-hook builds it."],
      facts: [file, relay],
      primary: { label: "Restart Nook", act: "restart" },
      remove: s.installed ? "Uninstall…" : s.legacy ? "Remove old hooks…" : undefined,
    };
  }
  if (s.legacy) {
    return {
      name: "Hooks", tone: "warn", title: "Old hooks found",
      text: s.installed
        ? "Nook's hooks are installed, and hooks from an older version are still beside them. Replacing takes the old ones out."
        : "Hooks from an older version are still installed. Nook cannot hear your sessions until its own take their place.",
      facts: [file, relay],
      primary: { label: "Replace them…", act: "install" },
      remove: s.installed ? "Uninstall…" : "Remove them…",
    };
  }
  if (s.installed) {
    return {
      name: "Hooks", tone: "ok", title: "Connected",
      text: "Hooks are installed and current. Your sessions, their questions and their permission requests show up in the island, and you can answer them there.",
      facts: [file, relay], again: "Reinstall…", remove: "Uninstall…",
    };
  }
  return {
    name: "Hooks", tone: "off", title: "Not installed",
    text: "Install the hooks to see your Claude Code sessions in the island, and to answer permission requests without leaving what you are doing.",
    facts: [file], primary: { label: "Install hooks…", act: "install" },
  };
}

function usageSpec(): Spec {
  const u = usage;
  if (!u) return { name: "Usage limits", ...UNREACHABLE };
  const how = "Reads the usage numbers Claude Code already passes to its status line. Nothing leaves this machine. Numbers appear on subscription plans and refresh only while a session runs.";
  const hints = "Claude Code hides its keyboard hints (\"? for shortcuts\") while any status line is set.";
  if (u.installed) {
    return {
      name: "Usage limits", tone: "ok",
      title: u.chained ? "Installed, after your status line" : "Installed",
      text: u.chained
        ? "Claude Code hands its 5-hour and weekly limits to Nook, which then runs the status line you already had, so it keeps showing."
        : "Claude Code hands its 5-hour and weekly limits to Nook through its status line. Nook prints none of its own.",
      notes: [how, u.chained ? "Uninstall puts your status line back exactly as it was." : hints],
      facts: [["Key", "statusLine"]],
      remove: "Uninstall…",
    };
  }
  return {
    name: "Usage limits", tone: "off", title: "Not installed",
    text: "Shows your 5-hour and weekly limits in the island.",
    notes: [
      how,
      u.otherStatusLine
        ? "You have a status line: Nook runs it after reading the numbers, so it keeps showing, and Uninstall puts it back exactly."
        : `You have no status line: Nook prints none. ${hints}`,
    ],
    facts: [],
    // The same relay as the hooks': a status line pointing at one that isn't there shows nothing.
    primary: { label: "Install…", act: "install", blocked: hooks && !hooks.hookReady ? RELAY_MISSING : undefined },
  };
}

const CURSOR_DOES = "Shows Cursor's agent sessions in the island next to Claude Code's, for their status only: Nook cannot approve, deny or answer anything in Cursor, and follows only events that cannot change what Cursor does.";

function cursorSpec(): Spec {
  const c = cursor;
  if (!c) return { name: "Cursor", ...UNREACHABLE };
  const file: [string, string] = ["hooks.json", c.hooksPath];
  const relay: [string, string] = ["Relay", c.hookPath];
  if (c.unreadable) return { name: "Cursor", tone: "error", title: "Can't be changed", text: c.unreadable, facts: [file] };
  if (c.refused) return { name: "Cursor", tone: "error", title: "Can't be written", text: c.refused, facts: [file, relay] };
  if (!c.hookReady) {
    return {
      name: "Cursor", tone: "error", title: "Relay missing",
      text: "The relay is not in place yet, and hooks written now would point at nothing. Restarting Nook puts it back.",
      facts: [file, relay], primary: { label: "Restart Nook", act: "restart" }, remove: c.installed ? "Uninstall…" : undefined,
    };
  }
  if (c.installed && !c.current) {
    return {
      name: "Cursor", tone: "warn", title: "Needs an update",
      text: "Nook's entries in hooks.json point at a relay that has moved. Updating rewrites them, and nothing else.",
      facts: [file, relay], primary: { label: "Update…", act: "install" }, remove: "Uninstall…",
    };
  }
  if (c.installed) {
    return {
      name: "Cursor", tone: "ok", title: "Connected", text: CURSOR_DOES,
      notes: ["Cursor reloads hooks.json when it is saved; if a session does not show up, restart Cursor."],
      facts: [file, relay], again: "Reinstall…", remove: "Uninstall…",
    };
  }
  return {
    name: "Cursor", tone: "off", title: "Not installed", text: CURSOR_DOES,
    notes: [
      c.cursorFound
        ? c.fileExists ? "Your hooks.json is kept: Nook adds its own entries beside yours." : "You have no hooks.json yet: the file is created."
        : "There is no .cursor folder here, so Cursor may not be installed. Nook can still create hooks.json, and it works once Cursor is.",
      "After installing, restart Cursor if its sessions do not show up.",
    ],
    facts: [file], primary: { label: "Install hooks…", act: "install" },
  };
}

/** The reply format's one sentence, said the same whatever its state. */
const REPLY_DOES = "Asks Claude Code to shape its replies so Nook can show decisions, warnings and tips. Adds a marked block to your CLAUDE.md.";
const REPLY_WHEN = "Applies to new sessions.";

function replySpec(): Spec {
  const r = reply;
  if (!r) return { name: "Reply format", ...UNREACHABLE };
  const file: [string, string] = ["CLAUDE.md", r.path];
  switch (r.state) {
    case "installed":
      return { name: "Reply format", tone: "ok", title: "Installed", text: REPLY_DOES, notes: [REPLY_WHEN], facts: [file], remove: "Remove…" };
    case "outdated":
      return {
        name: "Reply format", tone: "warn", title: "Installed, but outdated",
        text: "The block in your CLAUDE.md is not Nook's current text. Updating replaces what is between the two marker lines, and nothing else.",
        notes: [REPLY_DOES, REPLY_WHEN], facts: [file],
        primary: { label: "Update…", act: "install" }, remove: "Remove…",
      };
    case "unmarked":
      return {
        name: "Reply format", tone: "warn", title: "Found without markers",
        text: "Your CLAUDE.md already has a reply format of its own, without Nook's markers. Nook won't add a second one, and won't change yours. These are the lines it found:",
        found: r.found,
        notes: ["To let Nook manage it, remove those lines yourself and come back: Install is then on offer."],
        facts: [file],
      };
    case "error":
      return { name: "Reply format", tone: "error", title: "Can't be changed", text: r.error ?? "CLAUDE.md can't be read.", facts: [file] };
    default:
      return {
        name: "Reply format", tone: "off", title: "Not installed", text: REPLY_DOES,
        notes: [REPLY_WHEN, r.exists ? "The block is added at the end of the file, after one blank line." : "You have no CLAUDE.md yet: the file is created, with the block and nothing else."],
        facts: [file], primary: { label: "Install…", act: "install" },
      };
  }
}

const SPECS: Record<Change, () => Spec> = { hooks: hooksSpec, usage: usageSpec, reply: replySpec, cursor: cursorSpec };
/** Each part's block, repainted in place: set while the section is on show. */
const painters: Partial<Record<Change, (opening?: boolean, focus?: "primary" | "panel") => void>> = {};
const paintClaude = () => {
  for (const kind of CHANGES) painters[kind]?.();
};

async function readClaude() {
  const [h2, u, r, c] = await Promise.all([nook.hooksStatus(), nook.usageStatus(), nook.replyFormatStatus(), nook.cursorStatus()]);
  hooks = h2;
  usage = u;
  reply = r;
  cursor = c;
}

/** The diff of what `install` (or removing) would write: asked of Rust, and shown. Nothing is written here. */
async function openPreview(kind: Change, install: boolean) {
  // One diff at a time: the other parts go back to their status.
  const others = CHANGES.filter((other) => other !== kind);
  for (const other of others) if (flows[other].at === "confirm") flows[other] = { at: "status" };
  const paintOthers = () => others.forEach((other) => painters[other]?.());
  // The reply format's block is added, brought up to date, or taken out: said as it stands now.
  const action: ReplyFormatAction = !install ? "remove" : reply?.state === "outdated" ? "update" : "install";
  try {
    const preview = kind === "reply" ? await nook.replyFormatPreview(action)
      : kind === "usage" ? await nook.usagePreview(install)
        : kind === "cursor" ? await nook.cursorPreview(install)
          : await nook.hooksPreview(install);
    flows[kind] = { at: "confirm", install, preview, action };
    paintOthers();
    painters[kind]?.(true, "panel");
  } catch (err) {
    // An unreadable or invalid file stops here rather than being treated as
    // empty and written over.
    flows[kind] = { at: "status", error: reason(err) };
    paintOthers();
    painters[kind]?.(false, "primary");
  }
}

/** The confirm button of the diff on show: the one place a write is asked for. */
async function writeChange(kind: Change) {
  const flow = flows[kind];
  if (flow.at !== "confirm" || flow.busy) return;
  flow.busy = true;
  flow.error = undefined;
  painters[kind]?.();
  try {
    const backup = kind === "reply"
      ? await nook.replyFormatApply(flow.action ?? (flow.install ? "install" : "remove"), flow.preview.fingerprint)
      : kind === "usage"
        ? await nook.usageApply(flow.install, flow.preview.fingerprint)
        : kind === "cursor"
          ? await nook.cursorApply(flow.install, flow.preview.fingerprint)
          : await nook.hooksApply(flow.install, flow.preview.fingerprint);
    if (kind === "reply") wasCreated = reply?.exists === false;
    if (kind === "cursor") wasCreated = cursor?.fileExists === false;
    flows[kind] = { at: "status", done: { install: flow.install, backup } };
    await readClaude();
    paintClaude();
    say(flow.install ? "Written." : "Removed.");
  } catch (err) {
    flow.busy = false;
    flow.error = `Could not write: ${reason(err)}`;
    painters[kind]?.(false, "panel");
  }
}

function diffPanel(kind: Change, flow: Extract<Flow, { at: "confirm" }>, close: () => void): HTMLElement {
  const words = CHANGE_WORDS[kind];
  const fileName = CHANGED_FILE[kind];
  // A file that is not there yet has nothing to copy: said, rather than a backup promised.
  const created = (kind === "reply" && reply?.exists === false) || (kind === "cursor" && cursor?.fileExists === false);
  const lines = flow.preview.diff.split("\n");
  const added = lines.filter((l) => l.startsWith("+")).length;
  const removed = lines.filter((l) => l.startsWith("-")).length;
  const box = h("div", { class: "sp-diff", tabindex: "0", role: "region", "aria-label": `Changes to ${fileName}` });
  for (const line of lines) {
    const sign = line[0] === "+" || line[0] === "-" ? line[0] : " ";
    // Rust writes "+ ", "- " or two spaces before each line.
    box.append(h("div", { class: sign === "+" ? "add" : sign === "-" ? "del" : "", "data-sign": sign, text: line.slice(line[1] === " " ? 2 : 1) }));
  }
  const confirm = button(created ? "Create the file" : flow.install ? "Back up and write" : "Back up and remove", flow.install ? "primary" : "danger solid", () => void writeChange(kind));
  const cancel = button("Cancel", "quiet", close);
  confirm.disabled = cancel.disabled = Boolean(flow.busy);
  const panel = h("div", { class: "sp-panel" },
    h("div", { class: "sp-panel-head" },
      h("span", { text: `Changes to ${fileName}` }),
      h("span", { class: "counts" },
        h("span", { class: "plus", text: `+${added}` }), h("span", { class: "minus", text: `−${removed}` }))),
    h("p", { class: "sp-help", text: flow.install ? words.install : words.remove }),
    box,
    added + removed === 0 ? h("p", { class: "sp-help", text: `Nothing would change: ${fileName} already says this.` }) : null,
    created
      ? h("p", { class: "sp-help", text: "There is no file to back up: it is created." })
      : h("p", { class: "sp-help" }, "A dated backup is taken first: ", h("code", {}, ...breakable(flow.preview.backup))),
    flow.error ? h("div", { class: "sp-flash error", role: "alert" }, icon(LUCIDE.circleX, 15), h("span", { text: flow.error })) : null,
    h("div", { class: "sp-panel-actions" }, confirm, cancel));
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !flow.busy) {
      e.preventDefault();
      close();
    }
  });
  return panel;
}

/** Something Nook writes into settings.json: where it stands, its one action, and the diff that action would write. */
function integration(kind: Change): HTMLElement {
  const slot = h("div");
  const paint = (opening = false, focus?: "primary" | "panel") => {
    const spec = SPECS[kind]();
    const flow = flows[kind];
    const scrollOfDiff = slot.querySelector(".sp-panel .sp-diff")?.scrollTop;

    const head = h("div", { class: "sp-status-head" },
      h("span", { class: "sp-status-icon" }, icon(TONE_ICON[spec.tone], 22, 1.8)),
      h("div", {},
        h("div", { class: "sp-status-title" }, h("span", { text: spec.title })),
        h("p", { class: "sp-status-text", text: spec.text })));
    const block = h("div", { class: "sp-status", "data-tone": spec.tone, role: "group", "aria-label": spec.name }, head);

    if (spec.found?.length) {
      // Somebody's own lines: shown as they are, and nothing here acts on them.
      block.append(h("div", { class: "sp-diff sp-found", tabindex: "0", role: "region", "aria-label": `Lines found in ${CHANGED_FILE[kind]}` },
        ...spec.found.map((line) => h("div", { "data-sign": " ", text: line || " " }))));
    }
    if (spec.notes?.length) block.append(h("div", { class: "sp-status-notes" }, ...spec.notes.map((text) => h("p", { text }))));
    if (spec.facts.length) {
      const facts = h("dl", { class: "sp-facts" });
      for (const [k, v] of spec.facts) facts.append(h("dt", { text: k }), h("dd", {}, ...breakable(v)));
      block.append(facts);
    }

    if (flow.at === "status" && flow.done) {
      // A file Nook created had no previous one to save.
      const saved = (kind === "reply" || kind === "cursor") && wasCreated ? [] : ["The previous file is saved as ", ...breakable(flow.done.backup), ". "];
      block.append(h("div", { class: "sp-flash", role: "status" }, icon(LUCIDE.check, 15, 2.4),
        h("span", {}, flow.done.install ? "Written. " : "Removed. ", ...saved, CHANGE_WORDS[kind].done)));
    }
    if (flow.at === "status" && flow.error) {
      block.append(h("div", { class: "sp-flash error", role: "alert" }, icon(LUCIDE.circleX, 15), h("span", { text: flow.error })));
    }
    if (flow.at === "status" && flow.note) {
      block.append(h("div", { class: "sp-flash note", role: "status" }, icon(LUCIDE.info, 15), h("span", { text: flow.note })));
    }

    const confirming = flow.at === "confirm";
    const go = (install: boolean) => void openPreview(kind, install);
    const actions = h("div", { class: "sp-actions" });
    if (spec.primary) {
      const { act, blocked, label } = spec.primary;
      const b = button(label, "primary", () => {
        if (act === "install") return go(true);
        flows[kind] = { at: "status", note: "Restarting Nook…" };
        paint();
        void nook.restart().then(() => window.setTimeout(async () => {
          // Only reached where the window outlives the restart: a browser, or a restart that did not happen.
          flows[kind] = { at: "status" };
          await readClaude();
          paintClaude();
        }, 1500));
      });
      actions.append(b);
      if (blocked) {
        b.disabled = true;
        b.title = blocked;
        actions.append(h("span", { class: "sp-actions-note", text: blocked }));
      }
    }
    if (spec.again) actions.append(button(spec.again, "quiet", () => go(true)));
    if (spec.remove) actions.append(button(spec.remove, `danger${actions.childElementCount ? " push" : ""}`, () => go(false)));
    // While the diff is open, its two buttons are the only way on.
    if (!confirming && actions.childElementCount) block.append(actions);

    const fold = h("div", { class: "sp-fold" });
    if (confirming) {
      fold.append(h("div", {}, diffPanel(kind, flow, () => {
        flows[kind] = { at: "status" };
        paint(false, "primary");
      })));
    }
    block.append(fold);
    clear(slot);
    slot.append(block);
    if (confirming) {
      // Shut, then open: the panel unfolds from the block's lower edge.
      if (opening && !still()) void fold.offsetHeight;
      fold.classList.add("open");
      const box = block.querySelector<HTMLElement>(".sp-panel .sp-diff")!;
      if (opening) {
        // The whole file is in the diff: start at the first line that changes.
        const first = box.querySelector<HTMLElement>(".add, .del");
        if (first) box.scrollTop = Math.max(0, first.getBoundingClientRect().top - box.getBoundingClientRect().top - 36);
      } else if (scrollOfDiff != null) {
        box.scrollTop = scrollOfDiff;
      }
    }
    if (focus === "panel") block.querySelector<HTMLElement>(".sp-panel .sp-btn:not(:disabled)")?.focus({ preventScroll: opening });
    if (focus === "primary") block.querySelector<HTMLElement>(".sp-actions .sp-btn:not(:disabled)")?.focus();
    if (opening) block.querySelector(".sp-panel")?.scrollIntoView({ block: "nearest", behavior: still() ? "auto" : "smooth" });
  };
  painters[kind] = paint;
  paint();
  return slot;
}

function claudeSection(): Kid[] {
  leavers.push(() => {
    // What was said of the last change, or an open diff, does not wait for the next visit.
    for (const kind of CHANGES) {
      delete painters[kind];
      flows[kind] = { at: "status" };
    }
  });
  return [
    ...title("Claude Code and Cursor", "How Nook hears from your sessions. Nothing is written without showing you first."),
    group("Hooks", integration("hooks")),
    group("Usage limits", integration("usage")),
    group("Reply format", integration("reply")),
    cursorGroup(),
  ];
}

/** Cursor beside Claude Code: its hooks (status only), and whether its sessions are shown. */
function cursorGroup(): HTMLElement {
  const show = toggle(settings.showCursorSessions, "Show Cursor sessions", (on) => change({ showCursorSessions: on }));
  followers.push(() => show.set(settings.showCursorSessions));
  return group("Cursor",
    integration("cursor"),
    row("Show Cursor sessions", "Cursor's agent sessions appear in the island with a Cursor mark, next to Claude Code's. Off, they are not followed at all.", show.el));
}

/** settings.json may have changed while the window was away: its state is read again, never written. */
async function refreshClaude() {
  if (section !== "claude" || CHANGES.some((kind) => flows[kind].at === "confirm")) return;
  const before = JSON.stringify([hooks, usage, reply, cursor]);
  await readClaude();
  if (JSON.stringify([hooks, usage, reply, cursor]) !== before && section === "claude") paintClaude();
}

// ── General: the shortcuts ────────────────────────────────────────────────────

/** A key of a shortcut as it is shown: "KeyK" is K, "Digit1" is 1, "Super" is the Windows key. */
const KEY_WORDS: Record<string, string> = {
  Super: "Win", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Escape: "Esc", Delete: "Del",
};
const keyWord = (key: string) => KEY_WORDS[key] ?? key.replace(/^(Key|Digit)(?=.$)/, "");
/** "Ctrl+Alt+Space" as its keys: Ctrl, Alt, Space. */
const shortcutKeys = (accelerator: string) => accelerator.split("+").map((part) => keyWord(part.trim()));

/** The keys that only modify another: pressed alone, the combination is not whole yet. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "OS"]);

/** The modifiers held during a key event, in the order a shortcut is written in. */
function heldModifiers(e: KeyboardEvent): string[] {
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter((m): m is string => !!m);
}

/** The three global shortcuts: what each is called, and what it does. */
const SHORTCUTS: readonly { which: ShortcutName; label: string; does: string }[] = [
  { which: "expand", label: "Expand / shrink the panel", does: "Opens the session panel large, or shrinks it back." },
  { which: "goto", label: "Go to the session that needs you", does: "Brings forward the window of the session that is asking, or stopped on an error, and folds the island." },
  { which: "panel", label: "Open the session panel", does: "Opens the session panel at its normal size. Space expands it." },
];

/** A shortcut as the settings have it. */
const savedShortcut = (which: ShortcutName): ShortcutStatus =>
  which === "expand"
    ? { accelerator: settings.expandShortcut, enabled: settings.expandShortcutEnabled, registered: false, error: null }
    : which === "goto"
      ? { accelerator: settings.gotoShortcut, enabled: settings.gotoShortcutEnabled, registered: false, error: null }
      : { accelerator: settings.panelShortcut, enabled: settings.panelShortcutEnabled, registered: false, error: null };

/**
 * A global shortcut: a field that records the combination pressed in it, a
 * switch, and under them where it stands. Rust has the last word: it registers
 * the combination before it saves it, and one it refuses — not a combination,
 * reserved, another Nook shortcut's, or held by another program — leaves the one
 * that worked in place.
 */
function shortcutRow({ which, label, does }: (typeof SHORTCUTS)[number]): HTMLElement {
  let status = shortcutsNow?.[which] ?? savedShortcut(which);
  /** Whether Rust has said where it stands: until then, nothing is claimed of it. */
  let known = shortcutsNow != null;
  /** What the last change was refused for, and the keys it was for, until the next one. */
  let refused: { why: string; keys: string[] } | null = null;
  let recording = false;
  /** Modifiers held so far while recording. */
  let partial: string[] = [];
  let doneAt = 0;

  const statusId = `shortcut-status-${which}`;
  const field = h("button", { class: "sp-keys", type: "button", "aria-describedby": statusId });
  const line = h("div", { class: "sp-shortcut-status", id: statusId, role: "status" });
  const el = h("div", { class: "sp-row stack sp-shortcut" });
  let power: Toggle;

  const paint = () => {
    const problem = refused?.why ?? (status.enabled ? status.error : null);
    const state = recording ? "recording" : problem ? "error" : !status.enabled ? "off" : known && status.registered ? "ok" : "unknown";
    el.dataset.state = state;
    clear(field);
    const shown = recording ? partial.map(keyWord) : refused ? refused.keys : shortcutKeys(status.accelerator);
    for (const key of shown) field.append(h("kbd", { text: key }));
    if (recording) field.append(h("span", { class: "wait", text: partial.length ? "+ a key…" : "Press the new shortcut…" }));
    else field.append(h("span", { class: "hint", text: "Click to change" }));
    field.setAttribute("aria-label", recording ? `${label}: recording` : `${label}: ${shortcutKeys(status.accelerator).join(" + ")}. Change`);
    power.set(status.enabled);
    const using = shortcutKeys(status.accelerator).join(" + ");
    clear(line);
    line.append(h("i"), h("span", { text:
      state === "recording" ? "Recording. Esc cancels."
      : refused ? (status.enabled && status.registered ? `${refused.why}. Still using ${using}.` : `${refused.why}.`)
      : state === "error" ? `${problem}.`
      : state === "off" ? "Off. No shortcut is registered."
      : state === "ok" ? "Works from any app"
      : known ? "Not registered" : "" }));
  };

  async function set(accelerator: string, enabled: boolean, keys: string[]) {
    try {
      status = await nook.setShortcut(which, accelerator, enabled);
      known = true;
      refused = null;
      if (shortcutsNow) shortcutsNow[which] = status;
      // Rust saved it, and says so to both windows; this is the same, a moment sooner.
      settings = which === "expand"
        ? { ...settings, expandShortcut: status.accelerator, expandShortcutEnabled: status.enabled }
        : which === "goto"
          ? { ...settings, gotoShortcut: status.accelerator, gotoShortcutEnabled: status.enabled }
          : { ...settings, panelShortcut: status.accelerator, panelShortcutEnabled: status.enabled };
    } catch (err) {
      refused = { why: reason(err).replace(/\.$/, ""), keys };
    }
    paint();
    say(line.textContent ?? "");
  }

  const stop = () => {
    recording = false;
    partial = [];
    doneAt = performance.now();
    paint();
  };

  field.addEventListener("click", () => {
    // A shortcut ending in Space or Enter must not start the next recording.
    if (recording || performance.now() - doneAt < 250) return;
    recording = true;
    partial = [];
    paint();
  });
  field.addEventListener("blur", () => {
    if (recording) stop();
  });
  field.addEventListener("keydown", (e) => {
    if (!recording) return;
    // Tab still leaves the field; everything else is the combination being pressed.
    if (e.key === "Tab" && heldModifiers(e).every((m) => m === "Shift")) return stop();
    e.preventDefault();
    e.stopPropagation();
    const held = heldModifiers(e);
    if (e.key === "Escape" && held.length === 0) return stop();
    partial = held;
    if (MODIFIER_KEYS.has(e.key)) return paint();
    if (e.repeat || !e.code) return;
    const key = e.code.replace(/^(Key|Digit)(?=.$)/, "");
    stop();
    void set([...held, key].join("+"), status.enabled, [...held, key].map(keyWord));
  });
  field.addEventListener("keyup", (e) => {
    if (!recording) return;
    partial = heldModifiers(e);
    paint();
  });

  power = toggle(status.enabled, `${label}: on`, (on) => void set(status.accelerator, on, shortcutKeys(status.accelerator)));
  el.append(
    h("div", { class: "sp-shortcut-top" },
      h("div", { class: "sp-row-text" }, h("div", { class: "sp-row-label", text: label }), h("p", { class: "sp-help", text: does })),
      power.el),
    field, line);
  paint();

  // What Rust has: a saved shortcut that could not be registered at launch says so here.
  void nook.shortcutStatus().then((fresh) => {
    if (!fresh) return;
    shortcutsNow = fresh;
    if (recording || refused) return;
    status = fresh[which];
    known = true;
    paint();
  });
  return el;
}

// ── General ───────────────────────────────────────────────────────────────────

/** The sound's volume as the island has it — 0 to 0.2 — and as the slider shows it: 0 to 100 %. */
const VOLUME_MAX = 0.2;
const volumePercent = () => Math.round((Math.max(0, Math.min(VOLUME_MAX, settings.soundVolume)) / VOLUME_MAX) * 100);

const AUTO_CLOSE = ["3", "5", "10", "15", "30", "custom"] as const;
type AutoClose = (typeof AUTO_CLOSE)[number];
const autoClosePreset = (): AutoClose => {
  const preset = String(Math.round(settings.autoCloseInterval));
  return settings.autoCloseInterval === Math.round(settings.autoCloseInterval) && (AUTO_CLOSE as readonly string[]).includes(preset) ? (preset as AutoClose) : "custom";
};
/** "Custom" stays picked while its number happens to be one of the presets. */
let autoCloseCustom = false;

function generalSection(): Kid[] {
  const volume = slider("Volume", volumePercent(), (v) => `${v}%`, (v) => change({ soundVolume: Number(((v / 100) * VOLUME_MAX).toFixed(4)) }, true));
  volume.setDisabled(!settings.soundEnabled);
  const sound = toggle(settings.soundEnabled, "Sound", (on) => {
    change({ soundEnabled: on });
    volume.setDisabled(!on);
  });

  const clamp = (v: number) => Math.max(2, Math.min(120, Math.round(v) || 15));
  const custom = h("input", { type: "number", min: "2", max: "120", step: "1", value: String(clamp(settings.autoCloseInterval)), "aria-label": "Auto-close, in seconds" });
  custom.addEventListener("change", () => {
    const seconds = clamp(Number(custom.value));
    custom.value = String(seconds);
    change({ autoCloseInterval: seconds });
  });
  const picked = (): AutoClose => (autoCloseCustom ? "custom" : autoClosePreset());
  autoCloseCustom = autoClosePreset() === "custom";
  const customFold = h("div", { class: `sp-fold${picked() === "custom" ? " open" : ""}` },
    h("div", {}, h("label", { class: "sp-number" }, custom, h("span", { text: "seconds, from 2 to 120" }))));
  const autoClose = segmented<AutoClose>("Auto-close", AUTO_CLOSE.map((v) => [v, v === "custom" ? "Custom" : `${v} s`] as const), picked(), (v) => {
    autoCloseCustom = v === "custom";
    customFold.classList.toggle("open", autoCloseCustom);
    // Custom starts from the time in use: nothing changes until another number is typed.
    if (autoCloseCustom) custom.value = String(clamp(settings.autoCloseInterval));
    else change({ autoCloseInterval: Number(v) });
  });

  const screen = segmented<Settings["screen"]>("Display", [["primary", "Main display"], ["cursor", "Display under the cursor"]], settings.screen, (v) => change({ screen: v }));
  const autostart = toggle(settings.autostart, "Launch at startup", (on) => change({ autostart: on }));

  // The island's own quick settings change the sound and the auto-close too.
  let seconds = settings.autoCloseInterval;
  followers.push(() => {
    sound.set(settings.soundEnabled);
    volume.setDisabled(!settings.soundEnabled);
    volume.set(volumePercent());
    if (settings.autoCloseInterval !== seconds) {
      seconds = settings.autoCloseInterval;
      autoCloseCustom = autoClosePreset() === "custom";
      if (document.activeElement !== custom) custom.value = String(clamp(seconds));
    }
    autoClose.set(picked());
    customFold.classList.toggle("open", picked() === "custom");
    screen.set(settings.screen);
    autostart.set(settings.autostart);
  });

  return [
    ...title("General"),
    group("Sound",
      row("Sound", "A short sound when a session needs you or finishes.", sound.el),
      row("Volume", null, volume.el)),
    group("Island",
      h("div", { class: "sp-row stack" },
        h("div", { class: "sp-row-text" },
          h("div", { class: "sp-row-label", text: "Auto-close" }),
          h("p", { class: "sp-help", text: "How long the island stays open after the pointer leaves it." })),
        autoClose.el, customFold),
      h("div", { class: "sp-row stack" },
        h("div", { class: "sp-row-text" }, h("div", { class: "sp-row-label", text: "Show the island on" })),
        screen.el),
      row("Launch at startup", "Start Nook when you sign in.", autostart.el)),
    group("Shortcuts", ...SHORTCUTS.map(shortcutRow)),
  ];
}

// ── Island ────────────────────────────────────────────────────────────────────

/** A row of the picker: one of the island's cells. */
type MetricRow = CompactMetric;
const METRIC_ROWS: readonly MetricRow[] = COMPACT_METRICS;
const metricName = (id: MetricRow) => COMPACT_CELLS[id].name;
const isMetric = (id: string): id is CompactMetric => (COMPACT_METRICS as readonly string[]).includes(id);

const folded = islandPreview(islandBot);

/** The metrics to choose from: made once, repainted in place. */
const metricPicker = (() => {
  const list = h("ul", { class: "sp-metrics" });
  const count = h("span", { class: "count" });
  const refusal = h("div", { class: "sp-refusal", role: "status", hidden: true }, icon(LUCIDE.triangleAlert, 15), h("span"));
  const rows = new Map<MetricRow, { el: HTMLElement; check: HTMLButtonElement; grip: HTMLButtonElement }>();

  const chosen = () => compactMetrics(settings);
  const order = (): MetricRow[] => [...chosen(), ...METRIC_ROWS.filter((id) => !(chosen() as MetricRow[]).includes(id))];

  const paint = (animate = true) => {
    const on = chosen() as MetricRow[];
    flip(list, () => {
      for (const id of order()) {
        const r = rows.get(id)!;
        const picked = on.includes(id);
        r.el.classList.toggle("on", picked);
        if (picked) delete r.el.dataset.fixed;
        else r.el.dataset.fixed = "";
        r.check.setAttribute("aria-checked", String(picked));
        r.grip.tabIndex = picked ? 0 : -1;
        list.append(r.el);
      }
    }, !animate || still());
    count.textContent = `${on.length} of ${MAX_COMPACT_METRICS} chosen`;
    folded.update(chosen(), animate && !still());
  };

  const refuse = (id: MetricRow | null) => {
    for (const r of rows.values()) r.el.classList.remove("refused");
    refusal.hidden = id == null;
    if (id == null) return;
    const text = `Three at most. Remove one to show ${metricName(id)}.`;
    refusal.querySelector("span")!.textContent = text;
    say(text);
    const el = rows.get(id)!.el;
    void el.offsetWidth;
    el.classList.add("refused");
  };

  for (const id of METRIC_ROWS) {
    const name = metricName(id);
    const check = h("button", { class: "sp-check", type: "button", role: "checkbox" },
      h("i", { class: "box" }, icon(LUCIDE.check, 12, 3.2)),
      h("i", { class: "glyph" }, cellIcon(id, 16)),
      h("span", { class: "name", text: name }),
      h("span", { class: "sample", text: COMPACT_CELLS[id].sample }));
    // A machine that reports no GPU use shows "—" in its cell: it can still be picked.
    if (id === "gpu") check.title = "Shows — on a machine that does not report its GPU use.";
    check.addEventListener("click", () => {
      const on = chosen();
      if (on.includes(id)) {
        change({ compactMetrics: on.filter((x) => x !== id) });
        refuse(null);
      } else if (on.length >= MAX_COMPACT_METRICS) {
        // Refused, and said so: nothing is dropped to make room. Rust holds
        // the same line on save, whatever a page sends.
        return refuse(id);
      } else {
        change({ compactMetrics: [...on, id] });
        refuse(null);
      }
      paint();
    });
    const grip = h("button", { class: "sp-grip", type: "button", "aria-label": `Move ${name}. Use the up and down arrows.`, title: "Drag to reorder" },
      icon(LUCIDE.gripVertical, 16));
    grip.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      const on = chosen();
      const at = on.indexOf(id);
      const to = at + step;
      if (!step || at < 0) return;
      e.preventDefault();
      if (to < 0 || to >= on.length) return;
      on.splice(at, 1);
      on.splice(to, 0, id);
      change({ compactMetrics: on });
      paint();
      grip.focus();
      say(`${name}, position ${to + 1} of ${on.length}`);
    });
    const el = h("li", { class: "sp-metric", "data-id": id }, grip, check);
    rows.set(id, { el, check, grip });
  }

  reorderable(list, {
    item: ".sp-metric",
    handle: ".sp-grip",
    still,
    onDrop: (ids) => {
      const on = chosen();
      const next = ids.filter(isMetric).filter((id) => on.includes(id));
      if (next.join() !== on.join()) change({ compactMetrics: next });
      paint();
    },
  });

  paint(false);
  return { list, count, refusal, refuse, paint };
})();

/** The bot's colours: the six the engine has. */
function botColours(): HTMLElement {
  const names = Object.keys(BOT_THEMES).filter(isBotTheme);
  const swatches = h("div", { class: "sp-swatches", role: "radiogroup", "aria-label": "Gullu's colour" });
  const worn = () => (isBotTheme(settings.botTheme) ? settings.botTheme : names[0]);
  const buttons = names.map((name) => {
    const b = h("button", { class: "sp-swatch", type: "button", role: "radio", "aria-label": BOT_THEMES[name].label, title: BOT_THEMES[name].label },
      h("i", { style: `--c:${BOT_THEMES[name].b}` }));
    b.addEventListener("click", () => pick(name));
    return b;
  });
  const label = h("span", { class: "count" });
  const paint = () => {
    buttons.forEach((b, i) => {
      const on = names[i] === worn();
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    label.textContent = BOT_THEMES[worn()].label;
  };
  const pick = (name: (typeof names)[number]) => {
    if (name !== worn()) change({ botTheme: name });
    paint();
  };
  swatches.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const to = (names.indexOf(worn()) + step + names.length) % names.length;
    pick(names[to]);
    buttons[to].focus();
  });
  swatches.append(...buttons);
  paint();
  followers.push(paint);
  return h("section", { class: "sp-group" },
    h("h2", { class: "sp-group-label" }, "Gullu's colour", label),
    swatches);
}

/** "Auto-hide the folded island after": the choices as the control names them, by their seconds ("0" is never). */
type HideAfter = `${(typeof FOLDED_AUTO_HIDE)[number]}`;
const HIDE_AFTER_WORDS: Record<HideAfter, string> = { 5: "5 s", 10: "10 s", 30: "30 s", 60: "1 min", 0: "Never" };
/**
 * What keeping the island on show costs, said as what it is: one measurement,
 * on one machine (the app at rest with the folded island up, across Nook and
 * its WebView2 processes, 3 October 2026) — not a promise for another.
 */
const ALWAYS_SHOWN_NOTE =
  "While the island is on show, Nook keeps sampling the metrics every 2.5 s; hidden, it samples nothing. On the PC it was measured on, Nook at rest with the folded island up took about 7.7 % of one core (0.5 % of that 16-core machine) and about 290 MB, WebView2 included. Yours will differ.";

/** Settings → Island → Visibility: when the folded island hides, and when it stays out of the way. */
function visibility(): HTMLElement {
  const hideAfterOf = (): HideAfter => String(foldedAutoHide(settings)) as HideAfter;
  const never = h("p", { class: "sp-note", text: ALWAYS_SHOWN_NOTE });
  const neverFold = h("div", { class: `sp-fold${hideAfterOf() === "0" ? " open" : ""}` }, h("div", {}, never));
  const hideAfter = segmented<HideAfter>("Auto-hide the folded island after", FOLDED_AUTO_HIDE.map((v) => [String(v) as HideAfter, HIDE_AFTER_WORDS[String(v) as HideAfter]] as const), hideAfterOf(), (v) => {
    neverFold.classList.toggle("open", v === "0");
    change({ foldedAutoHide: Number(v) });
  });
  const whenIdle = toggle(settings.hideOnlyWhenIdle, "Hide only when no session is active", (on) => change({ hideOnlyWhenIdle: on }));
  const fullscreen = toggle(settings.hideInFullscreen, "Hide in full-screen apps", (on) => change({ hideInFullscreen: on }));
  followers.push(() => {
    hideAfter.set(hideAfterOf());
    neverFold.classList.toggle("open", hideAfterOf() === "0");
    whenIdle.set(settings.hideOnlyWhenIdle);
    fullscreen.set(settings.hideInFullscreen);
  });
  return group("Visibility",
    h("div", { class: "sp-row stack" },
      h("div", { class: "sp-row-text" },
        h("div", { class: "sp-row-label", text: "Auto-hide the folded island after" }),
        h("p", { class: "sp-help", text: "How long the folded island stays once the pointer has left it. It comes back when you point at the top edge, or when a session does something." })),
      hideAfter.el, neverFold),
    row("Hide only when no session is active", "While a session is working, thinking or asking, the folded island stays. The time above starts once none is; a session that has finished does not count.", whenIdle.el),
    row("Hide in full-screen apps", "With a video, a game or a presentation in full screen on the island's display, the island stays hidden and does not come up for hover or for work. A permission request or a question still shows, so you can answer it.", fullscreen.el));
}

function islandSection(): Kid[] {
  metricPicker.refuse(null);
  metricPicker.paint(false);
  followers.push(() => metricPicker.paint(false));
  leavers.push(folded.run());
  return [
    ...title("Island", "What the folded island shows beside Gullu and the session dots."),
    folded.el,
    h("section", { class: "sp-group", style: "margin-top:14px" },
      h("h2", { class: "sp-group-label" }, "Metrics", metricPicker.count),
      metricPicker.list,
      metricPicker.refusal,
      h("p", { class: "sp-note", text: "Up to three, in the order shown: drag a chosen one to move it. With none, the island is narrower. The preview shows sample sessions and sample values." })),
    visibility(),
    botColours(),
  ];
}

// ── Shelf ─────────────────────────────────────────────────────────────────────

/** The Shelf's six widgets: what each is called, its colour, its mark, and what it will be. The ids are Rust's (settings.rs `SHELF_WIDGETS`). */
const WIDGETS = {
  media: { name: "Media", accent: "#34D399", about: "What is playing, with play and skip.",
    icon: LUCIDE.music },
  todo: { name: "To-do", accent: "#FACC15", about: "Your latest items, and a field to add one.",
    icon: LUCIDE.listTodo },
  timer: { name: "Timer", accent: "#F5A524", about: "A countdown you can start and pause.",
    icon: LUCIDE.timer },
  reminders: { name: "Reminders", accent: "#F472B6", about: "The next reminder, and a quick add.",
    icon: LUCIDE.bell },
  mirror: { name: "Mirror", accent: "#22D3EE", about: "A button that opens the camera view.",
    icon: LUCIDE.camera },
  projects: { name: "Projects", accent: "#3B9EFF", about: "Recent folders, to open in your editor.",
    icon: LUCIDE.folder },
} as const;
type WidgetId = keyof typeof WIDGETS;
const WIDGET_IDS = Object.keys(WIDGETS) as WidgetId[];
const isWidget = (id: string): id is WidgetId => id in WIDGETS;

/** The order as the settings have it, held to the six: each once, what is missing at the end. As Rust keeps it. */
function shelfOrder(): WidgetId[] {
  const said = Array.isArray(settings.shelfOrder) ? settings.shelfOrder.filter(isWidget) : [];
  return [...new Set([...said, ...WIDGET_IDS])];
}
const shelfHidden = (): Set<WidgetId> => new Set(Array.isArray(settings.shelfHidden) ? settings.shelfHidden.filter(isWidget) : []);

/** The shelf's cards in their order: made once, repainted in place. */
const shelfPicker = (() => {
  // The island's black, and the dark tokens with it, whatever the window's theme.
  const tray = h("div", { class: "sp-tray sp-dark", role: "list", "aria-label": "Shelf widgets, in their order" });
  const count = h("span", { class: "count" });
  const cards = new Map<WidgetId, { el: HTMLElement; shown: Toggle }>();

  /** Shown ones in their order, then the hidden ones. */
  const order = () => {
    const hidden = shelfHidden();
    return [...shelfOrder().filter((id) => !hidden.has(id)), ...shelfOrder().filter((id) => hidden.has(id))];
  };

  const paint = (animate = true) => {
    const ids = order();
    const hidden = shelfHidden();
    const shown = ids.length - hidden.size;
    flip(tray, () => {
      ids.forEach((id, i) => {
        const card = cards.get(id)!;
        const off = hidden.has(id);
        card.el.classList.toggle("hidden", off);
        if (off) card.el.dataset.fixed = "";
        else delete card.el.dataset.fixed;
        card.shown.set(!off);
        card.el.setAttribute("aria-label", off
          ? `${WIDGETS[id].name}, hidden`
          : `${WIDGETS[id].name}, position ${i + 1} of ${shown}. Arrow keys move it.`);
        tray.append(card.el);
      });
    }, !animate || still());
    count.textContent = `${shown} of ${ids.length} shown`;
  };

  for (const id of WIDGET_IDS) {
    const def = WIDGETS[id];
    const shown = toggle(true, `Show ${def.name}`, (on) => {
      const hidden = shelfHidden();
      if (on) hidden.delete(id);
      else hidden.add(id);
      change({ shelfHidden: WIDGET_IDS.filter((x) => hidden.has(x)) });
      paint();
      say(`${def.name} ${on ? "shown" : "hidden"}`);
    });
    const el = h("div", { class: "sp-card", role: "listitem", tabindex: "0", "data-id": id, style: `--c:${def.accent}` },
      h("div", { class: "sp-card-head" },
        h("span", { class: "sp-mark" }, icon(def.icon, 13, 2.2)),
        h("b", { text: def.name }),
        shown.el),
      h("p", { text: def.about }));
    el.addEventListener("keydown", (e) => {
      const hidden = shelfHidden();
      if (e.target !== el || hidden.has(id)) return;
      const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      const on = order().filter((x) => !hidden.has(x));
      const at = on.indexOf(id);
      const to = at + step;
      if (to < 0 || to >= on.length) return;
      on.splice(at, 1);
      on.splice(to, 0, id);
      change({ shelfOrder: [...on, ...order().filter((x) => hidden.has(x))] });
      paint();
      el.focus();
      say(`${def.name}, position ${to + 1} of ${on.length}`);
    });
    cards.set(id, { el, shown });
  }

  reorderable(tray, {
    item: ".sp-card",
    ignore: ".sp-toggle",
    still,
    onDrop: (ids) => {
      const next = [...new Set([...ids.filter(isWidget), ...WIDGET_IDS])];
      if (next.join() !== order().join()) change({ shelfOrder: next });
      paint();
    },
  });

  paint(false);
  return { tray, count, paint };
})();

function shelfSection(): Kid[] {
  shelfPicker.paint(false);
  followers.push(() => shelfPicker.paint(false));
  return [
    ...title("Shelf", "The widgets of the island's Shelf, in the order they will stand there."),
    h("div", { class: "sp-flash note", style: "margin:14px 0 0", role: "note" }, icon(LUCIDE.info, 15),
      h("span", { text: "The Shelf tab shows these in this order, and you can drag its cards there too. A widget that is switched off never runs: no timer, no reminder, no camera, nothing is read." })),
    h("section", { class: "sp-group", style: "margin-top:18px" },
      h("h2", { class: "sp-group-label" }, "Widgets", shelfPicker.count),
      shelfPicker.tray,
      h("p", { class: "sp-note", text: "Drag a card to move it, or focus it and use the arrow keys. Switch one off to leave it out." })),
  ];
}

// ── Appearance ────────────────────────────────────────────────────────────────

function appearanceSection(): Kid[] {
  const themeHelp = h("p", { class: "sp-help" });
  const writeHelp = () => {
    // Asked of the system only while following it: a picked theme answers for itself.
    themeHelp.textContent = settings.theme === "system"
      ? `System follows your system, which is set to ${systemDark.matches ? "dark" : "light"} now. The island itself always stays dark.`
      : "System follows your system's light or dark setting. The island itself always stays dark.";
  };
  const theme: Segmented<Theme> = segmented<Theme>("Theme", [["light", "Light"], ["dark", "Dark"], ["system", "System"]], settings.theme, (v) => {
    change({ theme: v });
    writeHelp();
  });
  const motion: Segmented<Motion> = segmented<Motion>("Reduce motion", [["system", "Follow system"], ["on", "On"], ["off", "Off"]], settings.reduceMotion, (v) => change({ reduceMotion: v }));
  const playful = toggle(settings.playfulReactions !== false, "Playful reactions", (on) => change({ playfulReactions: on }));
  writeHelp();
  followers.push(() => {
    theme.set(settings.theme);
    motion.set(settings.reduceMotion);
    playful.set(settings.playfulReactions !== false);
    writeHelp();
  });
  return [
    ...title("Appearance"),
    group("Theme",
      h("div", { class: "sp-row stack" },
        h("div", { class: "sp-row-text" }, h("div", { class: "sp-row-label", text: "Settings window" }), themeHelp),
        theme.el)),
    group("Motion",
      h("div", { class: "sp-row stack" },
        h("div", { class: "sp-row-text" },
          h("div", { class: "sp-row-label", text: "Reduce motion" }),
          h("p", { class: "sp-help", text: "Changes happen at once, without springs or fades." })),
        motion.el)),
    group("Gullu",
      row("Playful reactions", "Gullu reacts to your mouse and clicks. Off: just the status faces.", playful.el)),
  ];
}

// ── About ─────────────────────────────────────────────────────────────────────

/**
 * The owner's links. What is written here is only what the row says: the
 * address each one opens is a constant in Rust (about.rs), picked by its id.
 */
const LINKS: readonly { which: AboutLink; name: string; where: string; mark: () => SVGSVGElement }[] = [
  { which: "portfolio", name: "Portfolio", where: "zubyr.dev", mark: () => icon(LUCIDE.globe, 16) },
  { which: "github", name: "GitHub", where: "github.com/zubairbinshaukat", mark: () => brand(BRANDS.github, 16) },
  // Simple Icons carries no LinkedIn mark: a neutral glyph of the set stands for it.
  { which: "linkedin", name: "LinkedIn", where: "linkedin.com/in/zubairbinshaukat", mark: () => icon(LUCIDE.briefcaseBusiness, 16) },
  { which: "x", name: "X", where: "x.com/zubyrdev", mark: () => brand(BRANDS.x, 14) },
];

function aboutSection(): Kid[] {
  const place = (label: string, help: string, path: string | undefined) =>
    h("div", { class: "sp-row" },
      h("div", { class: "sp-row-text" }, h("div", { class: "sp-row-label", text: label }), h("p", { class: "sp-help", text: help })),
      h("span", { class: "sp-path" }, ...(path ? breakable(path) : ["—"])));
  const link = ({ which, name, where, mark }: (typeof LINKS)[number]) =>
    h("button", {
      class: "sp-social", type: "button", title: where,
      "aria-label": `${name}: ${where}. Opens in your browser.`, onclick: () => void nook.openLink(which),
    }, h("i", {}, mark()), h("span", { text: name }));
  return [
    h("div", { class: "sp-about" },
      h("div", { class: "sp-nook", "aria-hidden": "true" }, aboutBot.el),
      h("div", {},
        h("h1", { class: "sp-about-name", text: "Nook" }),
        h("p", { class: "sp-about-version", text: version ? `Version ${version}` : "" }),
        h("p", { class: "sp-about-version", text: "Gullu, Nook's buddy" }))),
    group("Privacy",
      h("p", { class: "sp-lede", style: "margin-top:8px;color:var(--text)", text: "No telemetry and no network requests: everything stays on this machine." })),
    group("Where your data lives",
      place("Settings", "Your preferences", paths?.settings),
      place("Logs and relay", "The log file and the relay Claude Code runs", paths?.local),
      ...(paths?.relayError ? [h("p", { class: "sp-help", style: "color:var(--danger, #f87171)", text: `Not receiving Claude Code events: ${paths.relayError}` })] : []),
      h("div", { class: "sp-row stack" },
        h("button", { class: "sp-link", type: "button", onclick: () => void nook.openLogFolder() },
          icon(LUCIDE.folderOpen, 16), h("span", { class: "sp-link-text", text: "Open log folder" }), icon(LUCIDE.arrowUpRight, 14)))),
    h("section", { class: "sp-group" },
      h("h2", { class: "sp-group-label", text: "Made by" }),
      h("div", { class: "sp-credit" },
        h("p", { class: "sp-made", text: "Zubair Bin Shaukat" }),
        h("div", { class: "sp-links", role: "group", "aria-label": "Zubair Bin Shaukat's links" }, ...LINKS.map(link)))),
    h("p", { class: "sp-credits", text: "Open source, under the MIT licence." }),
  ];
}

// ── Putting a section on show ─────────────────────────────────────────────────

const BUILD: Record<Section, () => Kid[]> = {
  claude: claudeSection, general: generalSection, island: islandSection,
  shelf: shelfSection, appearance: appearanceSection, about: aboutSection,
};

let pane: HTMLElement | null = null;

function show(animate: boolean) {
  for (const leave of leavers) leave();
  leavers = [];
  followers = [];
  const next = h("div", { class: "sp-pane", id: "sp-pane", role: "tabpanel", "aria-labelledby": `tab-${section}` }, ...BUILD[section]());
  const old = pane;
  pane = next;
  if (old && animate && !still()) {
    // The one leaving fades under the one arriving, then goes.
    old.removeAttribute("id");
    old.classList.remove("entering");
    old.classList.add("leaving");
    old.inert = true;
    window.setTimeout(() => old.remove(), 140);
    next.classList.add("entering");
  } else {
    old?.remove();
  }
  main.append(next);
  for (const [id, tab] of tabs) {
    const on = id === section;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  navMark.style.setProperty("--at", String(SECTIONS.indexOf(section)));
  refreshBots();
}

function setSection(next: Section) {
  if (next === section && pane) return;
  section = next;
  show(true);
  if (next === "claude") void refreshClaude();
}

// ── Go ────────────────────────────────────────────────────────────────────────

async function start() {
  nook = await connect();
  const [boot, , statuses, where] = await Promise.all([nook.boot(), readClaude(), nook.shortcutStatus(), nook.dataPaths()]);
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  shortcutsNow = statuses;
  paths = where;
  if (nook.start && (SECTIONS as readonly string[]).includes(nook.start)) section = nook.start as Section;
  applyAppearance();
  versionLine.textContent = version ? `Version ${version}` : "";

  clear(root);
  root.append(
    h("div", { class: "sp-app" },
      h("nav", { class: "sp-side", "aria-label": "Settings" },
        h("div", { class: "sp-brand" },
          h("div", { class: "sp-nook", "aria-hidden": "true" }, sideBot.el),
          h("div", { class: "sp-brand-text" }, h("b", { text: "Nook" }), versionLine)),
        nav,
        nook.fake ? h("div", { class: "sp-fake", text: "Fake data", title: "Nothing here is read from or written to this machine." }) : null),
      main),
    live,
  );
  show(false);
  startBots(still);

  nook.onSettingsChanged(settingsChanged);
  systemDark.addEventListener("change", () => {
    applyAppearance();
    for (const follow of followers) follow();
  });
  systemStill.addEventListener("change", applyAppearance);
  // The window lives hidden between two looks at it: what it shows of
  // settings.json is read again when it comes back.
  window.addEventListener("focus", () => void refreshClaude());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshClaude();
  });
}

void start();
