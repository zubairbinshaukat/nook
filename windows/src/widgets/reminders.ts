// Reminders: words and a time. Small: the next one, and a quick add. Expanded:
// the whole list, each line editable (its words, its time) and removable.
//
// They fire only while Nook is running — the expanded view says so in one line;
// there is no service and no scheduled task. There is one `setTimeout`, armed
// to the next one due: no polling, and none at all when nothing is waiting.
// When one is due, a sound is played and the island opens on the list. A
// reminder that came due while Nook was not running is not fired late and
// loud: at the next start it is marked missed, and one notice says so.
// Kept in shelf.json.

import { Sound } from "../core/sound";
import { clear, h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { loadWidget, notifyShelf, saveWidget, ShelfHooks } from "./core";
import { widgetOn } from "./defs";
import { addField, frame, mini, removeButton, shared, takesKeys, type Widget, type WidgetContext } from "./ui";

export const MAX_REMINDERS = 200;
export const MAX_TEXT_CHARS = 200;
/** The longest a single `setTimeout` is asked to wait: past it, the timer wakes, finds nothing due, and is armed again. */
const LONGEST_WAIT_MS = 2_000_000_000;
/** How long after the start the one notice of the missed ones comes: the greeting is over by then. */
const MISSED_NOTICE_MS = 6000;

export interface Reminder {
  id: number;
  text: string;
  at: number;
  done: boolean;
  /** It has come due (and was said), or it was set for a time already gone: it is not to fire again. */
  fired: boolean;
  /** It came due while Nook was not running. */
  missed: boolean;
}

export const reminders: Reminder[] = [];
let nextId = 1;
/** The one timer, to the next reminder due. */
let timerId = 0;

function save() {
  saveWidget("reminders", { items: reminders, nextId });
}

const pending = () => reminders.filter((r) => !r.done && !r.fired);

/** What the file said, held to what is valid. */
export function readReminders(raw: unknown): { items: Reminder[]; nextId: number } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const items: Reminder[] = [];
  const seen = new Set<number>();
  if (Array.isArray(o.items)) {
    for (const entry of o.items) {
      if (items.length >= MAX_REMINDERS) break;
      const r = entry as Partial<Reminder> | null;
      if (!r || typeof r.text !== "string" || !r.text.trim() || typeof r.at !== "number" || !Number.isFinite(r.at)) continue;
      let id = typeof r.id === "number" && Number.isFinite(r.id) ? r.id : 0;
      if (id <= 0 || seen.has(id)) id = Math.max(0, ...seen) + 1;
      seen.add(id);
      items.push({
        id, text: r.text.slice(0, MAX_TEXT_CHARS), at: r.at,
        done: r.done === true, fired: r.fired === true, missed: r.missed === true,
      });
    }
  }
  items.sort((a, b) => a.at - b.at);
  const next = typeof o.nextId === "number" && Number.isFinite(o.nextId) ? o.nextId : 1;
  return { items, nextId: Math.max(next, Math.max(0, ...seen) + 1) };
}

/** Arms the one timer to the next reminder due — or none, when nothing waits or the widget is switched off. */
function arm() {
  if (timerId) window.clearTimeout(timerId);
  timerId = 0;
  if (!widgetOn("reminders")) return;
  const next = pending().reduce<number | null>((soonest, r) => (soonest == null || r.at < soonest ? r.at : soonest), null);
  if (next == null) return;
  timerId = window.setTimeout(check, Math.min(Math.max(0, next - Date.now()), LONGEST_WAIT_MS));
}

/** The timer went off: whatever is due is said — one sound, one opening of the island, however many — and the next is armed. */
function check() {
  timerId = 0;
  const now = Date.now();
  const due = pending().filter((r) => r.at <= now);
  for (const r of due) r.fired = true;
  if (due.length > 0) {
    save();
    notifyShelf();
    Sound.play("pop");
    ShelfHooks.alert("reminders");
  }
  arm();
}

/** At start: the list is read; what came due while Nook was not running is marked missed, and said once, a little later. */
export async function startReminders() {
  const kept = readReminders(await loadWidget("reminders"));
  const now = Date.now();
  let missed = 0;
  for (const r of kept.items) {
    if (!r.done && !r.fired && r.at <= now) {
      r.fired = true;
      r.missed = true;
      missed++;
    }
  }
  // Whatever was added while the file was being read stays.
  reminders.splice(0, reminders.length, ...[...kept.items, ...reminders].sort((a, b) => a.at - b.at));
  nextId = Math.max(kept.nextId, ...reminders.map((r) => r.id + 1));
  if (missed > 0) {
    save();
    window.setTimeout(() => {
      if (!widgetOn("reminders")) return;
      Sound.play("pop");
      ShelfHooks.alert("reminders");
    }, MISSED_NOTICE_MS);
  }
  arm();
  notifyShelf();
}

