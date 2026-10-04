// Dev harness: the redesigned settings window (plans/design-plan.md §4 and §7,
// plans/tabs-plan.md §2), on fake data, in a plain browser. Nothing here is
// read from or written to the machine: the hooks' states, the diff, the
// "write" and the shortcuts are all made up, and the preferences live only as
// long as the page. Not part of the app bundle.
// `npx vite`, then /dev/settings-preview.html (?section=island&theme=light…).
//
// A sidebar of sections — Claude Code, General, Island, Shelf, Appearance,
// About — and one section on show at a time. Every setting applies at once;
// only what writes to Claude Code's settings.json asks first.

import "./preview-b/controls.css";
import "./preview-b/settings-preview.css";
import { NOTCH_H, ROUNDED_CORNER, botPosition } from "../src/core/layout";
import { BOT_THEMES, type BotTheme } from "../src/bot/engine";
import { clear, h } from "../src/views/dom";
import { ICONS } from "../src/views/icons";
import { mountBot, startBots } from "./preview/bots";
import { EAR_COMPACT, Notch } from "./preview/notch";
import { DEFAULT_ORDER, WIDGETS, type WidgetId } from "./preview-c/model";
import { controls, picker } from "./preview-b/controls";
import {
  SPRING, UI_ICONS, flip, icon, reorderable, segmented, slider, toggle,
  type Segmented,
} from "./preview-b/settings-ui";

// ── What the preview can be put in ────────────────────────────────────────────

const SECTIONS = ["claude", "general", "island", "shelf", "appearance", "about"] as const;
type Section = (typeof SECTIONS)[number];
type HooksCase = "installed" | "none" | "legacy" | "relay" | "diff";
type UsageCase = "none" | "installed" | "chained";
type ShortcutCase = "ok" | "recording" | "taken" | "same" | "off";
type Theme = "light" | "dark" | "system";
type Motion = "system" | "on" | "off";
/** Where a part's install flow is at: its status, the diff to confirm, or just written. */
type Flow = { at: "status" } | { at: "confirm"; install: boolean } | { at: "done"; install: boolean };

const SIZES = { small: [460, 480], real: [560, 680], wide: [800, 760] } as const;
type SizeName = keyof typeof SIZES;

const VERSION = "0.1.1";

const params = new URLSearchParams(location.search);
const among = <T extends string>(value: string | null, all: readonly T[], fallback: T): T =>
  all.includes(value as T) ? (value as T) : fallback;

const pv = {
  section: among<Section>(params.get("section"), SECTIONS, "claude"),
  hooks: among<HooksCase>(params.get("hooks"), ["installed", "none", "legacy", "relay", "diff"], "installed"),
  usage: among<UsageCase>(params.get("usage"), ["none", "installed", "chained"], "none"),
  shortcuts: among<ShortcutCase>(params.get("shortcuts"), ["ok", "recording", "taken", "same", "off"], "ok"),
  theme: among<Theme>(params.get("theme"), ["light", "dark", "system"], "system"),
  motion: among<Motion>(params.get("motion"), ["system", "on", "off"], "system"),
  size: among<SizeName>(params.get("size"), ["small", "real", "wide"], "real"),
  hooksFlow: { at: "status" } as Flow,
  usageFlow: { at: "status" } as Flow,
};

/** The address says the state on show: a link to it can be passed around. */
function remember() {
  const q = new URLSearchParams();
  for (const key of ["section", "theme", "size", "hooks", "usage", "shortcuts", "motion"] as const) q.set(key, pv[key]);
  history.replaceState(null, "", `?${q}`);
}

// ── The made-up preferences ───────────────────────────────────────────────────

type MetricId = "cpu" | "ram" | "usage5" | "usage7" | "waiting" | "gpu";
const AUTO_CLOSE = ["3", "5", "10", "15", "30", "custom"] as const;

const prefs = {
  sound: true,
  volume: 35,
  autoClose: "15" as (typeof AUTO_CLOSE)[number],
  autoCloseCustom: 45,
  screen: "primary" as "primary" | "cursor",
  autostart: false,
  botTheme: "cream" as BotTheme,
  /** The metrics chosen, in the order the island shows them. */
  metrics: ["cpu", "ram", "usage5"] as MetricId[],
  shelfOrder: [...DEFAULT_ORDER],
  shelfHidden: new Set<WidgetId>(),
};

const HOME = "C:\\Users\\dev";
const SETTINGS_JSON = `${HOME}\\.claude\\settings.json`;
const RELAY = `${HOME}\\AppData\\Local\\Nook\\nook-hook.exe`;
/** Where the relay was before Nook was moved: what a reinstall replaces. */
const RELAY_BEFORE = `${HOME}\\Downloads\\Nook\\nook-hook.exe`;
const BACKUP_NAME = "settings.json.nook-backup-20261003-141205";
/** The status line the user already had, in the "chained" case. */
const OWN_STATUS_LINE = "npx ccstatusline";

// ── Theme and motion ──────────────────────────────────────────────────────────

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const systemStill = window.matchMedia("(prefers-reduced-motion: reduce)");
const resolvedTheme = (): "light" | "dark" => (pv.theme === "system" ? (systemDark.matches ? "dark" : "light") : pv.theme);
const still = (): boolean => (pv.motion === "system" ? systemStill.matches : pv.motion === "on");

// ── The bot: three of him, made once ──────────────────────────────────────────

const COMPACT_BOT = botPosition("compact", "overview", NOTCH_H).diameter;
const sideBot = mountBot(20, false);
const islandBot = mountBot(COMPACT_BOT, false);
const aboutBot = mountBot(46, false);
sideBot.setState("idle");
islandBot.setState("approval");
aboutBot.setState("idle");

function wearTheme() {
  for (const bot of [sideBot, islandBot, aboutBot]) bot.engine.theme = prefs.botTheme;
}

// ── The window ────────────────────────────────────────────────────────────────

