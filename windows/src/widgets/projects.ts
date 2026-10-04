// Projects: the folders Claude Code sessions have run in, most recent first.
// Small: the two or three latest, each with a button to open it in VS Code.
// Expanded: all of them, and "New Claude session" in each, which opens Windows
// Terminal running `claude` there.
//
// The list is Rust's (src-tauri/src/projects.rs): a folder is added when a
// session's hook event names it, at most 30, and one that no longer exists is
// not shown. This page only draws it and names a folder to launch; Rust
// launches it only if it is on its own list, with the path as one argument and
// never through a shell. The list is asked for once when the Shelf comes on
// show, and again no more than every ten seconds while it stays.

import { clear, h } from "../views/dom";
import { ICONS } from "../views/icons";
import type { ProjectInfo } from "../core/bridge";
import { ShelfBackend } from "./backend";
import { notifyShelf } from "./core";
import { widgetOn } from "./defs";
import { frame, mini, setIcon, shared, type Widget, type WidgetContext } from "./ui";

/** How many of the most recent folders the small card shows. */
const SMALL_PROJECTS = 3;
/** The list is not asked for again sooner than this while the Shelf stays on show. */
const STALE_MS = 10_000;
/** What a button says, for a moment, after it was pressed. */
const SAID_MS = 1400;

const CODE = "M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5";

const state = {
  list: [] as ProjectInfo[],
  asked: 0,
  inflight: false,
  /** The last button pressed, what came of it, and when. */
  said: { path: "", kind: "" as "" | "code" | "claude", ok: true, at: 0 },
};

/** A session was seen running in this folder: Rust keeps it, if it could launch it. Said once per folder, as long as Nook runs. */
const noted = new Set<string>();
export function rememberProject(cwd: string) {
  if (!cwd || noted.has(cwd) || !widgetOn("projects")) return;
  noted.add(cwd);
  void ShelfBackend.projects.note(cwd).then(() => {
    // What is on show is asked for again at the next tick.
    state.asked = 0;
  });
}

async function refresh() {
  if (state.inflight || Date.now() - state.asked < STALE_MS) return;
  state.inflight = true;
  state.asked = Date.now();
  try {
    state.list = await ShelfBackend.projects.list();
  } finally {
    state.inflight = false;
  }
  notifyShelf();
}

async function launch(p: ProjectInfo, kind: "code" | "claude") {
  const ok = kind === "code" ? await ShelfBackend.projects.openInCode(p.path) : await ShelfBackend.projects.newSession(p.path);
  state.said = { path: p.path, kind, ok, at: Date.now() };
  notifyShelf();
  // The button is itself again a moment later.
  window.setTimeout(notifyShelf, SAID_MS + 50);
}

const saying = (p: ProjectInfo, kind: "code" | "claude") =>
  state.said.path === p.path && state.said.kind === kind && Date.now() - state.said.at < SAID_MS;

/** "just now", "5 min ago", "yesterday", "3 d ago". */
export function agoText(at: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  return days < 14 ? `${days} d ago` : `${Math.round(days / 7)} w ago`;
}

export function buildProjects(ctx: WidgetContext): Widget {
  /** A button that says what it did for a moment after it is pressed. */
  const launcher = (p: ProjectInfo, kind: "code" | "claude", label: string, title: string) => {
    const btn = h("button", { class: "chip-btn launch", title, onclick: () => void launch(p, kind) });
    const markEl = h("span", { class: "launch-icon" });
    const done = saying(p, kind);
    const ok = state.said.ok;
    btn.classList.toggle("done", done && ok);
    btn.classList.toggle("failed", done && !ok);
    setIcon(markEl, done ? (ok ? ICONS.check : ICONS.xmark) : kind === "code" ? CODE : ICONS.terminal, 11, done ? 3 : 2.2);
    const words = done && !ok ? (kind === "code" ? "No VS Code" : "No terminal") : label;
    btn.append(markEl, h("span", { text: words }));
    return btn;
  };

  // Small: the most recent folders, each with "open in VS Code".
  const sList = h("div", { class: "wmini-list" });
  const small = mini("projects", h("div", { class: "wbody-projects" }, sList));

  // Expanded: every folder, and a new Claude session in each.
  const note = h("div", { class: "fc-note", text: "Folders your Claude Code sessions have run in. Nothing is launched but the folder you press." });
  const list = h("div", { class: "gh-list fc-list", "aria-label": "Project folders" });
  const count = h("span", { class: "fc-aside" });
  const body = h("div", { class: "fc-col" }, list, note);

  let shown: string | null = null;
  function paint() {
    const items = state.list;
    count.textContent = `${items.length} folder${items.length === 1 ? "" : "s"}`;
    const key = items.map((p) => `${p.path}${p.at}${saying(p, "code") ? "c" : ""}${saying(p, "claude") ? "n" : ""}`).join("|")
      + (state.said.ok ? "" : "!");
    // The words ("5 min ago") grow old by themselves: the lines are drawn again when a minute has gone, as the rest changes.
    const minute = Math.floor(Date.now() / 60_000);
    const full = `${key}@${minute}`;
    if (full === shown) return;
    shown = full;

    clear(sList);
    items.slice(0, SMALL_PROJECTS).forEach((p, i) => {
      sList.append(h("div", { class: "wmini-proj" },
        shared(h("b", { text: p.name, title: p.path }), `proj-name-${i}`, "text"),
        shared(launcher(p, "code", "Code", `Open ${p.name} in VS Code`), `proj-code-${i}`, "text")));
    });
    if (items.length === 0) sList.append(h("div", { class: "wmini-none", text: state.asked ? "No folders yet" : "Looking…" }));

    clear(list);
    items.forEach((p, i) => {
      list.append(h("div", { class: "gh-row proj-row" },
        h("div", { class: "proj-who" },
          h("div", { class: "proj-name" },
            shared(h("b", { text: p.name }), `proj-name-${i}`, "text"),
            h("span", { class: "int-ago", text: agoText(p.at) })),
          h("div", { class: "gh-sub path", text: p.path, title: p.path })),
        shared(launcher(p, "code", "Open in VS Code", `Open ${p.name} in VS Code`), `proj-code-${i}`, "text"),
        launcher(p, "claude", "New Claude session", `New Claude Code session in ${p.name}`)));
    });
    if (items.length === 0) list.append(h("div", { class: "wmini-none", text: "No folders yet. They appear as Claude Code sessions run." }));
  }

  return {
    id: "projects",
    small,
    card: frame("projects", body, ctx.back, count),
    paint,
    // Once a second while the Shelf is on show; the list is asked for no more than every STALE_MS.
    tick: () => void refresh(),
  };
}
