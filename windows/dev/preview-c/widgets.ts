// Shelf preview — the six widgets, each in two sizes, on fake data.
//
// `small` is the card that stands on the shelf and works in place; `card` is
// the expanded view, the same thing with more. Both are built once and kept,
// and both are painted from model.ts by one `paint`: there is one state, shown
// twice. What was typed, ticked or started in either is in the other.
//
// An element that is the same thing in both sizes carries `data-vt`: the name
// it shares with its counterpart. When a card expands (or goes back) the page
// gives the two a common `view-transition-name`, and the browser moves the one
// into the other. `data-vtc="text"` asks for it to be moved without being
// stretched (see shelf.css).

import { h, svg, clear } from "../../src/views/dom";
import { ICONS } from "../../src/views/icons";
import {
  PROJECTS, PROJECTS_SMALL, TODO_SMALL, TRACKS, WIDGETS, addReminder, addTodo, clock, justLaunched,
  launch, media, mediaAdvance, mediaPosition, mediaSkip, mediaToggle, mediaVolume, newClaudeSession,
  nextReminder, openInCode, reminders, removeReminder, removeTodo, renameReminder, setTodoNotes, timer,
  timerLeft, timerReset, timerSet, timerToggle, todo, toggleReminder, toggleTodo, untilText,
  type WidgetDef, type WidgetId,
} from "./model";
import { camera, resetCamera, startCamera } from "./camera";

export interface Widget {
  def: WidgetDef;
  /** The small card on the shelf. */
  small: HTMLElement;
  /** The expanded view. */
  card: HTMLElement;
  /** Repaints both from the model. */
  paint(): void;
}

export interface WidgetContext {
  /** The back pill of an expanded view. */
  onBack(): void;
  /** Mirror's "Turn camera on": expand, and start the camera there. */
  onExpand(id: WidgetId, opts: { camera: boolean }): void;
}

/** What in a card is a control: a tap on one acts, and never expands the card. */
export const CONTROL = "button, input, textarea, select, a, label";

const PLAY = "M7 4.5v15l12-7.5z";
const PAUSE = "M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z";
const PREVIOUS = "M6 5h2.2v14H6zM19 5v14L9 12z";
const NEXT = "M15.8 5H18v14h-2.2zM5 5v14l10-7z";
const EXPAND = "M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7";
const CODE = "M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5";

export const icon = (def: WidgetDef, size: number) => svg(def.icon, size, { stroke: 1.9 });

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const mmss = (seconds: number) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Marks an element as one of a pair: the same thing in the small card and in the expanded view. */
function shared<T extends HTMLElement>(el: T, name: string, kind?: "text"): T {
  el.dataset.vt = name;
  if (kind) el.dataset.vtc = kind;
  return el;
}

function setIcon(button: HTMLElement, path: string, size: number, stroke?: number) {
  if (button.dataset.icon === path) return;
  button.dataset.icon = path;
  clear(button);
  button.append(svg(path, size, stroke ? { stroke } : {}));
}

/** The small card: the widget's mark and name, a corner to expand it, and its working body. */
function mini(def: WidgetDef, body: HTMLElement) {
  const card = h("div", { class: `wmini wmini-${def.id}` },
    h("div", { class: "wmini-head" },
      shared(h("span", { class: "w-mark" }, icon(def, 13)), "icon"),
      shared(h("b", { text: def.name }), "title", "text"),
      h("button", { class: "wmini-expand", title: `Expand ${def.name}`, "aria-label": `Expand ${def.name}`, "data-expand": "" },
        svg(EXPAND, 11, { stroke: 2.4 }))),
    body);
  body.classList.add("wmini-body");
  card.dataset.id = def.id;
  card.style.setProperty("--c", def.accent);
  return shared(card, "card");
}