const TABS: Record<Section, { name: string; icon: string }> = {
  claude: { name: "Claude Code", icon: ICONS.terminalWindow },
  general: { name: "General", icon: UI_ICONS.sliders },
  island: { name: "Island", icon: UI_ICONS.island },
  shelf: { name: "Shelf", icon: UI_ICONS.shelf },
  appearance: { name: "Appearance", icon: UI_ICONS.appearance },
  about: { name: "About", icon: UI_ICONS.info },
};

const navMark = h("i", { class: "sp-nav-mark" });
const nav = h("div", { class: "sp-nav", role: "tablist", "aria-orientation": "vertical", "aria-label": "Settings sections" }, navMark);
const tabs = new Map<Section, HTMLButtonElement>();
for (const id of SECTIONS) {
  const tab = h("button", {
    class: "sp-tab", type: "button", role: "tab", id: `tab-${id}`, "aria-controls": "sp-pane",
    // The name stays on the tab when the sidebar folds to its icons.
    "aria-label": TABS[id].name, title: TABS[id].name,
  }, icon(TABS[id].icon, 17), h("span", { text: TABS[id].name }));
  tab.addEventListener("click", () => setSection(id));
  tabs.set(id, tab);
  nav.append(tab);
}

nav.addEventListener("keydown", (e) => {
  const at = SECTIONS.indexOf(pv.section);
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

const body = h(
  "div",
  { class: "win-body" },
  h("div", { class: "sp-app" },
    h("nav", { class: "sp-side", "aria-label": "Settings" },
      h("div", { class: "sp-brand" },
        h("div", { class: "sp-nook", "aria-hidden": "true" }, sideBot.el),
        h("div", { class: "sp-brand-text" }, h("b", { text: "Nook" }), h("span", { text: `Version ${VERSION}` }))),
      nav),
    main),
  live,
);

const win = h(
  "div",
  { class: "win" },
  // The system's title bar, drawn only so the window reads as a window.
  h("div", { class: "win-bar", "aria-hidden": "true" },
    h("span", { text: "Nook Settings" }), h("span", { class: "spacer" }),
    h("i", {}, icon(UI_ICONS.minimise, 13, 1.3)), h("i", {}, icon(UI_ICONS.maximise, 13, 1.3)), h("i", {}, icon(UI_ICONS.close, 13, 1.3))),
  body,
);
win.style.setProperty("--spring", SPRING.easing);
win.style.setProperty("--spring-ms", `${SPRING.ms}ms`);

const sizeLine = h("div", { class: "win-size" });
document.getElementById("frame")!.append(win, sizeLine);

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
  path.split(/(?<=\\)/).flatMap((part, i) => (i ? [h("wbr"), part] : [part]));

const button = (text: string, kind: string, onClick: () => void) =>
  h("button", { class: `sp-btn ${kind}`, type: "button", text, onclick: onClick });

// ── Claude Code ───────────────────────────────────────────────────────────────

const hooksAre = () => ({
  installed: pv.hooks === "installed" || pv.hooks === "relay",
  legacy: pv.hooks === "legacy" || pv.hooks === "diff",
  relayReady: pv.hooks !== "relay",
});

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "SubagentStart", "SubagentStop", "Stop"];
const hookLines = (sign: string, exe: string) =>
  EVENTS.map((event) => `${sign}    "${event}": [{ "hooks": [{ "type": "command", "command": "${exe.replaceAll("\\", "\\\\")}", "args": ["${event}"] }] }]${event === "Stop" ? "" : ","}`);

/** What installing or removing the hooks would change in settings.json: made up, in the shape the app shows. */
function hooksDiff(install: boolean): string[] {
  const s = hooksAre();
  const head = [" {", '   "model": "opus",', '   "permissions": { "allow": ["Bash(npm run test:*)"] },'];
  const legacy = s.legacy ? hookLines("-", `${HOME}\\AppData\\Local\\Coucou\\coucou-hook.exe`) : [];
  // A reinstall is shown as what it is for: the entries pointed at where Nook used to be.
  const own = s.installed ? hookLines("-", install ? RELAY_BEFORE : RELAY) : [];
  const next = install ? hookLines("+", RELAY) : [];
  const had = s.installed || s.legacy;
  return [...head, had ? '   "hooks": {' : '+  "hooks": {', ...legacy, ...own, ...next, had ? "   }" : "+  }", " }"];
}

function usageDiff(install: boolean): string[] {
  const line = (exe: string, then: string | null) =>
    `"statusLine": { "type": "command", "command": "${exe.replaceAll("\\", "\\\\")}", "args": [${then ? `"statusline", "--then", "${then}"` : '"statusline"'}] }`;
  const then = pv.usage === "chained" ? OWN_STATUS_LINE : null;
  const theirs = `"statusLine": { "type": "command", "command": "${OWN_STATUS_LINE}" }`;
  const head = [" {", '   "model": "opus",', '   "hooks": { … },'];
  const changed =
    pv.usage === "none"
      ? [`+  ${line(RELAY, null)}`]
      : install
        ? [`-  ${line(RELAY_BEFORE, then)}`, `+  ${line(RELAY, then)}`]
        : [`-  ${line(RELAY, then)}`, ...(then ? [`+  ${theirs}`] : [])];
  return [...head, ...changed, " }"];
}

type Tone = "ok" | "off" | "warn" | "error";
const TONE_ICON: Record<Tone, string> = {
  ok: UI_ICONS.okCircle, off: UI_ICONS.offCircle, warn: UI_ICONS.warn, error: UI_ICONS.errorCircle,
};

interface Integration {
  name: string;
  tone: Tone;
  title: string;
  tag?: string;
  text: string;
  facts: [string, string][];
  /** The one filled button, if the state calls for one. */
  primary?: { label: string; act: "install" | "restart" };
  /** A quiet way to write the entries again. */
  again?: string;
  remove?: string;
  flow: Flow;
  setFlow(flow: Flow): void;
  diff(install: boolean): string[];
  confirmText(install: boolean): string;
  /** The made-up write has happened. */
  written(install: boolean): void;
}

function diffPanel(spec: Integration, install: boolean, close: () => void, confirm: () => void): HTMLElement {
  const lines = spec.diff(install);
  const added = lines.filter((l) => l.startsWith("+")).length;
  const removed = lines.filter((l) => l.startsWith("-")).length;
  const box = h("div", { class: "sp-diff", tabindex: "0", role: "region", "aria-label": "Changes to settings.json" });
  for (const line of lines) {
    const sign = line[0] === "+" || line[0] === "-" ? line[0] : " ";
    box.append(h("div", { class: sign === "+" ? "add" : sign === "-" ? "del" : "", "data-sign": sign, text: line.slice(1) }));
  }
  return h("div", { class: "sp-panel" },
    h("div", { class: "sp-panel-head" },
      h("span", { text: "Changes to settings.json" }),
      h("span", { class: "counts" },
        h("span", { class: "plus", text: `+${added}` }), h("span", { class: "minus", text: `\u2212${removed}` }))),
    h("p", { class: "sp-help", text: spec.confirmText(install) }),
    box,
    h("p", { class: "sp-help" }, "A dated backup is taken first: ", h("code", { text: BACKUP_NAME })),
    h("div", { class: "sp-panel-actions" },
      button(install ? "Back up and write" : "Back up and remove", install ? "primary" : "danger solid", confirm),
      button("Cancel", "quiet", close)));
}

/** Something Nook writes into settings.json: where it stands, its one action, and the diff that action would write. */
function integration(make: () => Integration): HTMLElement {
  const slot = h("div");
  const paint = (opening: boolean, focus?: "primary" | "panel") => {
    const spec = make();
    const flow = spec.flow;
    const go = (install: boolean) => {
      spec.setFlow({ at: "confirm", install });
      paint(true, "panel");
    };

    const head = h("div", { class: "sp-status-head" },
      h("span", { class: "sp-status-icon" }, icon(TONE_ICON[spec.tone], 22, 1.6)),
      h("div", {},
        h("div", { class: "sp-status-title" }, h("span", { text: spec.title }), spec.tag ? h("span", { class: "sp-tag", text: spec.tag }) : null),
        h("p", { class: "sp-status-text", text: spec.text })));

    const facts = h("dl", { class: "sp-facts" });
    for (const [k, v] of spec.facts) facts.append(h("dt", { text: k }), h("dd", {}, ...breakable(v)));

    const block = h("div", { class: "sp-status", "data-tone": spec.tone, role: "group", "aria-label": spec.name }, head);
    if (spec.facts.length) block.append(facts);

    if (flow.at === "done") {
      block.append(h("div", { class: "sp-flash", role: "status" }, icon(ICONS.check, 15, 2),
        h("span", { text: flow.install
          ? `Written. The previous file is saved as ${BACKUP_NAME}. Start a new Claude Code session to pick the change up.`
          : `Removed. The previous file is saved as ${BACKUP_NAME}.` })));
    }
    const restartNote = h("div", { class: "sp-flash", role: "status", hidden: true }, icon(UI_ICONS.info, 15, 1.8),
      h("span", { text: "Preview only: the app would close and start again here." }));
    block.append(restartNote);

    const confirming = flow.at === "confirm";
    const actions = h("div", { class: "sp-actions" });
    if (spec.primary) {
      const act = spec.primary.act;
      actions.append(button(spec.primary.label, "primary", () => (act === "install" ? go(true) : (restartNote.hidden = false))));
    }
    if (spec.again) actions.append(button(spec.again, "quiet", () => go(true)));
    if (spec.remove) actions.append(button(spec.remove, `danger${actions.childElementCount ? " push" : ""}`, () => go(false)));
    // While the diff is open, its two buttons are the only way on.
    if (!confirming && actions.childElementCount) block.append(actions);

    const fold = h("div", { class: "sp-fold" });
    if (confirming) {
      fold.append(h("div", {}, diffPanel(spec, flow.install,
        () => {
          spec.setFlow({ at: "status" });
          if (pv.hooks === "diff") setHooks("legacy");
          else paint(false, "primary");
        },
        () => {
          spec.setFlow({ at: "done", install: flow.install });
          spec.written(flow.install);
        })));
    }
    block.append(fold);
    clear(slot);
    slot.append(block);
    if (confirming) {
      // Shut, then open: the panel unfolds from the block's lower edge.
      if (opening && !still()) void fold.offsetHeight;
      fold.classList.add("open");
    }
    if (focus === "panel") block.querySelector<HTMLElement>(".sp-panel .sp-btn")?.focus();
    if (focus === "primary") block.querySelector<HTMLElement>(".sp-actions .sp-btn")?.focus();
  };
  paint(false);
  return slot;
}

function hooksSpec(): Integration {
  const s = hooksAre();
  const paths: [string, string][] = [["settings.json", SETTINGS_JSON], ["Relay", RELAY]];
  const shared = {
    name: "Hooks",
    flow: pv.hooksFlow,
    setFlow: (flow: Flow) => (pv.hooksFlow = flow),
    diff: hooksDiff,
    confirmText: (install: boolean) =>
      install ? "Only Nook's entries change. Your own hooks are left untouched." : "Only Nook's entries are removed. Your own hooks are left untouched.",
    written: (install: boolean) => {
      pv.hooks = install ? "installed" : "none";
      hooksPicker.set(pv.hooks);
      remember();
      repaint();
    },
  };
  if (!s.relayReady) {
    return {
      ...shared, tone: "error", title: "Relay missing",
      text: "The hooks are installed, but nook-hook.exe is not where they point, so no session can reach Nook. Restarting Nook puts it back.",
      facts: paths, primary: { label: "Restart Nook", act: "restart" }, remove: "Uninstall…",
    };
  }
  if (s.installed) {
    return {
      ...shared, tone: "ok", title: "Connected",
      text: "Hooks are installed and current. Your sessions, their questions and their permission requests show up in the island.",
      facts: paths, again: "Reinstall…", remove: "Uninstall…",
    };
  }
  if (s.legacy) {
    return {
      ...shared, tone: "warn", title: "Old hooks found",
      text: "Hooks from Coucou are still installed. Nook cannot hear your sessions until its own take their place.",
      facts: [["settings.json", SETTINGS_JSON]], primary: { label: "Replace them…", act: "install" }, remove: "Remove them…",
    };
  }
  return {
    ...shared, tone: "off", title: "Not installed",
    text: "Install the hooks to see your Claude Code sessions in the island, and to answer permission requests without leaving what you are doing.",
    facts: [], primary: { label: "Install hooks…", act: "install" },
  };
}

function usageSpec(): Integration {
  const on = pv.usage !== "none";
  const chained = pv.usage === "chained";
  return {
    name: "Usage limits",
    tone: on ? "ok" : "off",
    title: chained ? "Installed, after your status line" : on ? "Installed" : "Not installed",
    tag: "Coming later",
    text: chained
      ? "Claude Code hands its 5-hour and 7-day limits to Nook, then Nook runs the status line you already had and prints its output unchanged."
      : on
        ? "Claude Code hands its 5-hour and 7-day limits to Nook through its status line. Nook prints nothing there: your terminal looks the same."
        : "Shows your 5-hour and 7-day limits in the island, read locally from what Claude Code already passes to its status line. No network.",
    facts: on ? [["settings.json", "statusLine"], ...(chained ? [["Then runs", OWN_STATUS_LINE] as [string, string]] : [])] : [],
    primary: on ? undefined : { label: "Install status line…", act: "install" },
    again: on ? "Reinstall…" : undefined,
    remove: on ? "Uninstall…" : undefined,
    flow: pv.usageFlow,
    setFlow: (flow) => (pv.usageFlow = flow),
    diff: usageDiff,
    confirmText: (install) =>
      install ? "One key changes, statusLine, and nothing else."
      : chained ? "Your own status line is put back as it was."
      : "The statusLine key Nook added is removed.",
    written: (install) => {
      pv.usage = install ? (chained ? "chained" : "installed") : "none";
      usagePicker.set(pv.usage);
      remember();
      repaint();
    },
  };
}

function claudeSection(): Kid[] {
  return [
    ...title("Claude Code", "How Nook hears from your sessions. Nothing is written without showing you first."),
    group("Hooks", integration(hooksSpec)),
    group("Usage limits", integration(usageSpec)),
  ];
}

// ── General ───────────────────────────────────────────────────────────────────

type ShortcutName = "expand" | "goto" | "panel";
interface Shortcut {
  label: string;
  keys: string[];
  on: boolean;
  /** What went wrong with the last keys tried, shown until others are. */
  error: "taken" | "same" | null;
  tried: string[];
  recording: boolean;
}

const shortcuts: Record<ShortcutName, Shortcut> = {
  expand: { label: "Expand / shrink the panel", keys: ["Ctrl", "Alt", "Space"], on: true, error: null, tried: [], recording: false },
  goto: { label: "Go to the session that needs you", keys: ["Ctrl", "Alt", "Enter"], on: true, error: null, tried: [], recording: false },
  panel: { label: "Open the session panel", keys: ["Ctrl", "Shift", "Space"], on: true, error: null, tried: [], recording: false },
};

/** Made up: what "another app" holds, so the refusal can be tried by hand. */
const TAKEN = new Set(["Ctrl+Shift+Esc", "Ctrl+Alt+Delete", "Alt+Tab", "Ctrl+Alt+T", "Win+L"]);

function applyShortcutCase(which: ShortcutCase) {
  for (const s of Object.values(shortcuts)) Object.assign(s, { on: true, error: null, tried: [], recording: false });
  if (which === "recording") shortcuts.expand.recording = true;
  if (which === "taken") Object.assign(shortcuts.expand, { error: "taken", tried: ["Ctrl", "Alt", "T"] });
  if (which === "same") Object.assign(shortcuts.goto, { error: "same", tried: [...shortcuts.expand.keys] });
  if (which === "off") shortcuts.goto.on = false;
}

const MODIFIERS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph"]);

function keyName(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  const named: Record<string, string> = {
    " ": "Space", Escape: "Esc", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Delete: "Delete",
  };
  return named[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
}

const heldModifiers = (e: KeyboardEvent) =>
  [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean) as string[];

function shortcutRow(name: ShortcutName): HTMLElement {
  const s = shortcuts[name];
  const statusId = `shortcut-status-${name}`;
  const field = h("button", { class: "sp-keys", type: "button", "aria-describedby": statusId });
  const status = h("div", { class: "sp-shortcut-status", id: statusId, role: "status" });
  const el = h("div", { class: "sp-row stack sp-shortcut" });
  /** Modifiers held so far while recording. */
  let partial: string[] = [];
  let doneAt = 0;

  const paint = () => {
    const state = !s.on ? "off" : s.recording ? "recording" : s.error ?? "ok";
    el.dataset.state = state;
    field.disabled = !s.on;
    clear(field);
    const shown = s.recording ? partial : s.error ? s.tried : s.keys;
    for (const key of shown) field.append(h("kbd", { text: key }));
    if (s.recording) field.append(h("span", { class: "wait", text: partial.length ? "+ a key…" : "Press the new shortcut…" }));
    else if (s.on) field.append(h("span", { class: "hint", text: "Click to change" }));
    field.setAttribute("aria-label", s.recording ? `${s.label}: recording` : `${s.label}: ${shown.join(" + ")}. Change`);
    clear(status);
    status.append(h("i"), h("span", { text:
      state === "off" ? "Off"
      : state === "recording" ? "Recording. Esc cancels."
      : state === "taken" ? "Already used by another app — pick another"
      : state === "same" ? "Same as the other shortcut"
      : "Works from any app" }));
  };

  const stop = () => {
    s.recording = false;
    partial = [];
    doneAt = performance.now();
    paint();
  };

  field.addEventListener("click", () => {
    // A shortcut ending in Space or Enter must not start the next recording.
    if (s.recording || performance.now() - doneAt < 250) return;
    s.recording = true;
    partial = [];
    paint();
  });
  field.addEventListener("blur", () => {
    if (s.recording) stop();
  });
  field.addEventListener("keydown", (e) => {
    if (!s.recording) return;
    if (e.key === "Tab") return stop();
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !heldModifiers(e).length) return stop();
    partial = heldModifiers(e);
    if (MODIFIERS.has(e.key) || !partial.length) return paint();
    const keys = [...partial, keyName(e)];
    const clash = Object.entries(shortcuts).some(([other, o]) => other !== name && keys.join("+") === o.keys.join("+"));
    if (clash) Object.assign(s, { error: "same", tried: keys });
    else if (TAKEN.has(keys.join("+"))) Object.assign(s, { error: "taken", tried: keys });
    else Object.assign(s, { error: null, tried: [], keys });
    stop();
  });
  field.addEventListener("keyup", (e) => {
    if (!s.recording) return;
    partial = heldModifiers(e);
    paint();
  });

  const onOff = toggle(s.on, `${s.label}: on`, (on) => {
    s.on = on;
    s.recording = false;
    paint();
  });
  el.append(h("div", { class: "sp-shortcut-top" }, h("div", { class: "sp-row-label", text: s.label }), onOff.el), field, status);
  paint();
  return el;
}

function generalSection(): Kid[] {
  const volume = slider("Volume", prefs.volume, (v) => `${v}%`, (v) => (prefs.volume = v));
  volume.setDisabled(!prefs.sound);
  const sound = toggle(prefs.sound, "Sound", (on) => {
    prefs.sound = on;
    volume.setDisabled(!on);
  });

  const custom = h("input", { type: "number", min: "2", max: "120", step: "1", value: String(prefs.autoCloseCustom), "aria-label": "Auto-close, in seconds" });
  custom.addEventListener("change", () => {
    prefs.autoCloseCustom = Math.max(2, Math.min(120, Math.round(Number(custom.value)) || 15));
    custom.value = String(prefs.autoCloseCustom);
  });
  const customFold = h("div", { class: `sp-fold${prefs.autoClose === "custom" ? " open" : ""}` },
    h("div", {}, h("label", { class: "sp-number" }, custom, h("span", { text: "seconds, from 2 to 120" }))));
  const autoClose = segmented("Auto-close", AUTO_CLOSE.map((v) => [v, v === "custom" ? "Custom" : `${v} s`] as const), prefs.autoClose, (v) => {
    prefs.autoClose = v;
    customFold.classList.toggle("open", v === "custom");
  });

  const screen = segmented("Display", [["primary", "Main display"], ["cursor", "Display under the cursor"]] as const, prefs.screen, (v) => (prefs.screen = v));

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
      row("Launch at startup", "Start Nook when you sign in to Windows.", toggle(prefs.autostart, "Launch at startup", (on) => (prefs.autostart = on)).el)),
    group("Shortcuts", shortcutRow("expand"), shortcutRow("goto"), shortcutRow("panel")),
  ];
}

