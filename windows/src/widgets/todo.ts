// To-do: a checklist, and notes. Kept in shelf.json (widgets/core.ts), a moment
// after the last change; the same caps are held again by Rust (shelf.rs).
//
// Small: the last few items, a box to tick on each, and a field to add one.
// Expanded: the whole list (add, tick, remove) and a free text for notes.

import { clear, h } from "../views/dom";
import { loadWidget, notifyShelf, saveWidget } from "./core";
import { addField, checkRow, frame, mini, removeButton, takesKeys, type Widget, type WidgetContext } from "./ui";

export const MAX_ITEMS = 500;
export const MAX_ITEM_CHARS = 200;
export const MAX_NOTES_CHARS = 20_000;
/** How many of the latest items the small card shows. */
const SMALL_ITEMS = 3;

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

/** Oldest first: the small card shows the last few. */
export const todo = { items: [] as TodoItem[], notes: "" };
let nextId = 1;

function save() {
  saveWidget("todo", { items: todo.items, notes: todo.notes });
}

/** What the file said, held to what is valid: a damaged entry is left out, never trusted. */
export function readTodo(raw: unknown): { items: TodoItem[]; notes: string } {
  const object = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const items: TodoItem[] = [];
  const seen = new Set<number>();
  if (Array.isArray(object.items)) {
    for (const entry of object.items) {
      if (items.length >= MAX_ITEMS) break;
      const item = entry as Partial<TodoItem> | null;
      if (!item || typeof item.text !== "string" || !item.text.trim()) continue;
      const id = typeof item.id === "number" && Number.isFinite(item.id) && !seen.has(item.id) ? item.id : Math.max(0, ...seen) + 1;
      seen.add(id);
      items.push({ id, text: item.text.slice(0, MAX_ITEM_CHARS), done: item.done === true });
    }
  }
  const notes = typeof object.notes === "string" ? object.notes.slice(0, MAX_NOTES_CHARS) : "";
  return { items, notes };
}

/** Loaded once, at start: what was kept is there before the shelf is first looked at. */
export async function startTodo() {
  const kept = readTodo(await loadWidget("todo"));
  // Whatever was added while the file was being read stays, after what was kept.
  todo.items = [...kept.items, ...todo.items];
  if (!todo.notes) todo.notes = kept.notes;
  nextId = Math.max(0, ...todo.items.map((i) => i.id)) + 1;
  notifyShelf();
}

export function addTodo(text: string) {
  const words = text.trim().slice(0, MAX_ITEM_CHARS);
  if (!words || todo.items.length >= MAX_ITEMS) return;
  todo.items.push({ id: nextId++, text: words, done: false });
  save();
  notifyShelf();
}

export function toggleTodo(id: number) {
  const item = todo.items.find((x) => x.id === id);
  if (item) item.done = !item.done;
  save();
  notifyShelf();
}

export function removeTodo(id: number) {
  const at = todo.items.findIndex((x) => x.id === id);
  if (at >= 0) todo.items.splice(at, 1);
  save();
  notifyShelf();
}

export function setTodoNotes(text: string) {
  todo.notes = text.slice(0, MAX_NOTES_CHARS);
  save();
  // Not told to the cards: the text area is the source, and a repaint would only touch the caret.
}

export function buildTodo(ctx: WidgetContext): Widget {
  // Small: the last few items and a field to add one.
  const sList = h("div", { class: "wmini-list" });
  const sAdd = addField(ctx, "Add a to-do item", "Add an item…", addTodo, "wmini-field");
  const small = mini("todo", h("div", { class: "wbody-todo" }, sList, sAdd.field));
  sAdd.field.dataset.vt = "todo-add";
  sAdd.field.dataset.vtc = "text";

  // Expanded: the whole list, and the notes.
  const list = h("div", { class: "gh-list fc-list", "aria-label": "To-do items" });
  const add = addField(ctx, "Add a to-do item", "Add an item…", addTodo);
  add.field.dataset.vt = "todo-add";
  add.field.dataset.vtc = "text";
  const notes = takesKeys(ctx, h("textarea", {
    class: "note-text", spellcheck: "false", placeholder: "Notes…", "aria-label": "Notes", maxlength: MAX_NOTES_CHARS,
  }));
  notes.addEventListener("input", () => setTodoNotes(notes.value));
  const count = h("span", { class: "fc-aside" });

  const body = h("div", { class: "todo" },
    h("div", { class: "fc-col" }, list, h("div", { class: "fc-add" }, add.field)),
    h("div", { class: "fc-col" }, h("div", { class: "fc-label", text: "Notes" }), notes));

  let shown: string | null = null;
  let shownCount = 0;
  function paint() {
    // Never while typing: the text area is the source, and rewriting it would move the caret.
    if (document.activeElement !== notes && notes.value !== todo.notes) notes.value = todo.notes;
    const left = todo.items.filter((i) => !i.done).length;
    count.textContent = `${left} to do · ${todo.items.length - left} done`;

    const key = todo.items.map((i) => `${i.id}${i.done ? "x" : "o"}${i.text}`).join("|");
    if (key === shown) return;
    const grew = todo.items.length > shownCount;
    shown = key;
    shownCount = todo.items.length;
    clear(sList);
    for (const item of todo.items.slice(-SMALL_ITEMS)) {
      sList.append(checkRow({
        name: `todo-${item.id}`, text: item.text, done: item.done, square: true,
        onToggle: () => toggleTodo(item.id),
      }));
    }
    if (todo.items.length === 0) sList.append(h("div", { class: "wmini-none", text: "Nothing to do" }));
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

  return { id: "todo", small, card: frame("todo", body, ctx.back, count), paint };
}
