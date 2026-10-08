// The settings window: a sidebar of categories in small groups — Connect; the
// Island, Look and colours, Sounds; the Agents list, Shortcuts, Shelf widgets;
// About — a search above them, and one category on show at a time.
//
// Every category is built once, when the window opens, and kept: another
// category shows one and hides the rest, and a search moves the rows that
// match — the very elements, their controls working — into a list of results,
// then back where they were when it is cleared. Nothing is built twice, so no
// control and no id exists twice either.
//
// Every setting applies at once. Only what writes to Claude Code's
// settings.json (or its CLAUDE.md, or Cursor's hooks.json) asks first: Nook
// shows the diff, and nothing is written until the button under it is pressed
// — with the fingerprint of the diff on show, so a file that changed in
// between is refused by Rust rather than written over.

import "./settings.css";
import type { AboutLink, CodexStatus, CursorStatus, DataPaths, HookPreview, HookStatus, ReplyFormatAction, ReplyFormatStatus, ShortcutName, ShortcutStatus, UpdateInfo, UsageStatus } from "../core/bridge";
import { COMPACT_METRICS, DEFAULT_SETTINGS, FADE_MAX, FADE_MIN, FOLDED_AUTO_HIDE, MAX_COMPACT_METRICS, compactMetrics, foldedAutoHide, type CompactMetric, type SessionAgent, type Settings } from "../core/state";
import { BOT_THEMES } from "../bot/engine";
import { clear, h, replay } from "../views/dom";
import { BRANDS, CLAUDE_MARK, CODEX_MARK, LUCIDE, brand } from "../views/iconset";
import { TOOL_NAME } from "../views/tool";
import { connect, type Backend } from "./backend";
import { isBotTheme, mountBot, refreshBots, startBots, wearBotTheme } from "./bots";
import { COMPACT_BOT, COMPACT_CELLS, cellIcon, islandPreview } from "./island-preview";
import { SPRING, flip, icon, reorderable, segmented, slider, toggle, type Toggle } from "./ui";

// ── What the window knows ─────────────────────────────────────────────────────

const SECTIONS = ["connect", "island", "look", "sounds", "agents", "shortcuts", "shelf", "about"] as const;
type Section = (typeof SECTIONS)[number];
/** What the categories were called before they were regrouped: an old link still lands. */
const OLD_SECTIONS: Record<string, Section> = { claude: "connect", general: "island", appearance: "look" };
const sectionNamed = (name: string | null | undefined): Section | null =>
  !name ? null : (SECTIONS as readonly string[]).includes(name) ? (name as Section) : OLD_SECTIONS[name] ?? null;

type Theme = Settings["theme"];
type Motion = Settings["reduceMotion"];

let nook: Backend;
let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";
let hooks: HookStatus | null = null;
let usage: UsageStatus | null = null;
let reply: ReplyFormatStatus | null = null;
let cursor: CursorStatus | null = null;
let codex: CodexStatus | null = null;
/** The last write of the reply format created CLAUDE.md: there was no previous file to save. */
let wasCreated = false;
let paths: DataPaths | null = null;
let shortcutsNow: Record<ShortcutName, ShortcutStatus> | null = null;
let section: Section = "connect";

const page = document.documentElement;
const root = document.getElementById("settings-root")!;

/** What Rust, or the bridge, refused with — as a sentence, without the "Error:" a thrown one carries. */
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error:\s*/, "");

/** Each category: its name, its mark, the group of the sidebar it stands in, and what it is for, in a sentence. */
const INFO: Record<Section, { name: string; icon: string; group: string; lede: string }> = {
  connect: {
    name: "Connect", icon: LUCIDE.plug, group: "Setup",
    lede: "Link Nook to Claude Code, Cursor and Codex. Nothing on your computer is changed until you have seen the change and said yes.",
  },
  island: {
    name: "Island", icon: LUCIDE.panelTop, group: "The island",
    lede: "Where the island sits on your screen, when it gets out of the way, and what it shows.",
  },
  look: {
    name: "Look and colours", icon: LUCIDE.palette, group: "The island",
    lede: "Gullu's colour, the colours of this window, and how lively things are.",
  },
  sounds: {
    name: "Sounds", icon: LUCIDE.volume2, group: "The island",
    lede: "Hear when Claude needs you, without keeping an eye on the island.",
  },
  agents: {
    name: "Agents list", icon: LUCIDE.list, group: "Extras",
    lede: "A small window that stays on top, with a row for each project Claude is working on.",
  },
  shortcuts: {
    name: "Shortcuts", icon: LUCIDE.keyboard, group: "Extras",
    lede: "Key combinations that work from any app. Click one, then press the new keys.",
  },
  shelf: {
    name: "Shelf widgets", icon: LUCIDE.layoutGrid, group: "Extras",
    lede: "The small tools in the island's Shelf tab: which ones are on, and their order.",
  },
  about: {
    name: "About and privacy", icon: LUCIDE.info, group: "",
    lede: "Nook keeps everything on this computer. Here is where, and who made it.",
  },
};

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
  paintResets();
  if (!soon) return save();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 140);
}

/**
 * What every category does when the settings change under it. Every category
 * is built once and kept, so these are kept too: one shown later is already
 * up to date, and a row moved into the search results goes on following.
 */
const followers: (() => void)[] = [];
const follow = () => {
  for (const f of followers) f();
};

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
  follow();
  paintResets();
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

type Kid = Node | string | null | undefined | false;

/** A category's mark: its icon on a tile of its own colour (settings.css `[data-hue]`). */
const tile = (id: Section, size: number, extra = "") =>
  h("span", { class: `sp-tile ${extra}`, "data-hue": id, "aria-hidden": "true" }, icon(INFO[id].icon, size, 2));

const app = h("div", { class: "sp-app" });
const navMark = h("i", { class: "sp-nav-mark", "aria-hidden": "true" });
const nav = h("div", { class: "sp-nav", role: "tablist", "aria-orientation": "vertical", "aria-label": "Settings categories" }, navMark);
const tabs = new Map<Section, HTMLButtonElement>();
{
  let lastGroup: string | null = null;
  for (const id of SECTIONS) {
    const { name, group: label } = INFO[id];
    if (label !== lastGroup) {
      // Out of the accessibility tree: a tablist holds tabs, and each tab's name says enough.
      nav.append(h("div", { class: label ? "sp-nav-group" : "sp-nav-gap", "aria-hidden": "true", text: label || undefined }));
      lastGroup = label;
    }
    const tab = h("button", {
      class: "sp-tab", type: "button", role: "tab", id: `tab-${id}`, "aria-controls": `pane-${id}`, "data-hue": id,
      // The name stays on the tab when the sidebar folds to its icons.
      "aria-label": name, title: name,
    }, tile(id, 15), h("span", { class: "sp-tab-name", text: name }));
    tab.addEventListener("click", () => setSection(id));
    tabs.set(id, tab);
    nav.append(tab);
  }
}

// One stop in the tab order: Up, Down, Home and End move between the categories.
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

/** The marker of the category on show, beside its tab: where the tab is, whatever the group labels above it take. */
const placeMark = () => {
  const tab = tabs.get(section);
  if (tab) navMark.style.setProperty("--y", `${tab.offsetTop + (tab.offsetHeight - 16) / 2}px`);
};
// The sidebar folds to its icons, and back: the tabs move, and the marker with them.
new ResizeObserver(placeMark).observe(nav);

const main = h("main", { class: "sp-main" });
/** Says what a move or a refusal did, to a screen reader. */
const live = h("div", { class: "sp-sr", role: "status", "aria-live": "polite" });
const say = (text: string) => (live.textContent = text);
const versionLine = h("span");

// ── Small pieces every category uses ──────────────────────────────────────────

/** A category's title: its mark, its name, and what it is for. */
const heads = new Map<Section, HTMLElement>();
function head(id: Section): HTMLElement {
  const el = h("header", { class: "sp-head" },
    tile(id, 20, "big"),
    h("div", { class: "sp-head-text" },
      h("h1", { class: "sp-title", text: INFO[id].name }),
      h("p", { class: "sp-lede", text: INFO[id].lede })));
  heads.set(id, el);
  return el;
}

/** Settings that belong together: a small heading, and a card the rows sit on. */
const group = (label: string | null, ...kids: Kid[]) =>
  h("section", { class: "sp-group" }, label ? h("h2", { class: "sp-group-label", text: label }) : null, h("div", { class: "sp-box" }, ...kids));

/** The same, for what brings its own card or tray. */
const bare = (label: string | Node | null, ...kids: Kid[]) =>
  h("section", { class: "sp-group" }, label ? h("h2", { class: "sp-group-label" }, label) : null, ...kids);

const rowText = (label: string, help: string | null, ...more: Kid[]) =>
  h("div", { class: "sp-row-text" },
    h("div", { class: "sp-row-label", text: label }),
    help ? h("p", { class: "sp-help", text: help }) : null,
    ...more);

/** A setting: its name and help on the left, its control on the right. A search finds it by any of those words, or `keys`. */
const row = (label: string, help: string | null, control: Kid, keys = "", ...more: Kid[]) =>
  findable(h("div", { class: "sp-row" }, rowText(label, help, ...more), control), label, help, keys);

/** The same, with a control too wide to sit beside its name: it goes under it. */
const stackRow = (label: string, help: string | null, keys: string, ...controls: Kid[]) =>
  findable(h("div", { class: "sp-row stack" }, rowText(label, help), ...controls), label, help, keys);

/** Why a control is greyed out — another setting is off — said under its name, and only then. */
const needs = () => h("p", { class: "sp-needs", hidden: true });
const sayNeeds = (el: HTMLElement, why: string | null) => {
  el.hidden = why == null;
  el.textContent = why ?? "";
};

/** A path, free to wrap after any of its separators and nowhere else. */
const breakable = (path: string): Kid[] =>
  path.split(/(?<=[\\/])/).flatMap((part, i) => (i ? [h("wbr"), part] : [part]));