// ── Island ────────────────────────────────────────────────────────────────────

const METRIC_MAX = 3;

interface MetricDef {
  name: string;
  icon: string;
  /** The cell's fixed width in the island, as compact-preview.ts has it. */
  width: number;
  value: string;
  later?: boolean;
}

const METRICS: Record<MetricId, MetricDef> = {
  cpu: { name: "CPU", icon: UI_ICONS.cpu, width: 50, value: "31%" },
  ram: { name: "RAM", icon: UI_ICONS.ram, width: 66, value: "11.2 GB" },
  usage5: { name: "5-hour usage", icon: UI_ICONS.gauge, width: 50, value: "38%" },
  usage7: { name: "7-day usage", icon: UI_ICONS.week, width: 50, value: "12%" },
  waiting: { name: "Sessions waiting", icon: ICONS.bell, width: 36, value: "1" },
  gpu: { name: "GPU", icon: UI_ICONS.gpu, width: 50, value: "" },
};
METRICS.gpu.later = true;
const METRIC_IDS = Object.keys(METRICS) as MetricId[];

// The compact island's fixed slots (dev/compact-preview.ts): bot · session dots · metrics.
const CI = { pad: 12, gap: 10, bot: 28, dot: 7, dotGap: 5, metricGap: 8 };
const DOTS: { color: string; calls?: boolean }[] = [{ color: "#FFB547", calls: true }, { color: "#5AA9FF" }, { color: "#4FD69C" }];