/** Settings → Shelf changed: switched off, nothing is armed. */
export function rearmReminders() {
  arm();
}

function changed() {
  reminders.sort((a, b) => a.at - b.at);
  save();
  arm();
  notifyShelf();
}

export function addReminder(text: string, at: number) {
  const words = text.trim().slice(0, MAX_TEXT_CHARS);
  if (!words || reminders.length >= MAX_REMINDERS || !Number.isFinite(at)) return;
  reminders.push({ id: nextId++, text: words, at, done: false, fired: at <= Date.now(), missed: false });
  changed();
}

export const addReminderIn = (text: string, minutes: number) => addReminder(text, Date.now() + minutes * 60_000);

export function toggleReminder(id: number) {
  const r = reminders.find((x) => x.id === id);
  if (!r) return;
  r.done = !r.done;
  // Ticked again after its time: it is not fired late.
  if (!r.done && r.at <= Date.now()) r.fired = true;
  changed();
}

export function renameReminder(id: number, text: string) {
  const r = reminders.find((x) => x.id === id);
  const words = text.trim().slice(0, MAX_TEXT_CHARS);
  if (r && words) r.text = words;
  changed();
}

/** Another time: it may fire again, if it is still to come. */
export function retimeReminder(id: number, at: number) {
  const r = reminders.find((x) => x.id === id);
  if (!r || !Number.isFinite(at)) return;
  r.at = at;
  r.fired = at <= Date.now();
  r.missed = false;
  r.done = false;
  changed();
}

export function removeReminder(id: number) {
  const at = reminders.findIndex((x) => x.id === id);
  if (at >= 0) reminders.splice(at, 1);
  changed();
}

/** The one the small card shows: not done, the soonest — one that is due and not yet ticked comes first. */
export const nextReminder = (): Reminder | null => reminders.find((r) => !r.done) ?? null;

/** "in 12 min", "in 2 h", "now", "5 min ago". */
export function untilText(at: number, now = Date.now()): string {
  const mins = Math.round((at - now) / 60_000);
  const abs = Math.abs(mins);
  if (abs < 1) return "now";
  const size = abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  return mins > 0 ? `in ${size}` : `${size} ago`;
}

const whenText = (r: Reminder) => (r.done ? "done" : r.missed ? `missed · ${untilText(r.at)}` : untilText(r.at));