const button = (text: string, kind: string, onClick: () => void) =>
  h("button", { class: `sp-btn ${kind}`, type: "button", text, onclick: onClick });

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Every row a search can find: the element itself, and its words — name, help,
 * the words somebody might type for it instead (`keys`), and its category's
 * name. A "block" (a card of its own: a Connect panel, the Shelf's tray) is
 * shown on its own in the results; rows of one category share a card there.
 */
interface Entry {
  section: Section;
  el: HTMLElement;
  words: string;
  block: boolean;
  /** Where it stands in its category while it is in the results. */
  home?: Comment;
}
const index: Entry[] = [];
/** The category being built: what `findable` files a row under. */
let building: Section = "connect";

/** Lower case, without accents or quotes: "Colour" and "colour", "café" and "cafe" are one. */
const plain = (text: string) =>
  text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[“”"'‘’]/g, "");

function findable<T extends HTMLElement>(el: T, label: string, help: string | null, keys = "", block = false): T {
  index.push({ section: building, el, block, words: plain(`${label} ${help ?? ""} ${keys} ${INFO[building].name}`) });
  return el;
}

const searchInput = h("input", {
  class: "sp-search-input", type: "search", id: "sp-search", placeholder: "Search settings",
  autocomplete: "off", spellcheck: "false", "aria-controls": "sp-results",
});
const searchClear = h("button", { class: "sp-search-clear", type: "button", "aria-label": "Clear the search", title: "Clear (Esc)", hidden: true },
  icon(LUCIDE.x, 14, 2.2));
const searchBox = h("div", { class: "sp-search", role: "search" },
  h("label", { class: "sp-sr", for: "sp-search", text: "Search settings" }),
  icon(LUCIDE.search, 15, 2.1),
  searchInput, searchClear,
  h("kbd", { class: "sp-search-key", "aria-hidden": "true", text: "/" }));
/** In a narrow window the field folds to this; pressed, the field comes out over the window's top. */
const searchOpen = h("button", { class: "sp-search-open", type: "button", "aria-label": "Search settings", title: "Search settings (/)" },
  icon(LUCIDE.search, 17, 2));

const resultsTitle = h("h1", { class: "sp-title", id: "sp-results-title", text: "Search" });
const resultsCount = h("p", { class: "sp-lede", role: "status", "aria-live": "polite" });
const resultsList = h("div", { class: "sp-results-list" });
const results = h("div", { class: "sp-pane sp-results", id: "sp-results", role: "region", "aria-labelledby": "sp-results-title", hidden: true },
  h("header", { class: "sp-head" },
    h("span", { class: "sp-tile big", "data-hue": "search", "aria-hidden": "true" }, icon(LUCIDE.search, 20, 2)),
    h("div", { class: "sp-head-text" }, resultsTitle, resultsCount)),
  resultsList);

let query = "";

/** Every row that is in the results goes back where it stands in its category. */
function putBack() {
  let leftConnect = false;
  for (const e of index) {
    if (!e.home) continue;
    if (e.section === "connect") leftConnect = true;
    e.home.replaceWith(e.el);
    e.home = undefined;
  }
  clear(resultsList);
  // A diff opened among the results does not wait in the hidden Connect page: it is
  // dropped (never applied), so the next visit reads the files again. One being
  // written (`busy`) is left to finish and say how it went.
  if (leftConnect) {
    let dropped = false;
    for (const kind of CHANGES) {
      const flow = flows[kind];
      if (flow.at === "confirm" && !flow.busy) {
        flows[kind] = { at: "status" };
        dropped = true;
      }
    }
    if (dropped) paintClaude();
  }
}

/** The tabs while a search is on show: no category is selected, so none is announced or lit. */
function paintTabs() {
  for (const [id, tab] of tabs) {
    const on = id === section && query === "";
    tab.setAttribute("aria-selected", String(on));
    // Still one stop in the tab order while searching: the category that was on show.
    tab.tabIndex = id === section ? 0 : -1;
    if (on) tab.setAttribute("aria-controls", `pane-${id}`);
    else tab.removeAttribute("aria-controls");
  }
}

/** Shows what matches `text` — every word of it, anywhere in a row's words — or, with nothing typed, the category again. */
function runSearch(text: string) {
  putBack();
  query = text.trim();
  searchClear.hidden = !text;
  app.classList.toggle("searching", query !== "");
  paintTabs();
  const pane = panes.get(section);
  if (!query) {
    results.hidden = true;
    if (pane) pane.hidden = false;
    // Cleared from elsewhere (a result's category opened): a narrow window's field folds away again.
    if (document.activeElement !== searchInput) app.classList.remove("search-open");
    return;
  }
  if (pane) pane.hidden = true;
  results.hidden = false;
  results.scrollTop = 0;

  const words = plain(query).split(/\s+/).filter(Boolean);
  const hits = index.filter((e) => words.every((w) => e.words.includes(w)));
  resultsTitle.textContent = `“${query}”`;
  resultsCount.textContent = hits.length === 0 ? "Nothing found." : hits.length === 1 ? "1 setting found." : `${hits.length} settings found.`;
  if (!hits.length) {
    resultsList.append(h("div", { class: "sp-empty" },
      icon(LUCIDE.search, 26, 1.8),
      h("p", { class: "sp-empty-title", text: `Nothing matches “${query}”. Try a simpler word.` }),
      h("p", { class: "sp-help", text: "For example: sound, dark, bottom, startup or shortcut." })));
    return;
  }
  for (const id of SECTIONS) {
    const mine = hits.filter((e) => e.section === id);
    if (!mine.length) continue;
    const crumb = h("button", { class: "sp-crumb", type: "button", title: `Open ${INFO[id].name}`, "aria-label": `In ${INFO[id].name}. Open it.` },
      tile(id, 12), h("span", { text: INFO[id].name }), icon(LUCIDE.arrowRight, 13, 2.2));
    crumb.addEventListener("click", () => goTo(id, mine[0].el));
    const hit = h("section", { class: "sp-hit", "aria-label": INFO[id].name }, crumb);
    let box: HTMLElement | null = null;
    for (const e of mine) {
      e.home = document.createComment("");
      e.el.replaceWith(e.home);
      if (e.block) {
        hit.append(e.el);
        box = null;
      } else {
        if (!box) hit.append((box = h("div", { class: "sp-box" })));
        box.append(e.el);
      }
    }
    resultsList.append(hit);
  }
}

function clearSearch() {
  if (!searchInput.value && !query) return;
  searchInput.value = "";
  runSearch("");
}

/** A category, opened at one of its rows: it is brought into view and lit for a moment. */
function goTo(id: Section, el?: HTMLElement) {
  clearSearch();
  setSection(id);
  // The chip that was clicked is gone: focus goes to the row's first control, or to the page's heading.
  const target = el?.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
    ?? heads.get(id)?.querySelector<HTMLElement>("h1");
  window.requestAnimationFrame(() => {
    if (el) {
      el.scrollIntoView({ block: "center", behavior: still() ? "auto" : "smooth" });
      replay(el, "sp-lit");
    }
    if (target) {
      if (!target.matches("button, input, select, textarea, [tabindex]")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  });
}

searchInput.addEventListener("input", () => runSearch(searchInput.value));
searchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  if (searchInput.value) clearSearch();
  else searchInput.blur();
});
searchInput.addEventListener("blur", () => {
  if (!searchInput.value) app.classList.remove("search-open");
});
searchClear.addEventListener("click", () => {
  clearSearch();
  searchInput.focus();
});
function focusSearch() {
  app.classList.add("search-open");
  searchInput.focus();
  searchInput.select();
}
searchOpen.addEventListener("click", focusSearch);

// "/" or Ctrl+F, from anywhere but a field being typed in — or a shortcut being
// recorded, which keeps its keys to itself.
document.addEventListener("keydown", (e) => {
  const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]");
  const slash = e.key === "/" && !e.ctrlKey && !e.altKey && !e.metaKey && !typing;
  const find = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f";
  if (e.defaultPrevented || !(slash || find)) return;
  e.preventDefault();
  focusSearch();
});

// ── Reset, a category at a time ───────────────────────────────────────────────

/** The settings each category puts back. Never the connections: those are only ever changed through their diff. */
const RESET_FIELDS: Partial<Record<Section, readonly (keyof Settings)[]>> = {
  island: ["screen", "dock", "autostart", "autoCloseInterval", "foldedAutoHide", "hideOnlyWhenIdle", "hideInFullscreen", "compactMetrics"],
  look: ["botTheme", "playfulReactions", "theme", "reduceMotion"],
  sounds: ["soundEnabled", "soundVolume"],
  agents: ["showAgentsList", "agentsListFade", "agentsListFadeOpacity"],
  shelf: ["shelfOrder", "shelfHidden"],
};
/** What the reset of each says it does. */
const RESET_WORDS: Partial<Record<Section, string>> = {
  island: "Puts everything on this page back as it was when Nook was installed, including starting with your computer (off).",
  look: "Puts Gullu's colour, the window's colours and the motion back as they came.",
  sounds: "Turns sounds back on, at the volume they came with.",
  agents: "Turns the agents list off and puts its fading back as it came. Where you put the list, and its size, are kept.",
  shortcuts: "Puts all five shortcuts back to Nook's keys, and turns them on.",
  shelf: "Shows every widget again, in the order they came in.",
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function atDefaults(id: Section): boolean {
  if (id === "shortcuts") {
    return SHORTCUTS.every(({ which }) => {
      const [key, on] = SHORTCUT_FIELDS[which];
      return settings[key] === DEFAULT_SETTINGS[key] && settings[on] === DEFAULT_SETTINGS[on];
    });
  }
  return (RESET_FIELDS[id] ?? []).every((key) => same(settings[key], DEFAULT_SETTINGS[key]));
}

async function resetSection(id: Section) {
  if (id === "shortcuts") {
    // Rust registers a shortcut before it saves it, one at a time. One refused
    // because another still holds its keys gets them on the next round.
    for (let round = 0; round < 3 && !atDefaults("shortcuts"); round++) {
      for (const { which } of SHORTCUTS) await shortcutResets.get(which)?.();
    }
  } else {
    const patch: Record<string, unknown> = {};
    for (const key of RESET_FIELDS[id] ?? []) patch[key] = structuredClone(DEFAULT_SETTINGS[key]);
    // The normal way: kept, applied at once, saved — and the island told.
    change(patch as Partial<Settings>);
    autoCloseCustom = autoClosePreset() === "custom";
    follow();
  }
  paintResets();
}

const resetPainters: (() => void)[] = [];
const paintResets = () => {
  for (const paint of resetPainters) paint();
};
/** Arms a category's reset as a first click does (the made-up window's `reset=armed`). */
const resetArmers = new Map<Section, () => void>();

/**
 * "Reset this section", at the foot of a category: a quiet button that asks
 * twice. The first click arms it — its words change, and a screen reader is
 * told — and it disarms by itself after a few seconds; the second resets.
 */
function resetFoot(id: Section): HTMLElement {
  const IDLE = "Reset this section";
  const words = h("span", { text: IDLE });
  const b = h("button", { class: "sp-reset", type: "button" }, icon(LUCIDE.rotateCcw, 14, 2.1), words);
  const note = h("p", { class: "sp-help", id: `reset-note-${id}` });
  b.setAttribute("aria-describedby", note.id);
  let armed = 0;
  let busy = false;
  const paint = () => {
    const done = atDefaults(id);
    // Never `disabled` (while resetting, or once it is as it came): that would strand the keyboard focus on a button that just reset.
    const spent = busy || (done && !armed);
    b.setAttribute("aria-disabled", String(spent));
    b.classList.toggle("spent", spent);
    b.classList.toggle("armed", armed !== 0);
    words.textContent = busy ? "Resetting…" : armed ? "Click again to reset" : IDLE;
    note.textContent = done && !armed ? "Everything here is as it came." : RESET_WORDS[id] ?? "";
  };
  const disarm = () => {
    window.clearTimeout(armed);
    armed = 0;
    paint();
  };
  const arm = () => {
    armed = window.setTimeout(disarm, 4000);
    paint();
    say(`Click again to reset ${INFO[id].name}.`);
  };
  b.addEventListener("click", async () => {
    if (busy || (!armed && atDefaults(id))) return;
    if (!armed) return arm();
    window.clearTimeout(armed);
    armed = 0;
    busy = true;
    paint();
    await resetSection(id);
    busy = false;
    paint();
    say(`${INFO[id].name} is reset.`);
  });
  b.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && armed) {
      e.preventDefault();
      disarm();
    }
  });
  resetPainters.push(paint);
  resetArmers.set(id, arm);
  paint();
  return h("div", { class: "sp-reset-foot" }, b, note);
}