/** The folded island, live: made once, and told when the choice changes. */
const islandPreview = (() => {
  const dots = h("div", { class: "sp-ci-dots" });
  for (const d of DOTS) dots.append(h("i", { class: d.calls ? "calls" : "", style: `--c:${d.color}` }));
  const cells = h("div", { class: "sp-ci-metrics" });
  const island = h("div", { class: "sp-ci" }, h("div", { class: "sp-ci-bot" }, islandBot.el), dots, cells);
  const words = h("span");
  const width = h("span");
  const el = h("div", { class: "sp-live" },
    h("div", { class: "sp-desk", role: "img" }, island),
    h("div", { class: "sp-live-caption" }, words, width));
  const notch = new Notch(island, { w: 0, h: NOTCH_H, ear: EAR_COMPACT, corner: ROUNDED_CORNER });
  let shown = "";

  const update = (animate: boolean) => {
    const ids = prefs.metrics;
    if (ids.join() !== shown) {
      shown = ids.join();
      clear(cells);
      for (const id of ids) {
        const m = METRICS[id];
        cells.append(h("span", { class: "sp-ci-metric", style: `width:${m.width}px`, title: m.name, "data-id": id }, icon(m.icon, 12, 1.8), h("b", { text: m.value })));
      }
    }
    const dotsW = DOTS.length * CI.dot + (DOTS.length - 1) * CI.dotGap;
    const metricsW = ids.reduce((w, id) => w + METRICS[id].width, 0) + Math.max(0, ids.length - 1) * CI.metricGap;
    const w = CI.pad + CI.bot + CI.gap + dotsW + (metricsW ? CI.gap + metricsW : 0) + CI.pad;
    island.style.width = `${w}px`;
    island.style.marginLeft = `${-Math.round(w / 2)}px`;
    notch.set({ w, h: NOTCH_H, ear: EAR_COMPACT, corner: ROUNDED_CORNER }, animate && !still());
    const names = ids.map((id) => METRICS[id].name);
    words.textContent = names.length ? `Bot · sessions · ${names.join(" · ")}` : "Bot · sessions — no metrics, so the island is narrower";
    width.textContent = `${w + 2 * EAR_COMPACT} px`;
    el.querySelector(".sp-desk")!.setAttribute("aria-label", `Preview of the folded island: ${words.textContent}`);
  };
  update(false);

  // A sampled value moves, as it will on the island: the cell's width does not.
  const cpu = ["31%", "34%", "28%", "47%", "39%", "100%", "36%"];
  let tick = 0;
  window.setInterval(() => {
    const cell = cells.querySelector('[data-id="cpu"] b');
    if (cell) cell.textContent = cpu[++tick % cpu.length];
  }, 2500);

  return { el, update };
})();