/** The expanded view: a back pill, the widget's mark and name, its body. */
function frame(def: WidgetDef, body: HTMLElement, onBack: () => void, aside?: HTMLElement) {
  const head = h("div", { class: "fc-head" },
    h("button", { class: "back-pill", title: "Back to the Shelf (Esc, or swipe right)", onclick: onBack },
      svg(ICONS.chevronLeft, 11, { stroke: 2.6 }), "Shelf"),
    shared(h("span", { class: "w-mark fc-mark" }, icon(def, 13)), "icon"),
    shared(h("b", { text: def.name }), "title", "text"),
    aside ?? null,
  );
  const card = h("div", { class: `card wash focus-card fc-${def.id}` }, head, h("div", { class: "fc-body" }, body));
  card.dataset.id = def.id;
  card.style.setProperty("--c", def.accent);
  card.style.setProperty("--wash", `color-mix(in srgb, ${def.accent} 30%, transparent)`);
  return shared(card, "card");
}

/** A line with a box to tick: the box and the words are one button; `extra` stands beside it. */
function checkRow(o: {
  name: string; text: string; done: boolean; square: boolean; onToggle: () => void; extra?: (Node | null)[];
}) {
  const row = h("div", { class: `gh-row check-row${o.done ? " done" : ""}` },
    h("button", { class: "check-main", title: o.done ? "Mark as not done" : "Mark as done", onclick: o.onToggle },
      h("i", { class: `check${o.square ? " square" : ""}` }, o.done ? svg(ICONS.check, 9, { stroke: 3.4 }) : null),
      h("span", { class: "gh-row-title", text: o.text })),
    ...(o.extra ?? []));
  return shared(row, o.name, "text");
}

const removeButton = (what: string, onRemove: () => void) =>
  h("button", { class: "row-x", title: `Remove ${what}`, "aria-label": `Remove ${what}`, onclick: onRemove },
    svg(ICONS.xmark, 9));

/** A field that adds what was typed when Enter is pressed. */
function addField(placeholder: string, add: (text: string) => void, extra = "") {
  const field = h("input", { class: `island-field ${extra}`, type: "text", placeholder, maxlength: 60 });
  const commit = () => {
    const text = field.value.trim();
    if (!text) return;
    add(text);
    field.value = "";
  };
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
  });
  return { field, commit };
}

// ── Media ─────────────────────────────────────────────────────────────────────

function buildMedia(ctx: WidgetContext): Widget {
  const def = WIDGETS.media;

  const controls = (playSize: number, skipSize: number) => {
    const play = shared(h("button", { class: "media-play", title: "Play / pause", onclick: mediaToggle }), "media-play");
    const row = h("div", { class: "media-ctl" },
      shared(h("button", { class: "media-skip", title: "Previous", onclick: () => mediaSkip(-1) }, svg(PREVIOUS, skipSize)), "media-prev"),
      play,
      shared(h("button", { class: "media-skip", title: "Next", onclick: () => mediaSkip(1) }, svg(NEXT, skipSize)), "media-next"));
    return { row, play, playSize };
  };

  // Small: song, artist, previous / play / next.
  const sTitle = shared(h("div", { class: "media-title" }), "media-song", "text");
  const sArtist = shared(h("div", { class: "media-artist" }), "media-artist", "text");
  const sCtl = controls(14, 13);
  const small = mini(def, h("div", { class: "wbody-media" }, h("div", { class: "media-now" }, sTitle, sArtist), sCtl.row));

  // Expanded: the same, with the album art, the progress and the volume.
  const cover = h("div", { class: "media-cover" }, svg(def.icon, 34, { stroke: 1.6 }));
  const title = shared(h("div", { class: "media-title" }), "media-song", "text");
  const artist = shared(h("div", { class: "media-artist" }), "media-artist", "text");
  const fill = h("i");
  const times = h("div", { class: "media-times" }, h("span"), h("span"));
  const ctl = controls(18, 16);
  const volume = h("input", { class: "media-vol", type: "range", min: 0, max: 100, step: 1, title: "Volume", "aria-label": "Volume" });
  volume.addEventListener("input", () => mediaVolume(Number(volume.value)));
  const volumeIcon = h("span", { class: "media-vol-icon" });
  const state = h("span", { class: "fc-aside" });

  const body = h("div", { class: "media" },
    cover,
    h("div", { class: "media-side" },
      title, artist,
      h("div", { class: "media-bar" }, fill),
      times,
      h("div", { class: "media-foot" }, ctl.row, h("div", { class: "media-volume" }, volumeIcon, volume))));

  function paint() {
    mediaAdvance();
    const track = TRACKS[media.index];
    const pos = mediaPosition();
    for (const el of [sTitle, title]) el.textContent = track.title;
    for (const el of [sArtist, artist]) el.textContent = track.artist;
    for (const c of [sCtl, ctl]) setIcon(c.play, media.playing ? PAUSE : PLAY, c.playSize);
    cover.style.background = `linear-gradient(140deg, ${track.cover[0]}, ${track.cover[1]})`;
    fill.style.width = `${(pos / track.seconds) * 100}%`;
    (times.firstChild as HTMLElement).textContent = mmss(pos);
    (times.lastChild as HTMLElement).textContent = mmss(track.seconds);
    state.textContent = media.playing ? "Playing" : "Paused";
    small.classList.toggle("paused", !media.playing);
    if (document.activeElement !== volume) volume.value = String(media.volume);
    setIcon(volumeIcon, media.volume === 0 ? ICONS.speakerOff : ICONS.speakerOn, 13);
  }

  return { def, small, card: frame(def, body, ctx.onBack, state), paint };
}