// ── Connect: Claude Code and Cursor ───────────────────────────────────────────

/**
 * What Nook writes for Claude Code: the hooks and the status line the usage
 * limits come through, in ~/.claude/settings.json; the reply format, in
 * ~/.claude/CLAUDE.md. One flow for the three: the diff, then an explicit click.
 */
type Change = "hooks" | "usage" | "reply" | "cursor" | "codex";
const CHANGES: readonly Change[] = ["hooks", "usage", "reply", "cursor", "codex"];
/** The file each one changes, as the panel names it. (Cursor's is ~/.cursor/hooks.json, Codex's ~/.codex/hooks.json: the same flow.) */
const CHANGED_FILE: Record<Change, string> = { hooks: "settings.json", usage: "settings.json", reply: "CLAUDE.md", cursor: "hooks.json", codex: "hooks.json" };

/** Where a part's install flow is at: its status, or the diff to confirm. */
type Flow =
  | { at: "status"; error?: string; done?: { install: boolean; backup: string }; note?: string }
  | { at: "confirm"; install: boolean; preview: HookPreview; error?: string; busy?: boolean; action?: ReplyFormatAction };

const flows: Record<Change, Flow> = { hooks: { at: "status" }, usage: { at: "status" }, reply: { at: "status" }, cursor: { at: "status" }, codex: { at: "status" } };
/** Whether each part's Details are open: kept across its repaints. */
const detailsOpen: Record<Change, boolean> = { hooks: false, usage: false, reply: false, cursor: false, codex: false };

/** Codex runs a new hook only once it is trusted: said after connecting, and in the details. */
const CODEX_TRUST = "Codex runs new hooks only once you trust them: start Codex and review them once with /hooks.";