/** The metrics to choose from: made once, repainted in place. */
const metricPicker = (() => {
  const list = h("ul", { class: "sp-metrics" });
  const count = h("span", { class: "count" });
  const refusal = h("div", { class: "sp-refusal", role: "status", hidden: true }, icon(UI_ICONS.warn, 15, 1.8), h("span"));
  const rows = new Map<MetricId, { el: HTMLElement; check: HTMLButtonElement; grip: HTMLButtonElement }>();

  const order = () => [...prefs.metrics, ...METRIC_IDS.filter((id) => !prefs.metrics.includes(id))];

  const paint = (animate = true) => {
    flip(list, () => {
      for (const id of order()) {
        const r = rows.get(id)!;
        const on = prefs.metrics.includes(id);
        r.el.classList.toggle("on", on);
        if (on) delete r.el.dataset.fixed;
        else r.el.dataset.fixed = "";
        r.check.setAttribute("aria-checked", String(on));
        r.grip.tabIndex = on ? 0 : -1;
        list.append(r.el);
      }
    }, !animate || still());
    count.textContent = `${prefs.metrics.length} of ${METRIC_MAX} chosen`;
    islandPreview.update(animate);
  };

  const refuse = (id: MetricId | null) => {
    for (const r of rows.values()) r.el.classList.remove("refused");
    refusal.hidden = id == null;
    if (id == null) return;
    const text = `Three at most. Remove one to show ${METRICS[id].name}.`;
    refusal.querySelector("span")!.textContent = text;
    say(text);
    const el = rows.get(id)!.el;
    void el.offsetWidth;
    el.classList.add("refused");
  };

  for (const id of METRIC_IDS) {
    const m = METRICS[id];
    const check = h("button", { class: "sp-check", type: "button", role: "checkbox" },
      h("i", { class: "box" }, icon(ICONS.check, 12, 3)),
      h("i", { class: "glyph" }, icon(m.icon, 16)),
      h("span", { class: "name", text: m.name }),
      m.later ? h("span", { class: "sp-tag", text: "Later" }) : h("span", { class: "sample", text: m.value }));
    if (m.later) {
      check.disabled = true;
      check.title = "Needs a different API per graphics vendor: not in the first version.";
    }
    check.addEventListener("click", () => {
      if (prefs.metrics.includes(id)) {
        prefs.metrics = prefs.metrics.filter((x) => x !== id);
        refuse(null);
      } else if (prefs.metrics.length >= METRIC_MAX) {
        // Refused, and said so: nothing is dropped to make room.
        return refuse(id);
      } else {
        prefs.metrics.push(id);
        refuse(null);
      }
      paint();
    });
    const grip = h("button", { class: "sp-grip", type: "button", "aria-label": `Move ${m.name}. Use the up and down arrows.`, title: "Drag to reorder" },
      icon(UI_ICONS.grip, 16, 2.4));
    grip.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      const at = prefs.metrics.indexOf(id);
      const to = at + step;
      if (!step || at < 0) return;
      e.preventDefault();
      if (to < 0 || to >= prefs.metrics.length) return;
      prefs.metrics.splice(at, 1);
      prefs.metrics.splice(to, 0, id);
      paint();
      grip.focus();
      say(`${m.name}, position ${to + 1} of ${prefs.metrics.length}`);
    });
    const el = h("li", { class: "sp-metric", "data-id": id }, grip, check);
    rows.set(id, { el, check, grip });
  }

  reorderable(list, {
    item: ".sp-metric",
    handle: ".sp-grip",
    still,
    onDrop: (ids) => {
      prefs.metrics = (ids as MetricId[]).filter((id) => prefs.metrics.includes(id));
      paint();
    },
  });

  paint(false);
  return { list, count, refusal, refuse };
})();