// ── To-do: a checklist, and notes ─────────────────────────────────────────────

function buildTodo(ctx: WidgetContext): Widget {
  const def = WIDGETS.todo;

  // Small: the last few items and a field to add one.
  const sList = h("div", { class: "wmini-list" });
  const sAdd = addField("Add an item…", addTodo, "wmini-field");
  const small = mini(def, h("div", { class: "wbody-todo" }, sList, shared(sAdd.field, "todo-add", "text")));

  // Expanded: the whole list, and the notes.
  const list = h("div", { class: "gh-list fc-list" });
  const add = addField("Add an item…", addTodo);
  const notes = h("textarea", { class: "note-text", spellcheck: "false", placeholder: "Notes…" });
  notes.addEventListener("input", () => setTodoNotes(notes.value));
  const count = h("span", { class: "fc-aside" });

  const body = h("div", { class: "todo" },
    h("div", { class: "fc-col" }, list, h("div", { class: "fc-add" }, shared(add.field, "todo-add", "text"))),
    h("div", { class: "fc-col" }, h("div", { class: "fc-label", text: "Notes" }), notes));

  let shown = "";
  function paint() {
    // Never while typing: the text area is the source, and rewriting it would move the caret.
    if (document.activeElement !== notes && notes.value !== todo.notes) notes.value = todo.notes;
    const left = todo.items.filter((i) => !i.done).length;
    count.textContent = `${left} to do · ${todo.items.length - left} done`;

    const key = todo.items.map((i) => `${i.id}${i.done}`).join();
    if (key === shown) return;
    const grew = shown !== "" && key.length > shown.length;
    shown = key;
    clear(sList);
    for (const item of todo.items.slice(-TODO_SMALL)) {
      sList.append(checkRow({
        name: `todo-${item.id}`, text: item.text, done: item.done, square: true,
        onToggle: () => toggleTodo(item.id),
      }));
    }
    clear(list);
    for (const item of todo.items) {
      list.append(checkRow({
        name: `todo-${item.id}`, text: item.text, done: item.done, square: true,
        onToggle: () => toggleTodo(item.id),
        extra: [removeButton("this item", () => removeTodo(item.id))],
      }));
    }
    // A new item goes to the end: the list follows it.
    if (grew) list.scrollTop = list.scrollHeight;
  }

  return { def, small, card: frame(def, body, ctx.onBack, count), paint };
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function buildTimer(ctx: WidgetContext): Widget {
  const def = WIDGETS.timer;
  const PRESETS = [5, 15, 25];

  // Small: the countdown and start / pause.
  const sTime = shared(h("div", { class: "timer-time" }), "timer-time");
  const sSub = shared(h("div", { class: "timer-sub" }), "timer-sub", "text");
  const sGo = shared(h("button", { class: "btn primary wmini-btn", onclick: timerToggle }), "timer-go");
  const small = mini(def, h("div", { class: "wbody-timer" }, h("div", {}, sTime, sSub), sGo));

  // Expanded: the dial, the presets, a time of one's own.
  const R = 62;
  const LENGTH = 2 * Math.PI * R;
  const dial = svgEl("svg", { viewBox: "0 0 150 150", width: 150, height: 150, class: "timer-dial" });
  const ring = svgEl("circle", {
    cx: 75, cy: 75, r: R, fill: "none", stroke: "currentColor", "stroke-width": 7,
    "stroke-linecap": "round", "stroke-dasharray": LENGTH, transform: "rotate(-90 75 75)", class: "timer-ring",
  });
  dial.append(
    svgEl("circle", { cx: 75, cy: 75, r: R, fill: "none", stroke: "rgba(255,255,255,0.08)", "stroke-width": 7 }),
    ring,
  );
  const time = shared(h("div", { class: "timer-time" }), "timer-time");
  const sub = shared(h("div", { class: "timer-sub" }), "timer-sub", "text");

  const presets = h("div", { class: "seg timer-presets" });
  for (const m of PRESETS) {
    const btn = h("button", { text: `${m} min`, onclick: () => timerSet(m) });
    btn.dataset.min = String(m);
    presets.append(btn);
  }
  const custom = h("input", {
    class: "island-field timer-custom", type: "number", min: 1, max: 599, step: 1, placeholder: "min",
    title: "A time of your own, in minutes", "aria-label": "Custom time in minutes",
  });
  const setCustom = () => {
    const value = Number(custom.value);
    if (!custom.value || !Number.isFinite(value) || value <= 0) return;
    timerSet(value);
    custom.value = "";
  };
  custom.addEventListener("keydown", (e) => {
    if (e.key === "Enter") setCustom();
  });
  const go = shared(h("button", { class: "btn primary", onclick: timerToggle }), "timer-go");

  const body = h("div", { class: "timer" },
    h("div", { class: "timer-face" }, dial as unknown as Node, h("div", { class: "timer-read" }, time, sub)),
    h("div", { class: "timer-set" },
      presets,
      h("div", { class: "timer-own" }, custom, h("button", { class: "chip-btn", text: "Set", onclick: setCustom }))),
    h("div", { class: "actions" }, go, h("button", { class: "btn secondary", text: "Reset", onclick: timerReset })));

  function paint() {
    const left = timerLeft();
    const read = clock(left);
    const of = timer.done ? "Time's up" : `of ${clock(timer.durationMs)}`;
    const label = timer.running ? "Pause" : timer.done ? "Restart" : "Start";
    for (const el of [sTime, time]) if (el.textContent !== read) el.textContent = read;
    time.classList.toggle("long", read.length > 5);
    sub.textContent = of;
    sSub.textContent = timer.done ? of : timer.running ? `${of} · running` : `${of} · paused`;
    for (const el of [sGo, go]) if (el.textContent !== label) el.textContent = label;
    ring.setAttribute("stroke-dashoffset", String(LENGTH * (1 - left / timer.durationMs)));
    body.classList.toggle("done", timer.done);
    small.classList.toggle("done", timer.done);
    for (const btn of presets.children) {
      btn.classList.toggle("on", Number((btn as HTMLElement).dataset.min) * 60_000 === timer.durationMs);
    }
  }

  return { def, small, card: frame(def, body, ctx.onBack), paint };
}

// ── Reminders ─────────────────────────────────────────────────────────────────

function buildReminders(ctx: WidgetContext): Widget {
  const def = WIDGETS.reminders;
  /** What the small card's field adds: there is no room for a "when". */
  const QUICK_MINUTES = 60;

  // Small: the next one, and a quick add.
  const sNext = h("div", { class: "wmini-next" });
  const sAdd = addField("Remind me in 1 h…", (text) => addReminder(text, QUICK_MINUTES), "wmini-field");
  const small = mini(def, h("div", { class: "wbody-reminders" }, sNext, shared(sAdd.field, "rem-add", "text")));

  // Expanded: the whole list, each line editable, and an add with a "when".
  const list = h("div", { class: "gh-list fc-list" });
  const when = h("select", { class: "fc-select", title: "When" },
    h("option", { value: "10", text: "in 10 min" }),
    h("option", { value: "60", text: "in 1 h" }),
    h("option", { value: "180", text: "in 3 h" }),
  );
  when.value = "60";
  const add = addField("Remind me to…", (text) => addReminder(text, Number(when.value)));
  const count = h("span", { class: "fc-aside" });

  const body = h("div", { class: "fc-col" },
    list,
    h("div", { class: "fc-add" }, shared(add.field, "rem-add", "text"), when,
      h("button", { class: "btn secondary", text: "Add", onclick: add.commit })),
    h("div", { class: "fc-note", text: "Click a reminder's words to edit them. Reminders fire only while Nook is running." }));

  let shown = "";
  let shownNext = "";
  const whens = new Map<number, HTMLElement[]>();
  const whenSpan = (id: number, cls: string) => {
    const el = h("span", { class: cls });
    whens.set(id, [...(whens.get(id) ?? []), el]);
    return el;
  };

  function paint() {
    const next = nextReminder();
    const left = reminders.filter((r) => !r.done).length;
    count.textContent = `${left} coming up`;

    const key = reminders.map((r) => `${r.id}${r.done}${r.text}`).join("|");
    const nextKey = next ? `${next.id}${next.text}` : "none";
    if (key !== shown || nextKey !== shownNext) {
      shown = key;
      shownNext = nextKey;
      whens.clear();

      clear(sNext);
      if (next) {
        const row = h("div", { class: "next-row" },
          h("button", { class: "check-main", title: "Mark as done", onclick: () => toggleReminder(next.id) },
            h("i", { class: "check" }),
            h("span", { class: "next-text", text: next.text })),
          whenSpan(next.id, "next-when"));
        sNext.append(shared(row, `rem-${next.id}`, "text"));
      } else {
        sNext.append(h("div", { class: "wmini-none", text: "Nothing coming up" }));
      }

      clear(list);
      for (const r of reminders) {
        // The words are a field: what is typed there is the reminder, once it is left or Enter is pressed.
        const words = h("input", { class: "row-edit", type: "text", value: r.text, maxlength: 60, title: "Edit", "aria-label": "Reminder" });
        words.addEventListener("change", () => renameReminder(r.id, words.value));
        words.addEventListener("keydown", (e) => {
          if (e.key === "Enter") words.blur();
          if (e.key === "Escape") {
            // Esc gives the words back, and stays in the list: it does not close the view.
            e.stopPropagation();
            words.value = r.text;
            words.blur();
          }
        });
        const row = h("div", { class: `gh-row check-row rem-row${r.done ? " done" : ""}` },
          h("button", { class: "check-main bare", title: r.done ? "Mark as not done" : "Mark as done", onclick: () => toggleReminder(r.id) },
            h("i", { class: "check" }, r.done ? svg(ICONS.check, 9, { stroke: 3.4 }) : null)),
          words,
          whenSpan(r.id, "int-ago"),
          removeButton("this reminder", () => removeReminder(r.id)));
        list.append(shared(row, `rem-${r.id}`, "text"));
      }
    }
    // "in 12 min" grows old by itself: the words change, the lines stay.
    for (const r of reminders) {
      const text = r.done ? "done" : untilText(r.at);
      for (const el of whens.get(r.id) ?? []) if (el.textContent !== text) el.textContent = text;
    }
  }

  return { def, small, card: frame(def, body, ctx.onBack, count), paint };
}

// ── Mirror ────────────────────────────────────────────────────────────────────

/** The Mirror's video element: whoever stops the camera clears it. */
export const mirrorVideo = h("video", { class: "mirror-video", muted: true, playsinline: true });
mirrorVideo.muted = true;

function buildMirror(ctx: WidgetContext): Widget {
  const def = WIDGETS.mirror;

  // Small: one button. There is no camera here, ever: it expands Mirror and starts it there.
  const sNote = h("div", { class: "wmini-note" });
  const sStart = shared(h("button", { class: "btn secondary wmini-btn", text: "Turn camera on", onclick: () => {
    resetCamera();
    ctx.onExpand("mirror", { camera: true });
  } }), "mirror-start");
  const small = mini(def, h("div", { class: "wbody-mirror" }, sNote, sStart));

  // Expanded: the large preview.
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub" });
  const start = shared(h("button", { class: "btn primary", onclick: () => {
    resetCamera();
    camera.consented = true;
    void startCamera(mirrorVideo);
  } }), "mirror-start");
  const placeholder = h("div", { class: "mirror-ph" },
    h("span", { class: "mirror-ph-mark" }, icon(def, 30)), title, sub, start);

  const body = h("div", { class: "mirror" }, mirrorVideo, placeholder);
  const card = frame(def, body, ctx.onBack);
  card.classList.add("bare");

  function paint() {
    const s = camera.state;
    sNote.textContent = "Camera off. It only ever runs in the expanded view.";
    body.classList.toggle("live", s === "on");
    start.style.display = s === "starting" ? "none" : "";
    switch (s) {
      case "on":
        break;
      case "starting":
        title.textContent = "Waiting for the camera…";
        sub.textContent = "Your browser may be asking for permission.";
        break;
      case "denied":
        title.textContent = "Camera access was refused";
        sub.textContent = "Allow the camera for this page (and in Windows privacy settings), then try again.";
        start.textContent = "Try again";
        break;
      case "unavailable":
        title.textContent = "No camera available";
        sub.textContent = "No camera was found, or another app is using it.";
        start.textContent = "Try again";
        break;
      case "off":
        title.textContent = "Camera off";
        sub.textContent = "Nothing is recorded or saved. The camera stops the moment you leave this view.";
        start.textContent = "Turn camera on";
        break;
    }
  }

  return { def, small, card, paint };
}

// ── Projects ──────────────────────────────────────────────────────────────────

function buildProjects(ctx: WidgetContext): Widget {
  const def = WIDGETS.projects;
  const repaint: (() => void)[] = [];

  /** A button that says what it did for a moment after it is pressed. */
  const launcher = (p: (typeof PROJECTS)[number], kind: "code" | "claude", label: string, title: string) => {
    const btn = h("button", { class: "chip-btn launch", title, onclick: () => (kind === "code" ? openInCode(p) : newClaudeSession(p)) });
    const mark = h("span", { class: "launch-icon" });
    const words = h("span", { text: label });
    btn.append(mark, words);
    repaint.push(() => {
      const done = justLaunched(p, kind);
      btn.classList.toggle("done", done);
      setIcon(mark, done ? ICONS.check : kind === "code" ? CODE : ICONS.terminal, 11, done ? 3 : 2.2);
    });
    return btn;
  };

  // Small: the most recent folders, each with "open in VS Code".
  const sList = h("div", { class: "wmini-list" });
  for (const p of PROJECTS.slice(0, PROJECTS_SMALL)) {
    sList.append(h("div", { class: "wmini-proj" },
      shared(h("b", { text: p.name, title: p.path }), `proj-name-${p.id}`, "text"),
      shared(launcher(p, "code", "Code", `Open ${p.name} in VS Code`), `proj-code-${p.id}`, "text")));
  }
  const small = mini(def, h("div", { class: "wbody-projects" }, sList));

  // Expanded: every folder, and a new Claude session in each.
  const note = h("div", { class: "fc-note" });
  const list = h("div", { class: "gh-list fc-list" });
  for (const p of PROJECTS) {
    list.append(h("div", { class: "gh-row proj-row" },
      h("div", { class: "proj-who" },
        h("div", { class: "proj-name" },
          shared(h("b", { text: p.name }), `proj-name-${p.id}`, "text"),
          h("span", { class: "int-ago", text: p.ago })),
        h("div", { class: "gh-sub path", text: p.path })),
      shared(launcher(p, "code", "Open in VS Code", `Open ${p.name} in VS Code`), `proj-code-${p.id}`, "text"),
      launcher(p, "claude", "New Claude session", `New Claude Code session in ${p.name}`)));
  }

  function paint() {
    for (const fn of repaint) fn();
    note.textContent = `Preview, nothing is launched: ${launch.text}.`;
  }

  return {
    def, small, paint,
    card: frame(def, h("div", { class: "fc-col" }, list, note), ctx.onBack,
      h("span", { class: "fc-aside", text: `${PROJECTS.length} folders` })),
  };
}

export function buildWidgets(ctx: WidgetContext): Record<WidgetId, Widget> {
  return {
    media: buildMedia(ctx),
    todo: buildTodo(ctx),
    timer: buildTimer(ctx),
    reminders: buildReminders(ctx),
    mirror: buildMirror(ctx),
    projects: buildProjects(ctx),
  };
}