/** What the preview panel says of each change, before and after it is written. */
const CHANGE_WORDS: Record<Change, { install: string; remove: string; done: string }> = {
  hooks: {
    install: "This is exactly what Nook will change in Claude Code's settings file. Your own hooks and settings stay as they are.",
    remove: "This removes Nook's entries only. Your own hooks and settings stay as they are.",
    done: "Open a new Claude Code session for the change to take effect.",
  },
  usage: {
    install: "This is exactly what will change in Claude Code's settings file: its status line (the statusLine key), and nothing else. A status line you already have keeps working: Nook runs it for you — it is the long word after --previous — and turning this off puts it back as it was.",
    remove: "This takes Nook out of the status line only. The status line you had before comes back exactly as it was; with none, the key is removed.",
    done: "Claude Code picks the change up when it reloads its settings; a new session always does.",
  },
  reply: {
    install: "This is exactly what will change in your CLAUDE.md, Claude Code's instructions file: the block between Nook's two marker lines, and nothing outside them.",
    remove: "This removes Nook's two marker lines, what is between them, and the blank line Nook added before them. Everything else in your CLAUDE.md stays as it is.",
    done: "New sessions use it.",
  },
  cursor: {
    install: "This is exactly what will change in Cursor's hooks.json: Nook's entries, and nothing else. Your own hooks and any other key stay as they are.",
    remove: "This removes Nook's entries only. Your own hooks stay as they are.",
    done: "Cursor reloads hooks.json when it is saved. If its sessions do not show up, restart Cursor.",
  },
  codex: {
    install: "This is exactly what will change in Codex's hooks.json: Nook's entries, and nothing else. Your own hooks and any other key stay as they are.",
    remove: "This removes Nook's entries only. Your own hooks stay as they are.",
    done: CODEX_TRUST,
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
  /** One plain sentence: always on show. */
  text: string;
  /** How it works, the files, what to know before saying yes: under Details, folded until asked for. */
  details?: string[];
  facts: [string, string][];
  /** The one filled button, if the state calls for one. `blocked`: why it cannot be pressed. */
  primary?: { label: string; act: "install" | "restart"; blocked?: string };
  /** Lines of the user's own file, shown as they are and never changed. */
  found?: string[];
  /** A quiet way to write the entries again. */
  again?: string;
  remove?: string;
}

const RELAY_MISSING = "Restart Nook first: a part of it is missing.";
const UNREACHABLE: Omit<Spec, "name"> = {
  tone: "off", title: "Not available",
  text: "Nook did not answer, so there is nothing to show here. Close this window and open it again from the island or the tray.",
  facts: [],
};

function hooksSpec(): Spec {
  const s = hooks;
  const name = "Connect Claude Code to Nook";
  if (!s) return { name, ...UNREACHABLE };
  const file: [string, string] = ["settings.json", s.settingsPath];
  const relay: [string, string] = ["Relay", s.hookPath];
  const relayName = s.hookPath.split(/[\\/]/).pop() || "The relay";
  const how = "Nook adds a few hooks to Claude Code's settings file (settings.json): each runs Nook's small relay program, which passes what a session does to Nook. Your own hooks are left as they are.";
  if (!s.hookReady) {
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook: installing is not on offer.
    return {
      name, tone: "error", title: "Needs a restart",
      text: s.installed
        ? "A part of Nook that Claude Code talks to is missing, so your sessions can't reach Nook. Restarting Nook puts it back."
        : "A part of Nook that Claude Code talks to is missing, so connecting now would not work. Restarting Nook puts it back.",
      details: [
        `${relayName} is not where ${s.installed ? "the hooks point" : "the hooks would point"}.`,
        "Still missing after a restart? Installing Nook again puts it back; from the source, cargo build -p nook-hook builds it.",
      ],
      facts: [file, relay],
      primary: { label: "Restart Nook", act: "restart" },
      remove: s.installed ? "Disconnect…" : s.legacy ? "Remove the old connection…" : undefined,
    };
  }
  if (s.legacy) {
    return {
      name, tone: "warn", title: "Needs an update",
      text: s.installed
        ? "Nook is connected, but parts of an older version are still there. Updating takes them out."
        : "An older version of Nook's connection is still there. Nook can't hear your sessions until it is updated.",
      details: [how, "Hooks from an older version were found beside Nook's: updating replaces them."],
      facts: [file, relay],
      primary: { label: "Update…", act: "install" },
      remove: s.installed ? "Disconnect…" : "Remove them…",
    };
  }
  if (s.installed) {
    return {
      name, tone: "ok", title: "Connected",
      text: "Your Claude Code sessions show up in the island, and you can answer their questions and permission requests there.",
      details: [how],
      facts: [file, relay], again: "Connect again…", remove: "Disconnect…",
    };
  }
  return {
    name, tone: "off", title: "Not connected",
    text: "Connect to see your Claude Code sessions in the island, and to answer their permission requests without switching windows.",
    details: [how],
    facts: [file], primary: { label: "Connect…", act: "install" },
  };
}

function usageSpec(): Spec {
  const u = usage;
  const name = "Usage limits";
  if (!u) return { name, ...UNREACHABLE };
  const how = "Reads the usage numbers Claude Code already passes to its status line (the statusLine key of settings.json). Nothing leaves this computer. Numbers appear on subscription plans, and update only while a session runs.";
  const hints = "Claude Code hides its keyboard hints (\"? for shortcuts\") while any status line is set.";
  if (u.installed) {
    return {
      name, tone: "ok",
      title: u.chained ? "On, next to your own status line" : "On",
      text: "The island can show how much of your 5-hour and weekly Claude limits you have used.",
      details: [
        how,
        u.chained
          ? "Claude Code hands the numbers to Nook, which then runs the status line you already had, so it keeps showing. Turning this off puts it back exactly as it was."
          : `Nook prints no status line of its own. ${hints}`,
      ],
      facts: [["Key", "statusLine"]],
      remove: "Turn off…",
    };
  }
  return {
    name, tone: "off", title: "Off",
    text: "Show how much of your 5-hour and weekly Claude limits you have used, right in the island.",
    details: [
      how,
      u.otherStatusLine
        ? "You have a status line: Nook runs it after reading the numbers, so it keeps showing, and turning this off puts it back exactly."
        : `You have no status line: Nook prints none. ${hints}`,
    ],
    facts: [],
    // The same relay as the hooks': a status line pointing at one that isn't there shows nothing.
    primary: { label: "Turn on…", act: "install", blocked: hooks && !hooks.hookReady ? RELAY_MISSING : undefined },
  };
}

const CURSOR_DOES = "Shows your Cursor agent sessions in the island too. Nook can only show them: it can't answer anything in Cursor.";
const CURSOR_HOW = "Nook adds its entries to Cursor's hooks.json, for events that can only report what Cursor does and never change it.";

function cursorSpec(): Spec {
  const c = cursor;
  const name = "Cursor";
  if (!c) return { name, ...UNREACHABLE };
  const file: [string, string] = ["hooks.json", c.hooksPath];
  const relay: [string, string] = ["Relay", c.hookPath];
  if (c.unreadable) return { name, tone: "error", title: "Can't be changed", text: "Nook can't safely change Cursor's settings file.", details: [c.unreadable], facts: [file] };
  if (c.refused) return { name, tone: "error", title: "Can't be changed", text: "Nook can't safely change Cursor's settings file.", details: [c.refused], facts: [file, relay] };
  if (!c.hookReady) {
    return {
      name, tone: "error", title: "Needs a restart",
      text: "A part of Nook that Cursor talks to is missing, so connecting now would not work. Restarting Nook puts it back.",
      details: ["The relay is not in place yet, and hooks written now would point at nothing."],
      facts: [file, relay], primary: { label: "Restart Nook", act: "restart" }, remove: c.installed ? "Disconnect…" : undefined,
    };
  }
  if (c.installed && !c.current) {
    return {
      name, tone: "warn", title: "Needs an update",
      text: "Nook's connection to Cursor points at an old place. Updating fixes it.",
      details: ["Nook's entries in hooks.json point at a relay that has moved. Updating rewrites them, and nothing else."],
      facts: [file, relay], primary: { label: "Update…", act: "install" }, remove: "Disconnect…",
    };
  }
  if (c.installed) {
    return {
      name, tone: "ok", title: "Connected", text: CURSOR_DOES,
      details: [CURSOR_HOW, "Cursor reloads hooks.json when it is saved; if a session does not show up, restart Cursor."],
      facts: [file, relay], again: "Connect again…", remove: "Disconnect…",
    };
  }
  return {
    name, tone: "off", title: "Not connected", text: CURSOR_DOES,
    details: [
      CURSOR_HOW,
      c.cursorFound
        ? c.fileExists ? "Your hooks.json is kept: Nook adds its own entries beside yours." : "You have no hooks.json yet: the file is created."
        : "There is no .cursor folder here, so Cursor may not be installed. Nook can still create hooks.json, and it works once Cursor is.",
      "After connecting, restart Cursor if its sessions do not show up.",
    ],
    facts: [file], primary: { label: "Connect…", act: "install" },
  };
}

const CODEX_DOES = "Shows your Codex sessions in the island too, and lets you allow or deny what Codex asks permission for.";
const CODEX_HOW = "Nook adds its entries to Codex's hooks.json. A permission request waits for your click in the island; with none, Codex asks in its own window as it always does.";

function codexSpec(): Spec {
  const c = codex;
  const name = "Codex";
  if (!c) return { name, ...UNREACHABLE };
  const file: [string, string] = ["hooks.json", c.hooksPath];
  const relay: [string, string] = ["Relay", c.hookPath];
  if (c.unreadable) return { name, tone: "error", title: "Can't be changed", text: "Nook can't safely change Codex's hooks file.", details: [c.unreadable], facts: [file] };
  if (c.refused) return { name, tone: "error", title: "Can't be changed", text: "Nook can't safely change Codex's hooks file.", details: [c.refused], facts: [file, relay] };
  if (!c.hookReady) {
    return {
      name, tone: "error", title: "Needs a restart",
      text: "A part of Nook that Codex talks to is missing, so connecting now would not work. Restarting Nook puts it back.",
      details: ["The relay is not in place yet, and hooks written now would point at nothing."],
      facts: [file, relay], primary: { label: "Restart Nook", act: "restart" }, remove: c.installed ? "Disconnect…" : undefined,
    };
  }
  if (c.installed && !c.current) {
    return {
      name, tone: "warn", title: "Needs an update",
      text: "Nook's connection to Codex points at an old place. Updating fixes it.",
      details: ["Nook's entries in hooks.json point at a relay that has moved. Updating rewrites them, and nothing else.", CODEX_TRUST],
      facts: [file, relay], primary: { label: "Update…", act: "install" }, remove: "Disconnect…",
    };
  }
  if (c.installed) {
    return {
      name, tone: "ok", title: "Connected", text: CODEX_DOES,
      details: [CODEX_HOW, CODEX_TRUST],
      facts: [file, relay], again: "Connect again…", remove: "Disconnect…",
    };
  }
  return {
    name, tone: "off", title: "Not connected", text: CODEX_DOES,
    details: [
      CODEX_HOW,
      c.codexFound
        ? c.fileExists ? "Your hooks.json is kept: Nook adds its own entries beside yours." : "You have no hooks.json yet: the file is created."
        : "There is no .codex folder here, so Codex may not be installed. Nook can still create hooks.json, and it works once Codex is.",
      CODEX_TRUST,
    ],
    facts: [file], primary: { label: "Connect…", act: "install" },
  };
}

/** The reply format's one sentence, said the same whatever its state. */
const REPLY_DOES = "Asks Claude Code to lay out its answers the same way each time — a summary first, then what it needs you to decide, its warnings and its tips — so Nook can point them out.";
const REPLY_HOW = "Nook adds a short block, between two marker lines, to your CLAUDE.md (the instructions Claude Code reads in every session). Nothing outside the block is touched. Applies to new sessions.";

function replySpec(): Spec {
  const r = reply;
  const name = "Reply layout";
  if (!r) return { name, ...UNREACHABLE };
  const file: [string, string] = ["CLAUDE.md", r.path];
  switch (r.state) {
    case "installed":
      return { name, tone: "ok", title: "On", text: REPLY_DOES, details: [REPLY_HOW], facts: [file], remove: "Turn off…" };
    case "outdated":
      return {
        name, tone: "warn", title: "Needs an update",
        text: "Nook's instructions for Claude Code have changed since you turned this on. Updating brings them up to date.",
        details: [REPLY_DOES, "Updating replaces what is between the two marker lines in your CLAUDE.md, and nothing else. Applies to new sessions."],
        facts: [file],
        primary: { label: "Update…", act: "install" }, remove: "Turn off…",
      };
    case "unmarked":
      return {
        name, tone: "warn", title: "You have your own",
        text: "Your Claude Code instructions already ask for a reply layout of their own, so Nook leaves them alone.",
        found: r.found,
        details: [
          "Your CLAUDE.md has a reply format without Nook's markers: these are the lines Nook found. It won't add a second one, and won't change yours.",
          "To let Nook manage it, remove those lines yourself and come back: turning it on is then on offer.",
        ],
        facts: [file],
      };
    case "error":
      return { name, tone: "error", title: "Can't be changed", text: "Nook can't safely change your Claude Code instructions file.", details: [r.error ?? "CLAUDE.md can't be read."], facts: [file] };
    default:
      return {
        name, tone: "off", title: "Off", text: REPLY_DOES,
        details: [REPLY_HOW, r.exists ? "The block is added at the end of the file, after one blank line." : "You have no CLAUDE.md yet: the file is created, with the block and nothing else."],
        facts: [file], primary: { label: "Turn on…", act: "install" },
      };
  }
}

const SPECS: Record<Change, () => Spec> = { hooks: hooksSpec, usage: usageSpec, reply: replySpec, cursor: cursorSpec, codex: codexSpec };
/** Each part's block, repainted in place. */
const painters: Partial<Record<Change, (opening?: boolean, focus?: "primary" | "panel") => void>> = {};
const paintClaude = () => {
  for (const kind of CHANGES) painters[kind]?.();
};

async function readClaude() {
  const [h2, u, r, c, x] = await Promise.all([nook.hooksStatus(), nook.usageStatus(), nook.replyFormatStatus(), nook.cursorStatus(), nook.codexStatus()]);
  hooks = h2;
  usage = u;
  reply = r;
  cursor = c;
  codex = x;
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
          : kind === "codex" ? await nook.codexPreview(install)
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
          : kind === "codex"
            ? await nook.codexApply(flow.install, flow.preview.fingerprint)
            : await nook.hooksApply(flow.install, flow.preview.fingerprint);
    if (kind === "reply") wasCreated = reply?.exists === false;
    if (kind === "cursor") wasCreated = cursor?.fileExists === false;
    if (kind === "codex") wasCreated = codex?.fileExists === false;
    flows[kind] = { at: "status", done: { install: flow.install, backup } };
    await readClaude();
    paintClaude();
    say(flow.install ? "Done." : "Removed.");
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
  const created = (kind === "reply" && reply?.exists === false) || (kind === "cursor" && cursor?.fileExists === false) || (kind === "codex" && codex?.fileExists === false);
  const lines = flow.preview.diff.split("\n");
  const added = lines.filter((l) => l.startsWith("+")).length;
  const removed = lines.filter((l) => l.startsWith("-")).length;
  const box = h("div", { class: "sp-diff", tabindex: "0", role: "region", "aria-label": `Changes to ${fileName}` });
  for (const line of lines) {
    const sign = line[0] === "+" || line[0] === "-" ? line[0] : " ";
    // Rust writes "+ ", "- " or two spaces before each line.
    box.append(h("div", { class: sign === "+" ? "add" : sign === "-" ? "del" : "", "data-sign": sign, text: line.slice(line[1] === " " ? 2 : 1) }));
  }
  const confirm = button(created ? "Create the file" : flow.install ? "Save a backup and apply" : "Save a backup and remove", flow.install ? "primary" : "danger solid", () => void writeChange(kind));
  const cancel = button("Cancel", "quiet", close);
  confirm.disabled = cancel.disabled = Boolean(flow.busy);
  const panel = h("div", { class: "sp-panel" },
    h("div", { class: "sp-panel-head" },
      h("span", { text: `Changes to ${fileName}` }),
      h("span", { class: "counts" },
        h("span", { class: "plus", text: `+${added}` }), h("span", { class: "minus", text: `−${removed}` }))),
    h("p", { class: "sp-help", text: `${flow.install ? words.install : words.remove} Nothing is changed until you click below.` }),
    box,
    added + removed === 0 ? h("p", { class: "sp-help", text: `Nothing would change: ${fileName} already says this.` }) : null,
    created
      ? h("p", { class: "sp-help", text: "There is no file to back up: it is created." })
      : h("p", { class: "sp-help" }, "A dated backup is saved first: ", h("code", {}, ...breakable(flow.preview.backup))),
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

/**
 * Something Nook writes for Claude Code or Cursor: where it stands in a plain
 * sentence, its one action, the technical side folded under Details, and the
 * diff that action would write.
 */
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

    if (flow.at === "status" && flow.done) {
      // A file Nook created had no previous one to save.
      const saved = (kind === "reply" || kind === "cursor" || kind === "codex") && wasCreated ? [] : ["Your previous file is saved as ", ...breakable(flow.done.backup), ". "];
      block.append(h("div", { class: "sp-flash", role: "status" }, icon(LUCIDE.check, 15, 2.4),
        h("span", {}, flow.done.install ? "Done. " : "Removed. ", ...saved, CHANGE_WORDS[kind].done)));
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

    // The technical side: how it works, the files, the user's own lines. Folded until asked for.
    if (spec.found?.length || spec.details?.length || spec.facts.length) {
      const id = `details-${kind}`;
      const body = h("div", { class: "sp-details", id });
      if (spec.found?.length) {
        // Somebody's own lines: shown as they are, and nothing here acts on them.
        body.append(h("div", { class: "sp-diff sp-found", tabindex: "0", role: "region", "aria-label": `Lines found in ${CHANGED_FILE[kind]}` },
          ...spec.found.map((line) => h("div", { "data-sign": " ", text: line || " " }))));
      }
      for (const text of spec.details ?? []) body.append(h("p", { text }));
      if (spec.facts.length) {
        const facts = h("dl", { class: "sp-facts" });
        for (const [k, v] of spec.facts) facts.append(h("dt", { text: k }), h("dd", {}, ...breakable(v)));
        body.append(facts);
      }
      const fold = h("div", { class: `sp-fold${detailsOpen[kind] ? " open" : ""}` }, h("div", {}, body));
      const more = h("button", { class: "sp-more", type: "button", "aria-expanded": String(detailsOpen[kind]), "aria-controls": id },
        h("span", { text: "Details" }), icon(LUCIDE.chevronDown, 14, 2.2));
      more.addEventListener("click", () => {
        detailsOpen[kind] = !detailsOpen[kind];
        fold.classList.toggle("open", detailsOpen[kind]);
        more.setAttribute("aria-expanded", String(detailsOpen[kind]));
      });
      block.append(h("div", { class: "sp-more-wrap" }, more, fold));
    }

    const fold = h("div", { class: "sp-fold sp-diff-fold" });
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

/** A part of Connect, as a search finds it: by what it does, whatever state it is in. */
const connectGroup = (kind: Change, label: string, what: string, keys: string, ...more: Kid[]) =>
  findable(bare(label, integration(kind), ...more), label, what, keys, true);

/** A tool's own part of Connect: its mark, its name, what Nook does with it, and under them everything Nook writes for it. */
const toolPart = (key: SessionAgent, what: string, ...kids: Kid[]) =>
  h("section", { class: `sp-tool ${key}`, "aria-label": TOOL_NAME[key] },
    h("header", { class: "sp-tool-head" },
      h("span", { class: "sp-tool-mark", "aria-hidden": "true" },
        key === "cursor" ? brand(BRANDS.cursor, 18) : icon(key === "codex" ? CODEX_MARK : CLAUDE_MARK, 18, 2.4)),
      h("div", { class: "sp-tool-text" },
        h("h2", { class: "sp-tool-name", text: TOOL_NAME[key] }),
        h("p", { class: "sp-tool-what", text: what }))),
    ...kids);

function connectSection(): Kid[] {
  return [
    head("connect"),
    toolPart("claude", "Your sessions and what they ask, your usage limits, and how replies are laid out.",
      connectGroup("hooks", "Sessions and approvals", "Connect Claude Code to Nook: see your sessions in the island and answer them there.",
        "hooks hook claude code connect connection install setup set up link sessions permissions approve relay settings.json uninstall disconnect"),
      connectGroup("usage", "Usage limits", "Show how much of your 5-hour and weekly Claude limits you have used.",
        "usage limits limit quota plan subscription status line statusline weekly 5-hour five hour"),
      connectGroup("reply", "Reply layout", REPLY_DOES,
        "reply replies format answers layout claude.md instructions summary decisions warnings tips markdown")),
    cursorGroup(),
    codexGroup(),
  ];
}

/** Codex beside Claude Code: its hooks (sessions and permission requests), and whether its sessions are shown. */
function codexGroup(): HTMLElement {
  const show = toggle(settings.showCodexSessions, "Show Codex sessions", (on) => change({ showCodexSessions: on }));
  followers.push(() => show.set(settings.showCodexSessions));
  return toolPart("codex", "Its sessions, and Allow or Deny for what it asks permission for.",
    connectGroup("codex", "Sessions and approvals", CODEX_DOES, "codex openai cli hooks.json agent sessions permissions approve allow deny connect"),
    group(null,
      row("Show Codex sessions", "Codex's sessions appear in the island with a Codex mark. Off, they are not followed at all, and Codex asks for permission in its own window.", show.el,
        "codex show hide sessions openai")));
}

/** Cursor beside Claude Code: its hooks (status only), and whether its sessions are shown. */
function cursorGroup(): HTMLElement {
  const show = toggle(settings.showCursorSessions, "Show Cursor sessions", (on) => change({ showCursorSessions: on }));
  followers.push(() => show.set(settings.showCursorSessions));
  return toolPart("cursor", "Its agent sessions, to watch only: Nook answers nothing in Cursor.",
    connectGroup("cursor", "Sessions", CURSOR_DOES, "cursor editor ide hooks.json agent sessions connect"),
    group(null,
      row("Show Cursor sessions", "Cursor's sessions appear in the island with a Cursor mark. Off, they are not followed at all.", show.el,
        "cursor show hide sessions editor")));
}

/** settings.json may have changed while the window was away: its state is read again, never written. */
async function refreshClaude() {
  const onShow = () => section === "connect" || query !== "";
  if (!onShow() || CHANGES.some((kind) => flows[kind].at === "confirm")) return;
  const before = JSON.stringify([hooks, usage, reply, cursor, codex]);
  await readClaude();
  if (JSON.stringify([hooks, usage, reply, cursor, codex]) !== before && onShow()) paintClaude();
}

// ── Shortcuts ─────────────────────────────────────────────────────────────────

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

/** Where the settings keep each shortcut: its keys, and whether it is on. */
const SHORTCUT_FIELDS = {
  expand: ["expandShortcut", "expandShortcutEnabled"],
  goto: ["gotoShortcut", "gotoShortcutEnabled"],
  panel: ["panelShortcut", "panelShortcutEnabled"],
  hide: ["hideShortcut", "hideShortcutEnabled"],
  agents: ["agentsShortcut", "agentsShortcutEnabled"],
} as const satisfies Record<ShortcutName, readonly [keyof Settings, keyof Settings]>;

/** The five global shortcuts: what each is called, what it does, and the words a search finds it by. */
const SHORTCUTS: readonly { which: ShortcutName; label: string; does: string; keys: string }[] = [
  { which: "expand", label: "Open the island large, or shrink it", does: "Opens the session panel at full size, or shrinks it back.", keys: "expand large big full size shrink panel" },
  { which: "panel", label: "Open the session panel", does: "Opens the panel at its normal size. Press Space to make it large.", keys: "open panel sessions list" },
  { which: "goto", label: "Jump to the session that needs you", does: "Brings forward the window of the session that is asking for something, or has stopped on an error.", keys: "go to jump switch window focus needs you asking error" },
  { which: "hide", label: "Hide or show the island", does: "Hides the island completely, or brings it back. It still shows itself for a request, and hides again once all are answered.", keys: "hide show island invisible away" },
  { which: "agents", label: "Show or hide the agents list", does: "Works only while the agents list is turned on.", keys: "agents list window projects" },
];

/** What a reset does to each shortcut row: Rust's own path, as a change made by hand. */
const shortcutResets = new Map<ShortcutName, () => Promise<void>>();
/** Each row's key field: where "Set a keyboard shortcut for it" takes the keyboard. */
const shortcutFields = new Map<ShortcutName, HTMLElement>();

/** A shortcut as the settings have it. */
const savedShortcut = (which: ShortcutName): ShortcutStatus => {
  const [key, on] = SHORTCUT_FIELDS[which];
  return { accelerator: settings[key], enabled: settings[on], registered: false, error: null };
};

/**
 * A global shortcut: a field that records the combination pressed in it, a
 * switch, and under them where it stands. Rust has the last word: it registers
 * the combination before it saves it, and one it refuses — not a combination,
 * reserved, another Nook shortcut's, or held by another program — leaves the one
 * that worked in place.
 */
function shortcutRow({ which, label, does, keys }: (typeof SHORTCUTS)[number]): HTMLElement {
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
    // The agents shortcut is kept but not taken while the list is off.
    const dormant = which === "agents" && !settings.showAgentsList;
    const problem = refused?.why ?? (status.enabled && !dormant ? status.error : null);
    const state = recording ? "recording" : problem ? "error" : !status.enabled || dormant ? "off" : known && status.registered ? "ok" : "unknown";
    el.dataset.state = state;
    clear(field);
    const shown = recording ? partial.map(keyWord) : refused ? refused.keys : shortcutKeys(status.accelerator);
    for (const key of shown) field.append(h("kbd", { text: key }));
    if (recording) field.append(h("span", { class: "wait", text: partial.length ? "+ a key…" : "Press the new keys…" }));
    else field.append(h("span", { class: "hint", text: "Click to change" }));
    field.setAttribute("aria-label", recording ? `${label}: recording` : `${label}: ${shortcutKeys(status.accelerator).join(" + ")}. Change`);
    power.set(status.enabled);
    const using = shortcutKeys(status.accelerator).join(" + ");
    clear(line);
    line.append(h("i"), h("span", { text:
      state === "recording" ? "Recording. Esc cancels."
      : refused ? (status.enabled && status.registered ? `${refused.why}. Still using ${using}.` : `${refused.why}.`)
      : state === "error" ? `${problem}.`
      : state === "off" ? (dormant && status.enabled ? "Waiting for the agents list to be turned on." : "Off. No shortcut is registered.")
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
      const [key, on] = SHORTCUT_FIELDS[which];
      settings = { ...settings, [key]: status.accelerator, [on]: status.enabled };
    } catch (err) {
      refused = { why: reason(err).replace(/\.$/, ""), keys };
    }
    paint();
    paintResets();
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
  shortcutFields.set(which, field);
  shortcutResets.set(which, async () => {
    const [key, on] = SHORTCUT_FIELDS[which];
    const accelerator = DEFAULT_SETTINGS[key];
    const enabled = DEFAULT_SETTINGS[on];
    if (status.accelerator === accelerator && status.enabled === enabled && !refused) return;
    await set(accelerator, enabled, shortcutKeys(accelerator));
  });
  // The list turned on or off takes this shortcut from the OS, or gives it back: Rust has saved by the time it echoes, and says where it stands.
  if (which === "agents") {
    followers.push(() => {
      paint();
      void nook.shortcutStatus().then((fresh) => {
        if (!fresh) return;
        shortcutsNow = fresh;
        if (recording || refused) return;
        status = fresh[which];
        paint();
      });
    });
  }

  // What Rust has: a saved shortcut that could not be registered at launch says so here.
  void nook.shortcutStatus().then((fresh) => {
    if (!fresh) return;
    shortcutsNow = fresh;
    if (recording || refused) return;
    status = fresh[which];
    known = true;
    paint();
  });
  return findable(el, label, does, `shortcut shortcuts hotkey hot key keyboard keys key combination ${keys}`);
}

function shortcutsSection(): Kid[] {
  const of = (...names: ShortcutName[]) => SHORTCUTS.filter((s) => names.includes(s.which)).map(shortcutRow);
  return [
    head("shortcuts"),
    group("The island", ...of("expand", "panel", "goto", "hide")),
    group("Agents list", ...of("agents")),
    resetFoot("shortcuts"),
  ];
}

// ── Sounds ────────────────────────────────────────────────────────────────────

/** The sound's volume as the island has it — 0 to 0.2 — and as the slider shows it: 0 to 100 %. */
const VOLUME_MAX = 0.2;
const volumePercent = () => Math.round((Math.max(0, Math.min(VOLUME_MAX, settings.soundVolume)) / VOLUME_MAX) * 100);

function soundsSection(): Kid[] {
  const volumeNeeds = needs();
  const volume = slider("Volume", volumePercent(), (v) => `${v}%`, (v) => change({ soundVolume: Number(((v / 100) * VOLUME_MAX).toFixed(4)) }, true));
  const paintVolume = () => {
    volume.setDisabled(!settings.soundEnabled);
    sayNeeds(volumeNeeds, settings.soundEnabled ? null : "Turn on sounds first.");
  };
  const sound = toggle(settings.soundEnabled, "Play sounds", (on) => {
    change({ soundEnabled: on });
    paintVolume();
  });
  paintVolume();
  // The island's own quick settings change the sound too.
  followers.push(() => {
    sound.set(settings.soundEnabled);
    volume.set(volumePercent());
    paintVolume();
  });
  return [
    head("sounds"),
    group("Sound",
      row("Play sounds", "A short sound when a session needs you or has finished.", sound.el,
        "sound sounds audio mute unmute noise beep chime alert notification quiet silent"),
      row("Volume", "How loud the sounds are.", volume.el, "volume loud quiet louder softer level audio sound", volumeNeeds)),
    resetFoot("sounds"),
  ];
}

// ── Agents list ───────────────────────────────────────────────────────────────

function agentsSection(): Kid[] {
  const fadeNeeds = needs();
  const opacityNeeds = needs();
  const agentsFade = toggle(settings.agentsListFade, "Fade when not in use", (on) => {
    change({ agentsListFade: on });
    paintAgentsFade();
  });
  const fadePercent = () => Math.max(FADE_MIN, Math.min(FADE_MAX, Math.round(settings.agentsListFadeOpacity) || 50));
  const agentsFadeTo = slider("How visible when faded", fadePercent(), (v) => `${v}%`, (v) => change({ agentsListFadeOpacity: v }, true), FADE_MIN, FADE_MAX);
  const agentsList = toggle(settings.showAgentsList, "Show the agents list", (on) => {
    change({ showAgentsList: on });
    paintAgentsFade();
  });
  // Both fade rows are for a list that is on; the opacity is for a fade that is on.
  const paintAgentsFade = () => {
    agentsFade.el.disabled = !settings.showAgentsList;
    agentsFadeTo.setDisabled(!settings.agentsListFade || !settings.showAgentsList);
    const off = settings.showAgentsList ? null : "Turn on the agents list first.";
    sayNeeds(fadeNeeds, off);
    sayNeeds(opacityNeeds, off ?? (settings.agentsListFade ? null : "Turn on fading first."));
  };
  paintAgentsFade();
  followers.push(() => {
    agentsList.set(settings.showAgentsList);
    agentsFade.set(settings.agentsListFade);
    agentsFadeTo.set(fadePercent());
    paintAgentsFade();
  });

  const toShortcut = h("button", { class: "sp-link", type: "button" },
    icon(LUCIDE.keyboard, 16), h("span", { class: "sp-link-text", text: "Set a keyboard shortcut for the list" }), icon(LUCIDE.arrowRight, 14));
  toShortcut.addEventListener("click", () => {
    goTo("shortcuts", shortcutFields.get("agents")?.closest<HTMLElement>(".sp-shortcut") ?? undefined);
    window.requestAnimationFrame(() => shortcutFields.get("agents")?.focus({ preventScroll: true }));
  });

  return [
    head("agents"),
    group("The list",
      row("Show the agents list",
        "Each project's state, how much of Claude's memory it has used, and its last message. Click a row to go to its window. It never takes the keyboard.",
        agentsList.el, "agents list window projects overlay sessions always on top floating"),
      row("Fade when not in use", "It dims a few seconds after your pointer leaves it, but never while something waits for you.", agentsFade.el,
        "fade dim idle transparent", fadeNeeds),
      row("How visible when faded", "How much of the list still shows while it is faded.", agentsFadeTo.el,
        "opacity transparency fade dim see-through visible", opacityNeeds)),
    group("Moving it",
      findable(h("div", { class: "sp-row" },
        rowText("Move and size it with the mouse",
          "Drag its header to move it. Drag its sides to change its width, and its bottom edge to set how tall it may grow. Double-click its header to put the size back.")),
      "Move and size it with the mouse", "Drag its header to move it, its edges to size it; double-click the header to reset.",
      "move drag resize size width height position place reset double-click"),
      findable(h("div", { class: "sp-row" }, toShortcut), "Set a keyboard shortcut for the list", null, "shortcut hotkey keyboard keys agents")),
    resetFoot("agents"),
  ];
}

// ── Island ────────────────────────────────────────────────────────────────────

const AUTO_CLOSE = ["3", "5", "10", "15", "30", "custom"] as const;
type AutoClose = (typeof AUTO_CLOSE)[number];
const autoClosePreset = (): AutoClose => {
  const preset = String(Math.round(settings.autoCloseInterval));
  return settings.autoCloseInterval === Math.round(settings.autoCloseInterval) && (AUTO_CLOSE as readonly string[]).includes(preset) ? (preset as AutoClose) : "custom";
};
/** "Custom" stays picked while its number happens to be one of the presets. */
let autoCloseCustom = false;

/** A row of the picker: one of the island's cells. */
type MetricRow = CompactMetric;
const METRIC_ROWS: readonly MetricRow[] = COMPACT_METRICS;
const metricName = (id: MetricRow) => COMPACT_CELLS[id].name;
const isMetric = (id: string): id is CompactMetric => (COMPACT_METRICS as readonly string[]).includes(id);

/** The compact island, live: at the top of the Island page and of Look and colours, whichever is on show. */
const folded = islandPreview(islandBot);
const paintPreview = (animate: boolean) => folded.update(compactMetrics(settings), animate && !still(), settings.dock);

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
    paintPreview(animate);
  };

  const refuse = (id: MetricRow | null) => {
    for (const r of rows.values()) r.el.classList.remove("refused");
    refusal.hidden = id == null;
    if (id == null) return;
    const text = `Three at most. Untick one to show ${metricName(id)}.`;
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
    if (id === "gpu") check.title = "Shows — on a computer that does not report its graphics use.";
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

/** "Hide the compact island after": the choices as the control names them, by their seconds ("0" is never). */
type HideAfter = `${(typeof FOLDED_AUTO_HIDE)[number]}`;
const HIDE_AFTER_WORDS: Record<HideAfter, string> = { 5: "5 s", 10: "10 s", 30: "30 s", 60: "1 min", 0: "Never" };
/**
 * What keeping the island on show costs, said as what it is: one measurement,
 * on one machine (the app at rest with the folded island up, across Nook and
 * its WebView2 processes, 3 October 2026) — not a promise for another.
 */
const ALWAYS_SHOWN_NOTE =
  "While the island is on show, Nook checks your computer's numbers every 2.5 seconds; hidden, it checks nothing. On the PC it was measured on, Nook at rest with the compact island showing took about 7.7 % of one processor core (0.5 % of that 16-core machine) and about 290 MB of memory, WebView2 included. Yours will differ.";

function islandSection(): Kid[] {
  // Where it sits.
  const screen = segmented<Settings["screen"]>("Show the island on", [["primary", "Main screen"], ["cursor", "Screen with the pointer"]], settings.screen, (v) => change({ screen: v }));
  const dock = segmented<Settings["dock"]>("Screen edge", [["top", "Top"], ["bottom", "Bottom"], ["left", "Left"], ["right", "Right"]], settings.dock, (v) => {
    change({ dock: v });
    paintPreview(false);
  });
  const autostart = toggle(settings.autostart, "Start Nook with your computer", (on) => change({ autostart: on }));

  // When it closes and hides.
  const clamp = (v: number) => Math.max(2, Math.min(120, Math.round(v) || 15));
  const custom = h("input", { type: "number", min: "2", max: "120", step: "1", value: String(clamp(settings.autoCloseInterval)), "aria-label": "Close after, in seconds" });
  custom.addEventListener("change", () => {
    const seconds = clamp(Number(custom.value));
    custom.value = String(seconds);
    change({ autoCloseInterval: seconds });
  });
  const picked = (): AutoClose => (autoCloseCustom ? "custom" : autoClosePreset());
  autoCloseCustom = autoClosePreset() === "custom";
  const customFold = h("div", { class: `sp-fold${picked() === "custom" ? " open" : ""}` },
    h("div", {}, h("label", { class: "sp-number" }, custom, h("span", { text: "seconds, from 2 to 120" }))));
  const autoClose = segmented<AutoClose>("Close the open island after", AUTO_CLOSE.map((v) => [v, v === "custom" ? "Other" : `${v} s`] as const), picked(), (v) => {
    autoCloseCustom = v === "custom";
    customFold.classList.toggle("open", autoCloseCustom);
    // Other starts from the time in use: nothing changes until another number is typed.
    if (autoCloseCustom) custom.value = String(clamp(settings.autoCloseInterval));
    else change({ autoCloseInterval: Number(v) });
  });

  const hideAfterOf = (): HideAfter => String(foldedAutoHide(settings)) as HideAfter;
  const neverFold = h("div", { class: `sp-fold${hideAfterOf() === "0" ? " open" : ""}` }, h("div", {}, h("p", { class: "sp-note", text: ALWAYS_SHOWN_NOTE })));
  const hideAfter = segmented<HideAfter>("Hide the compact island after", FOLDED_AUTO_HIDE.map((v) => [String(v) as HideAfter, HIDE_AFTER_WORDS[String(v) as HideAfter]] as const), hideAfterOf(), (v) => {
    neverFold.classList.toggle("open", v === "0");
    change({ foldedAutoHide: Number(v) });
  });
  const whenIdle = toggle(settings.hideOnlyWhenIdle, "Keep it showing while a session is busy", (on) => change({ hideOnlyWhenIdle: on }));
  const fullscreen = toggle(settings.hideInFullscreen, "Hide during full-screen apps", (on) => change({ hideInFullscreen: on }));

  // The island's own quick settings change the auto-close too.
  let seconds = settings.autoCloseInterval;
  followers.push(() => {
    if (settings.autoCloseInterval !== seconds) {
      seconds = settings.autoCloseInterval;
      autoCloseCustom = autoClosePreset() === "custom";
      if (document.activeElement !== custom) custom.value = String(clamp(seconds));
    }
    autoClose.set(picked());
    customFold.classList.toggle("open", picked() === "custom");
    screen.set(settings.screen);
    dock.set(settings.dock);
    autostart.set(settings.autostart);
    hideAfter.set(hideAfterOf());
    neverFold.classList.toggle("open", hideAfterOf() === "0");
    whenIdle.set(settings.hideOnlyWhenIdle);
    fullscreen.set(settings.hideInFullscreen);
    metricPicker.paint(false);
  });

  return [
    head("island"),
    group("Position",
      stackRow("Show the island on", "Which screen it appears on, when you have more than one.",
        "screen display monitor second screen multiple main primary pointer mouse", screen.el),
      stackRow("Screen edge", "The island sits along this edge of the screen, clear of the taskbar. On the left or right it stands upright.",
        "position edge top bottom left right side move place taskbar dock where", dock.el),
      row("Start Nook with your computer", "Nook opens by itself when you sign in.", autostart.el,
        "startup start up launch login log in sign in boot automatically autostart open")),
    group("When it shows and hides",
      stackRow("Close the open island after", "How long it stays open once your pointer has left it.",
        "close auto-close timer seconds stay open delay", autoClose.el, customFold),
      stackRow("Hide the compact island after", "How long the small, closed island stays once your pointer has left it. It comes back when you point at its edge, or when a session does something.",
        "hide auto-hide autohide compact folded small closed disappear timer never always visible", hideAfter.el, neverFold),
      row("Keep it showing while a session is busy", "The hide timer starts only once no session is working, thinking or asking.", whenIdle.el,
        "busy working active idle keep visible hide thinking"),
      row("Hide during full-screen apps", "Stays out of the way of videos, games and presentations. Questions and permission requests still show.", fullscreen.el,
        "full screen fullscreen video game presentation movie hide")),
    findable(bare(h("span", { class: "sp-label-row" }, "What the compact island shows", metricPicker.count),
      h("div", { class: "sp-box" },
        metricPicker.list,
        metricPicker.refusal,
        h("p", { class: "sp-note", text: "Pick up to three. Drag a chosen one by its handle to change the order. With none, the island is narrower. Numbers in the island preview are samples." }))),
    "What the compact island shows", "Pick up to three numbers to show beside Gullu.",
    "metrics numbers stats cpu processor gpu graphics ram memory usage limits weekly waiting sessions show", true),
    resetFoot("island"),
  ];
}

// ── Look and colours ──────────────────────────────────────────────────────────

/** Gullu's colours: the six the engine has. */
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
  const label = h("span", { class: "sp-swatch-name" });
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
  swatches.append(...buttons, label);
  paint();
  followers.push(paint);
  return stackRow("Gullu's colour", "Gullu is the little character in the island. Choose the colour of the island's character.",
    "colour color bot character gullu mascot paint theme", swatches);
}

function lookSection(): Kid[] {
  const themeHelp = h("p", { class: "sp-help" });
  const writeHelp = () => {
    // Asked of the system only while following it: a picked theme answers for itself.
    themeHelp.textContent = settings.theme === "system"
      ? `Follows your computer, which is set to ${systemDark.matches ? "dark" : "light"} right now. The island itself is always dark.`
      : "The island itself is always dark.";
  };
  const theme = segmented<Theme>("Colours of this window", [["light", "Light"], ["dark", "Dark"], ["system", "Match computer"]], settings.theme, (v) => {
    change({ theme: v });
    writeHelp();
  });
  const motion = segmented<Motion>("Reduce motion", [["system", "Match computer"], ["on", "On"], ["off", "Off"]], settings.reduceMotion, (v) => change({ reduceMotion: v }));
  const playful = toggle(settings.playfulReactions !== false, "Playful Gullu", (on) => change({ playfulReactions: on }));
  writeHelp();
  followers.push(() => {
    theme.set(settings.theme);
    motion.set(settings.reduceMotion);
    playful.set(settings.playfulReactions !== false);
    writeHelp();
  });
  return [
    head("look"),
    group("Gullu",
      botColours(),
      row("Playful Gullu", "Gullu follows your mouse and reacts to clicks. Off, Gullu only shows how your sessions are doing.", playful.el,
        "playful reactions animation mouse fun gullu character bot")),
    group("This window",
      findable(h("div", { class: "sp-row stack" },
        h("div", { class: "sp-row-text" }, h("div", { class: "sp-row-label", text: "Colours of this window" }), themeHelp),
        theme.el),
      "Colours of this window", "Light, dark, or as your computer is set.",
      "dark mode light mode theme colours colors night appearance window black white")),
    group("Motion",
      stackRow("Reduce motion", "Things in Nook change at once, without sliding or fading.",
        "animation animations motion reduce accessibility movement still effects calm", motion.el)),
    resetFoot("look"),
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
    count.textContent = `${shown} of ${ids.length} on`;
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
  followers.push(() => shelfPicker.paint(false));
  return [
    head("shelf"),
    h("div", { class: "sp-flash note sp-intro", role: "note" }, icon(LUCIDE.info, 15),
      h("span", { text: "The Shelf tab of the island shows these in this order, and you can drag its cards there too. A widget that is off never runs: no timer, no reminder, no camera, nothing is read." })),
    findable(bare(h("span", { class: "sp-label-row" }, "Widgets", shelfPicker.count),
      shelfPicker.tray,
      h("p", { class: "sp-note", text: "Drag a card to move it, or click it and use the arrow keys. Switch one off to leave it out." })),
    "Shelf widgets", "Which widgets the Shelf shows, and their order.",
    "shelf widgets widget media music player to-do todo tasks timer countdown reminders mirror camera projects folders order hide", true),
    resetFoot("shelf"),
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

/**
 * Updates: the one thing Nook uses the internet for, and only on the user's
 * say — the switch (a check a day) or the button (a check now). What a check
 * found is said here; the island says it too while the switch is on.
 */
function updatesGroup(): HTMLElement {
  const auto = toggle(settings.checkUpdates, "Check for updates every day", (on) => change({ checkUpdates: on }));
  followers.push(() => auto.set(settings.checkUpdates));
  const status = h("p", { class: "sp-help", role: "status" });
  const check = button("Check now", "quiet", () => void run());
  const get = button("Get it…", "primary", () => void nook.updateOpen());
  let found: UpdateInfo | null = null;
  let busy = false;
  let failed: string | null = null;

  const paint = () => {
    get.style.display = found?.available && !busy ? "" : "none";
    check.disabled = busy;
    check.textContent = busy ? "Checking…" : "Check now";
    status.classList.toggle("sp-danger-text", failed != null);
    status.textContent = failed
      ?? (busy ? "Asking GitHub…"
        : !found ? "Not checked yet."
          : found.available ? `Nook ${found.latest} is out. Get it opens its download page in your browser.`
            : `You have the latest version.${found.checkedAt ? ` Checked ${new Date(found.checkedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.` : ""}`);
  };
  async function run() {
    if (busy) return;
    busy = true;
    failed = null;
    paint();
    try {
      found = await nook.updateCheck();
    } catch (err) {
      failed = reason(err) || "The check could not be made.";
    }
    busy = false;
    paint();
  }
  void nook.updateLast().then((last) => {
    if (last && !busy) found = last;
    paint();
  });
  paint();

  return group("Updates",
    row("Check for updates every day",
      "Once a day, Nook asks GitHub whether a newer version is out, and tells you here and in the island. It sends nothing about you. Off, Nook never connects to the internet by itself.",
      auto.el, "update updates upgrade new version automatic auto check daily github release internet network"),
    findable(h("div", { class: "sp-row" },
      rowText(version ? `You have version ${version}` : "This version", null, status),
      h("div", { class: "sp-update-actions" }, get, check)),
    "Check now", "Ask GitHub now whether a newer version of Nook is out.", "update updates check now latest version download upgrade"));
}

function aboutSection(): Kid[] {
  const place = (label: string, help: string, path: string | undefined, keys: string) =>
    findable(h("div", { class: "sp-row" },
      rowText(label, help),
      h("span", { class: "sp-path" }, ...(path ? breakable(path) : ["—"]))), label, help, keys);
  const link = ({ which, name, where, mark }: (typeof LINKS)[number]) =>
    h("button", {
      class: "sp-social", type: "button", title: where,
      "aria-label": `${name}: ${where}. Opens in your browser.`, onclick: () => void nook.openLink(which),
    }, h("i", {}, mark()), h("span", { text: name }));
  return [
    head("about"),
    h("div", { class: "sp-about" },
      h("div", { class: "sp-nook", "aria-hidden": "true" }, aboutBot.el),
      h("div", {},
        h("p", { class: "sp-about-name", text: "Nook" }),
        h("p", { class: "sp-about-version", text: version ? `Version ${version}` : "" }),
        h("p", { class: "sp-about-version", text: "With Gullu, Nook's buddy" }))),
    updatesGroup(),
    findable(bare("Privacy",
      h("div", { class: "sp-box sp-privacy" },
        icon(LUCIDE.circleCheck, 18, 2),
        h("p", { text: "Nook sends nothing anywhere, and tracks nothing. It uses the internet for one thing only, and only if you ask: checking whether a newer version is out. Everything else stays on this computer." }))),
    "Privacy", "Nook sends nothing anywhere: everything stays on this computer.",
    "privacy private telemetry tracking data network internet offline online send", true),
    group("Where your things are kept",
      place("Settings", "Your choices in this window", paths?.settings, "files folder location data settings where stored path"),
      place("Logs", "Nook's log file, and the small helper program Claude Code runs", paths?.local, "logs log folder files helper relay location"),
      ...(paths?.relayError ? [h("p", { class: "sp-help sp-danger-text", text: `Not receiving Claude Code events: ${paths.relayError}` })] : []),
      findable(h("div", { class: "sp-row" },
        h("button", { class: "sp-link", type: "button", onclick: () => void nook.openLogFolder() },
          icon(LUCIDE.folderOpen, 16), h("span", { class: "sp-link-text", text: "Open the log folder" }), icon(LUCIDE.arrowUpRight, 14))),
      "Open the log folder", null, "logs log folder open explorer files")),
    findable(bare("Made by",
      h("div", { class: "sp-credit" },
        h("p", { class: "sp-made", text: "Zubair Bin Shaukat" }),
        h("div", { class: "sp-links", role: "group", "aria-label": "Zubair Bin Shaukat's links" }, ...LINKS.map(link))),
      h("p", { class: "sp-credits", text: "Open source, under the MIT licence." })),
    "Made by", "Zubair Bin Shaukat. Open source, under the MIT licence.",
    "author made by credits github linkedin website portfolio contact licence license open source", true),
  ];
}

// ── Putting a category on show ────────────────────────────────────────────────

const BUILD: Record<Section, () => Kid[]> = {
  connect: connectSection, island: islandSection, look: lookSection, sounds: soundsSection,
  agents: agentsSection, shortcuts: shortcutsSection, shelf: shelfSection, about: aboutSection,
};

/**
 * What a category does when it comes on show; what it returns, it does when
 * it goes. Connect reads the files again, and forgets an open diff when left —
 * as it always has. The island and Look carry the live preview between them.
 */
const ENTER: Partial<Record<Section, () => (() => void) | void>> = {
  connect: () => {
    void refreshClaude();
    return () => {
      // What was said of the last change, or an open diff, does not wait for the next visit.
      for (const kind of CHANGES) flows[kind] = { at: "status" };
      paintClaude();
    };
  },
  island: () => {
    metricPicker.refuse(null);
    metricPicker.paint(false);
    heads.get("island")!.after(folded.el);
    return folded.run();
  },
  look: () => {
    paintPreview(false);
    heads.get("look")!.after(folded.el);
    return folded.run();
  },
};

const panes = new Map<Section, HTMLElement>();
let shownPane: HTMLElement | null = null;
let leaving: (() => void) | null = null;
const leaveTimers = new Map<HTMLElement, number>();

function setSection(next: Section, animate = true) {
  if (query) clearSearch();
  const pane = panes.get(next);
  if (!pane || (next === section && shownPane === pane)) return;
  leaving?.();
  leaving = null;
  const old = shownPane;
  section = next;
  shownPane = pane;

  window.clearTimeout(leaveTimers.get(pane));
  pane.classList.remove("leaving");
  pane.inert = false;
  pane.hidden = false;
  pane.scrollTop = 0;
  leaving = ENTER[next]?.() ?? null;
  if (old && animate && !still()) {
    // The one leaving fades under the one arriving, then hides.
    old.classList.remove("entering");
    old.classList.add("leaving");
    old.inert = true;
    leaveTimers.set(old, window.setTimeout(() => {
      old.hidden = true;
      old.classList.remove("leaving");
      old.inert = false;
    }, 140));
    replay(pane, "entering");
  } else if (old) {
    old.hidden = true;
  }
  paintTabs();
  placeMark();
  refreshBots();
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
  applyAppearance();
  versionLine.textContent = version ? `Version ${version}` : "";

  // Every category, built once: the search finds a row in any of them.
  for (const id of SECTIONS) {
    building = id;
    const pane = h("div", { class: "sp-pane", id: `pane-${id}`, role: "tabpanel", "aria-labelledby": `tab-${id}`, hidden: true }, ...BUILD[id]());
    panes.set(id, pane);
    main.append(pane);
  }
  main.append(results);

  clear(root);
  app.append(
    h("nav", { class: "sp-side", "aria-label": "Settings" },
      h("div", { class: "sp-brand" },
        h("div", { class: "sp-nook", "aria-hidden": "true" }, sideBot.el),
        h("div", { class: "sp-brand-text" }, h("b", { text: "Nook" }), versionLine)),
      searchBox, searchOpen,
      nav,
      nook.fake ? h("div", { class: "sp-fake", text: "Fake data", title: "Nothing here is read from or written to this machine." }) : null),
    main);
  root.append(app, live);
  setSection(sectionNamed(nook.start) ?? "connect", false);
  paintResets();
  startBots(still);

  nook.onSettingsChanged(settingsChanged);
  systemDark.addEventListener("change", () => {
    applyAppearance();
    follow();
  });
  systemStill.addEventListener("change", applyAppearance);
  // The window lives hidden between two looks at it: what it shows of
  // settings.json is read again when it comes back.
  window.addEventListener("focus", () => void refreshClaude());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshClaude();
  });

  if (nook.fake) await fakeStates();
}

/**
 * The made-up window only: a state to start in, said in the address, so every
 * page can be looked at — and captured — as it is: `details=hooks` opens a
 * Connect part's Details, `diff=hooks` its diff, `reset=armed` arms the reset
 * of the category on show, `q=volume` searches. `window.__shotReady` says the
 * page is drawn (scripts/shot.mjs waits for it).
 */
async function fakeStates() {
  const q = new URLSearchParams(location.search);
  const kind = (name: string | null): Change | null => (CHANGES as readonly string[]).includes(name ?? "") ? (name as Change) : null;
  const open = kind(q.get("details"));
  if (open) {
    detailsOpen[open] = true;
    painters[open]?.();
  }
  const diff = kind(q.get("diff"));
  if (diff) await openPreview(diff, q.get("install") !== "0");
  if (q.get("reset") === "armed") resetArmers.get(section)?.();
  const text = q.get("q");
  if (text) {
    searchInput.value = text;
    app.classList.add("search-open");
    runSearch(text);
  }
  await document.fonts.ready;
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    (window as unknown as { __shotReady?: boolean }).__shotReady = true;
  }));
}

void start();