/** The bot's colours: a suggestion (see the section's note), kept in one place so it can go in one cut. */
function botColours(): HTMLElement {
  const names = Object.keys(BOT_THEMES) as BotTheme[];
  const swatches = h("div", { class: "sp-swatches", role: "radiogroup", "aria-label": "Bot colour" });
  const buttons = names.map((name) => {
    const b = h("button", { class: "sp-swatch", type: "button", role: "radio", "aria-label": BOT_THEMES[name].label, title: BOT_THEMES[name].label },
      h("i", { style: `--c:${BOT_THEMES[name].b}` }));
    b.addEventListener("click", () => pick(name));
    return b;
  });
  const label = h("span", { class: "count" });
  const paint = () => {
    buttons.forEach((b, i) => {
      const on = names[i] === prefs.botTheme;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    label.textContent = BOT_THEMES[prefs.botTheme].label;
  };
  const pick = (name: BotTheme) => {
    prefs.botTheme = name;
    wearTheme();
    paint();
  };
  swatches.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const to = (names.indexOf(prefs.botTheme) + step + names.length) % names.length;
    pick(names[to]);
    buttons[to].focus();
  });
  swatches.append(...buttons);
  paint();
  return h("section", { class: "sp-group" },
    h("h2", { class: "sp-group-label" }, "Bot colour", h("span", { class: "sp-tag", text: "Suggestion" }), label),
    swatches,
    h("p", { class: "sp-note", text: "Not something you asked for: the bot already has these six colours built in. Shown here in case you want it; easy to leave out." }));
}