/** A time as a `datetime-local` field has it: the local clock, to the minute. */
function localInput(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Tomorrow at nine, local time. */
function tomorrowNine(): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/** The "when" choices of the quick add: minutes from now, or -1 for tomorrow at nine. */
const WHEN: [string, string][] = [["10", "10 min"], ["30", "30 min"], ["60", "1 h"], ["180", "3 h"], ["-1", "tomorrow 9:00"]];

function whenSelect(extra: string, labelled: boolean): HTMLSelectElement {
  const select = h("select", { class: `fc-select ${extra}`, title: "When", "aria-label": "When" });
  for (const [value, label] of WHEN) select.append(h("option", { value, text: labelled ? `in ${label}`.replace("in tomorrow", "tomorrow") : label }));
  select.value = "60";
  return select;
}

const atFromChoice = (value: string) => (value === "-1" ? tomorrowNine() : Date.now() + Number(value) * 60_000);

export function buildReminders(ctx: WidgetContext): Widget {
  // Small: the next one, and a quick add — its words, and when.
  const sNext = h("div", { class: "wmini-next" });
  const sWhen = whenSelect("wmini-when", false);
  const sAdd = addField(ctx, "New reminder", "Remind me to…", (text) => addReminder(text, atFromChoice(sWhen.value)), "wmini-field");
  const small = mini("reminders", h("div", { class: "wbody-reminders" }, sNext, h("div", { class: "wmini-addrow" }, shared(sAdd.field, "rem-add", "text"), sWhen)));

  // Expanded: the whole list, each line editable, and an add with a "when".
  const list = h("div", { class: "gh-list fc-list", "aria-label": "Reminders" });
  const when = whenSelect("", true);
  const add = addField(ctx, "New reminder", "Remind me to…", (text) => addReminder(text, atFromChoice(when.value)));
  const count = h("span", { class: "fc-aside" });

  const body = h("div", { class: "fc-col" },
    list,
    h("div", { class: "fc-add" }, shared(add.field, "rem-add", "text"), when,
      h("button", { class: "btn secondary", text: "Add", onclick: add.commit })),
    h("div", { class: "fc-note", text: "Reminders fire only while Nook is running. Click a reminder's words or its time to edit." }));

  let shown: string | null = null;
  let shownNext = "";
  const whens = new Map<number, HTMLElement[]>();
  const whenSpan = (r: Reminder, tag: "span" | "button") => {
    const el = tag === "button"
      ? h("button", { class: "chip-btn rem-when", title: "Change the time" })
      : h("span", { class: "next-when" });
    whens.set(r.id, [...(whens.get(r.id) ?? []), el]);
    return el;
  };

  /** A line's time, as a button that turns into a field for the date and the hour. */
  function editTime(button: HTMLElement, r: Reminder) {
    const field = takesKeys(ctx, h("input", { class: "island-field rem-time", type: "datetime-local", "aria-label": "Time", value: localInput(r.at) }));
    let settled = false;
    const settle = (commit: boolean) => {
      if (settled) return;
      settled = true;
      const at = field.valueAsNumber;
      // `datetime-local` reads as a local time written as if it were UTC: the offset puts it right.
      const local = Number.isFinite(at) ? at + new Date(at).getTimezoneOffset() * 60_000 : NaN;
      // Let go first: the list is not drawn again under a field that is being typed in.
      field.blur();
      if (commit && Number.isFinite(local)) retimeReminder(r.id, local);
      else field.replaceWith(button);
    };
    field.addEventListener("change", () => settle(true));
    field.addEventListener("blur", () => settle(false));
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") settle(true);
    });
    button.replaceWith(field);
    field.focus();
  }

  function paint() {
    const next = nextReminder();
    const left = reminders.filter((r) => !r.done).length;
    count.textContent = `${left} coming up`;

    const key = reminders.map((r) => `${r.id}${r.done ? "x" : "o"}${r.fired ? "f" : ""}${r.missed ? "m" : ""}${r.at}${r.text}`).join("|");
    const nextKey = next ? `${next.id}${next.text}${next.at}` : "none";
    if (key !== shown || nextKey !== shownNext) {
      // Never while a line's words or time are being typed: the line is the source, and drawing it again would take the caret.
      if (shown !== null && document.activeElement instanceof HTMLElement && list.contains(document.activeElement)) return;
      shown = key;
      shownNext = nextKey;
      whens.clear();

      clear(sNext);
      if (next) {
        const row = h("div", { class: `next-row${next.fired ? " due" : ""}` },
          h("button", { class: "check-main", title: "Mark as done", onclick: () => toggleReminder(next.id) },
            h("i", { class: "check" }),
            h("span", { class: "next-text", text: next.text })),
          whenSpan(next, "span"));
        sNext.append(shared(row, `rem-${next.id}`, "text"));
      } else {
        sNext.append(h("div", { class: "wmini-none", text: "Nothing coming up" }));
      }

      clear(list);
      for (const r of reminders) {
        // The words are a field: what is typed there is the reminder, once it is left or Enter is pressed.
        const words = takesKeys(ctx, h("input", { class: "row-edit", type: "text", value: r.text, maxlength: MAX_TEXT_CHARS, title: "Edit", "aria-label": "Reminder" }));
        words.addEventListener("change", () => renameReminder(r.id, words.value));
        words.addEventListener("keydown", (e) => {
          if (e.key === "Enter") words.blur();
        });
        // Esc gives the words back (before the field lets go and would keep them), and stays in the list: it does not close the view.
        words.addEventListener("keydown", (e) => {
          if (e.key === "Escape") words.value = r.text;
        }, true);
        const time = whenSpan(r, "button");
        time.addEventListener("click", () => editTime(time, r));
        const row = h("div", { class: `gh-row check-row rem-row${r.done ? " done" : ""}${r.fired && !r.done ? " due" : ""}${r.missed && !r.done ? " missed" : ""}` },
          h("button", { class: "check-main bare", title: r.done ? "Mark as not done" : "Mark as done", onclick: () => toggleReminder(r.id) },
            h("i", { class: "check" }, r.done ? svg(ICONS.check, 9, { stroke: 3.4 }) : null)),
          words, time,
          removeButton("this reminder", () => removeReminder(r.id)));
        list.append(shared(row, `rem-${r.id}`, "text"));
      }
      if (reminders.length === 0) list.append(h("div", { class: "wmini-none", text: "No reminders yet" }));
    }
    // "in 12 min" grows old by itself: the words change, the lines stay.
    for (const r of reminders) {
      const text = whenText(r);
      for (const el of whens.get(r.id) ?? []) if (el.textContent !== text) el.textContent = text;
    }
  }

  // "in 12 min" is looked at again once a second while the Shelf is on show, as the other widgets are.
  return { id: "reminders", small, card: frame("reminders", body, ctx.back, count), paint, tick: paint };
}