function islandSection(): Kid[] {
  metricPicker.refuse(null);
  return [
    ...title("Island", "What the folded island shows beside the bot and the session dots."),
    islandPreview.el,
    h("section", { class: "sp-group", style: "margin-top:14px" },
      h("h2", { class: "sp-group-label" }, "Metrics", metricPicker.count),
      metricPicker.list,
      metricPicker.refusal,
      h("p", { class: "sp-note", text: "Up to three, in the order shown: drag a chosen one to move it. With none, the island is narrower." })),
    botColours(),
  ];
}

// ── Shelf ─────────────────────────────────────────────────────────────────────

const WIDGET_ABOUT: Record<WidgetId, string> = {
  media: "What is playing, with play and skip.",
  todo: "Your latest items, and a field to add one.",
  timer: "A countdown you can start and pause.",
  reminders: "The next reminder, and a quick add.",
  mirror: "A button that opens the camera view.",
  projects: "Recent folders, to open in VS Code.",
};

/** The shelf's cards in their order: made once, repainted in place. */
const shelfPicker = (() => {
  // The island's black, and the dark tokens with it, whatever the window's theme.
  const tray = h("div", { class: "sp-tray sp-dark", role: "list", "aria-label": "Shelf widgets, in their order" });
  const count = h("span", { class: "count" });
  const cards = new Map<WidgetId, HTMLElement>();

  /** Shown ones in their order, then the hidden ones. */
  const order = () => [
    ...prefs.shelfOrder.filter((id) => !prefs.shelfHidden.has(id)),
    ...prefs.shelfOrder.filter((id) => prefs.shelfHidden.has(id)),
  ];

  const paint = (animate = true) => {
    const ids = order();
    const shown = ids.length - prefs.shelfHidden.size;
    flip(tray, () => {
      ids.forEach((id, i) => {
        const card = cards.get(id)!;
        const hidden = prefs.shelfHidden.has(id);
        card.classList.toggle("hidden", hidden);
        if (hidden) card.dataset.fixed = "";
        else delete card.dataset.fixed;
        card.setAttribute("aria-label", hidden
          ? `${WIDGETS[id].name}, hidden`
          : `${WIDGETS[id].name}, position ${i + 1} of ${shown}. Arrow keys move it.`);
        tray.append(card);
      });
    }, !animate || still());
    count.textContent = `${shown} of ${ids.length} shown`;
  };

  for (const id of DEFAULT_ORDER) {
    const def = WIDGETS[id];
    const card = h("div", { class: "sp-card", role: "listitem", tabindex: "0", "data-id": id, style: `--c:${def.accent}` },
      h("div", { class: "sp-card-head" },
        h("span", { class: "sp-mark" }, icon(def.icon, 13, 1.9)),
        h("b", { text: def.name }),
        toggle(true, `Show ${def.name}`, (on) => {
          if (on) prefs.shelfHidden.delete(id);
          else prefs.shelfHidden.add(id);
          paint();
          say(`${def.name} ${on ? "shown" : "hidden"}`);
        }).el),
      h("p", { text: WIDGET_ABOUT[id] }));
    card.addEventListener("keydown", (e) => {
      if (e.target !== card || prefs.shelfHidden.has(id)) return;
      const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      const shown = order().filter((x) => !prefs.shelfHidden.has(x));
      const at = shown.indexOf(id);
      const to = at + step;
      if (to < 0 || to >= shown.length) return;
      shown.splice(at, 1);
      shown.splice(to, 0, id);
      prefs.shelfOrder = [...shown, ...prefs.shelfOrder.filter((x) => prefs.shelfHidden.has(x))];
      paint();
      card.focus();
      say(`${def.name}, position ${to + 1} of ${shown.length}`);
    });
    cards.set(id, card);
  }

  reorderable(tray, {
    item: ".sp-card",
    ignore: ".sp-toggle",
    still,
    onDrop: (ids) => {
      prefs.shelfOrder = ids as WidgetId[];
      paint();
    },
  });

  paint(false);
  return { tray, count };
})();

function shelfSection(): Kid[] {
  return [
    ...title("Shelf", "The widgets on the island's Shelf tab, in the order they stand there."),
    h("section", { class: "sp-group" },
      h("h2", { class: "sp-group-label" }, "Widgets", shelfPicker.count),
      shelfPicker.tray,
      h("p", { class: "sp-note", text: "Drag a card to move it, or focus it and use the arrow keys. A hidden widget does no work in the background." }),
      h("p", { class: "sp-note", text: "Mirror's camera only runs while its expanded view is open." })),
  ];
}

// ── Appearance ────────────────────────────────────────────────────────────────

let themeControl: Segmented<Theme> | null = null;
let motionControl: Segmented<Motion> | null = null;

function appearanceSection(): Kid[] {
  themeControl = segmented<Theme>("Theme", [["light", "Light"], ["dark", "Dark"], ["system", "System"]], pv.theme, setTheme);
  motionControl = segmented<Motion>("Reduce motion", [["system", "Follow system"], ["on", "On"], ["off", "Off"]], pv.motion, setMotion);
  return [
    ...title("Appearance"),
    group("Theme",
      h("div", { class: "sp-row stack" },
        h("div", { class: "sp-row-text" },
          h("div", { class: "sp-row-label", text: "Settings window" }),
          h("p", { class: "sp-help", text: `System follows Windows, which is set to ${systemDark.matches ? "dark" : "light"} now. The island itself always stays dark.` })),
        themeControl.el)),
    group("Motion",
      h("div", { class: "sp-row stack" },
        h("div", { class: "sp-row-text" },
          h("div", { class: "sp-row-label", text: "Reduce motion" }),
          h("p", { class: "sp-help", text: "Changes happen at once, without springs or fades." })),
        motionControl.el)),
  ];
}

// ── About ─────────────────────────────────────────────────────────────────────

function aboutSection(): Kid[] {
  const place = (label: string, help: string, path: string) =>
    h("div", { class: "sp-row" },
      h("div", { class: "sp-row-text" }, h("div", { class: "sp-row-label", text: label }), h("p", { class: "sp-help", text: help })),
      h("span", { class: "sp-path" }, ...breakable(path)));
  const noted = h("p", { class: "sp-help", role: "status", hidden: true, text: "Preview only: the folder would open in Explorer." });
  return [
    h("div", { class: "sp-about" },
      h("div", { class: "sp-nook", "aria-hidden": "true" }, aboutBot.el),
      h("div", {},
        h("h1", { class: "sp-about-name", text: "Nook" }),
        h("p", { class: "sp-about-version", text: `Version ${VERSION}` }))),
    group("Privacy",
      h("p", { class: "sp-lede", style: "margin-top:8px;color:var(--text)", text: "No telemetry and no network requests: everything stays on this machine." })),
    group("Where your data lives",
      place("Settings", "Preferences and the shelf's order", "%APPDATA%\\Nook"),
      place("Logs and relay", "The log files and nook-hook.exe", "%LOCALAPPDATA%\\Nook"),
      h("div", { class: "sp-row stack" },
        h("button", { class: "sp-link", type: "button", onclick: () => (noted.hidden = false) },
          icon(UI_ICONS.folder, 16), h("span", { class: "sp-link-text", text: "Open log folder" }), icon(ICONS.arrowUpRight, 14, 0)),
        noted)),
    h("p", { class: "sp-credits", text: "A fork of Coucou by Louis Raillé, built on work by Edurique. MIT licence." }),
  ];
}

// ── Putting a section on show ─────────────────────────────────────────────────

const BUILD: Record<Section, () => Kid[]> = {
  claude: claudeSection, general: generalSection, island: islandSection,
  shelf: shelfSection, appearance: appearanceSection, about: aboutSection,
};

let pane: HTMLElement | null = null;

function show(animate: boolean) {
  const next = h("div", { class: "sp-pane", id: "sp-pane", role: "tabpanel", "aria-labelledby": `tab-${pv.section}` }, ...BUILD[pv.section]());
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
    const on = id === pv.section;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  navMark.style.setProperty("--at", String(SECTIONS.indexOf(pv.section)));
}

/** The section on show again, where it was scrolled to: a state changed under it. */
function repaint() {
  const scroll = pane?.scrollTop ?? 0;
  show(false);
  pane!.scrollTop = scroll;
}

function setSection(next: Section) {
  if (next === pv.section && pane) return;
  pv.section = next;
  sectionPicker.set(next);
  remember();
  show(true);
}

function setHooks(next: HooksCase) {
  pv.hooks = next;
  pv.hooksFlow = next === "diff" ? { at: "confirm", install: true } : { at: "status" };
  hooksPicker.set(next);
  remember();
  if (pv.section === "claude") repaint();
}

function setUsage(next: UsageCase) {
  pv.usage = next;
  pv.usageFlow = { at: "status" };
  usagePicker.set(next);
  remember();
  if (pv.section === "claude") repaint();
}

function setShortcuts(next: ShortcutCase) {
  pv.shortcuts = next;
  applyShortcutCase(next);
  remember();
  if (pv.section === "general") repaint();
}

function setTheme(next: Theme) {
  pv.theme = next;
  win.dataset.theme = resolvedTheme();
  themePicker.set(next);
  themeControl?.set(next);
  remember();
}

function setMotion(next: Motion) {
  pv.motion = next;
  win.dataset.motion = still() ? "reduce" : "full";
  motionPicker.set(next);
  motionControl?.set(next);
  remember();
}

function resize(name: SizeName) {
  pv.size = name;
  const [w, hgt] = SIZES[name];
  body.style.width = `${w}px`;
  body.style.height = `${hgt}px`;
  remember();
}

new ResizeObserver(() => {
  sizeLine.textContent = `${Math.round(body.offsetWidth)} × ${Math.round(body.offsetHeight)} — drag the window's bottom-right corner to resize`;
}).observe(body);

// ── Preview controls ──────────────────────────────────────────────────────────

const sizePicker = picker<SizeName>("Window size", [["small", "460 × 480"], ["real", "560 × 680"], ["wide", "800 × 760"]], pv.size, resize);
const themePicker = picker<Theme>("Theme", [["light", "Light"], ["dark", "Dark"], ["system", "System"]], pv.theme, setTheme);
const sectionPicker = picker<Section>("Section", SECTIONS.map((id) => [id, TABS[id].name] as const), pv.section, setSection);
const hooksPicker = picker<HooksCase>("Hooks", [
  ["installed", "Connected"],
  ["none", "Not installed"],
  ["legacy", "Old hooks found"],
  ["relay", "Relay missing"],
  ["diff", "Diff panel open"],
], pv.hooks, setHooks);
const usagePicker = picker<UsageCase>("Usage limits", [
  ["none", "Not installed"],
  ["installed", "Installed"],
  ["chained", "Installed, chained to an existing status line"],
], pv.usage, setUsage);
const shortcutPicker = picker<ShortcutCase>("Shortcuts", [
  ["ok", "Both fine"],
  ["recording", "Recording"],
  ["taken", "Used by another app"],
  ["same", "Same as the other"],
  ["off", "One off"],
], pv.shortcuts, setShortcuts);
const motionPicker = picker<Motion>("Reduced motion", [["system", "Follow system"], ["on", "On"], ["off", "Off"]], pv.motion, setMotion);

document.getElementById("controls")!.append(
  controls(
    "Fake data: nothing is read from or written to this machine.",
    sizePicker.el, themePicker.el, sectionPicker.el, hooksPicker.el, usagePicker.el, shortcutPicker.el, motionPicker.el,
  ),
);

systemDark.addEventListener("change", () => {
  win.dataset.theme = resolvedTheme();
  if (pv.section === "appearance") repaint();
});
systemStill.addEventListener("change", () => (win.dataset.motion = still() ? "reduce" : "full"));

// ── Go ────────────────────────────────────────────────────────────────────────

wearTheme();
applyShortcutCase(pv.shortcuts);
pv.hooksFlow = pv.hooks === "diff" ? { at: "confirm", install: true } : { at: "status" };
win.dataset.theme = resolvedTheme();
win.dataset.motion = still() ? "reduce" : "full";
resize(pv.size);
show(false);
startBots();
