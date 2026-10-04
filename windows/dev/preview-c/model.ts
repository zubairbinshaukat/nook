// Shelf preview — fake data and the little state each widget keeps.
// Preview only: nothing here talks to Tauri, the disk (beyond localStorage) or
// the network. See plans/tabs-plan.md.
//
// A widget's small card and its expanded view are two pictures of what is in
// this file: neither keeps a copy. Whatever changes it calls `notify`, and
// whoever is on show repaints.

export type WidgetId = "media" | "todo" | "timer" | "reminders" | "mirror" | "projects";

export interface WidgetDef {
  id: WidgetId;
  name: string;
  /** The widget's accent: its icon, its card's thin border, the expanded view's tint, the glow under the island. */
  accent: string;
  /** A path on the 24×24 grid, as views/icons.ts has them. */
  icon: string;
  /** The island's size while this widget is expanded. */
  w: number;
  h: number;
}

export const WIDGETS: Record<WidgetId, WidgetDef> = {
  media: {
    id: "media", name: "Media", accent: "#34D399",
    icon: "M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0M19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0",
    w: 460, h: 200,
  },
  todo: {
    id: "todo", name: "To-do", accent: "#FACC15",
    icon: "M4 6.5l1.6 1.6L8.5 5M11.5 6.5H20M4 12.5l1.6 1.6 2.9-3.1M11.5 12.5H20M4.5 18.5h3M11.5 18.5H20",
    w: 520, h: 300,
  },
  timer: {
    id: "timer", name: "Timer", accent: "#F5A524",
    icon: "M12 6a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15M12 9.5v4l2.5 1.5M9.5 2.8h5",
    w: 360, h: 338,
  },
  reminders: {
    id: "reminders", name: "Reminders", accent: "#F472B6",
    icon: "M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14zM10 20.5a2 2 0 0 0 4 0",
    w: 440, h: 304,
  },
  mirror: {
    id: "mirror", name: "Mirror", accent: "#22D3EE",
    icon: "M4 8h3l1.5-2.5h7L17 8h3v11H4zM12 10.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6",
    // The largest view (plans/tabs-plan.md §3): a rounded 4:3 preview.
    w: 520, h: 390,
  },
  projects: {
    id: "projects", name: "Projects", accent: "#3B9EFF",
    icon: "M3.5 6.5h6l2 2.5h9v10.5h-17z",
    // Tall enough for all six folders: nothing scrolls.
    w: 580, h: 330,
  },
};

export const DEFAULT_ORDER: WidgetId[] = ["media", "todo", "timer", "reminders", "mirror", "projects"];

// ── What changed, said to whoever listens ─────────────────────────────────────

const listeners = new Set<() => void>();
export const onChange = (fn: () => void) => void listeners.add(fn);
export const notify = () => {
  for (const fn of listeners) fn();
};

// ── Order and hidden cards ────────────────────────────────────────────────────
// The plan saves these in %APPDATA%\Nook\shelf.json; the preview uses localStorage.

const ORDER_KEY = "nook.shelf-preview.order.v2";
const HIDDEN_KEY = "nook.shelf-preview.hidden.v2";

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: the order lives for this page only */
  }
}

const isId = (v: unknown): v is WidgetId => typeof v === "string" && v in WIDGETS;

export function loadOrder(): WidgetId[] {
  const saved = read(ORDER_KEY);
  const order = Array.isArray(saved) ? saved.filter(isId) : [];
  const unique = [...new Set(order)];
  // A widget added since the order was saved goes to the end.
  for (const id of DEFAULT_ORDER) if (!unique.includes(id)) unique.push(id);
  return unique;
}

export const saveOrder = (order: WidgetId[]) => write(ORDER_KEY, order);

export function resetOrder(): WidgetId[] {
  try {
    localStorage.removeItem(ORDER_KEY);
  } catch {
    /* nothing saved */
  }
  return [...DEFAULT_ORDER];
}

export function loadHidden(): Set<WidgetId> {
  const saved = read(HIDDEN_KEY);
  return new Set(Array.isArray(saved) ? saved.filter(isId) : []);
}

export const saveHidden = (hidden: Set<WidgetId>) => write(HIDDEN_KEY, [...hidden]);

// ── Media (fake) ──────────────────────────────────────────────────────────────

export interface Track {
  title: string;
  artist: string;
  seconds: number;
  /** Two colours for the made-up album art. */
  cover: [string, string];
}

export const TRACKS: Track[] = [
  { title: "Paper Lanterns", artist: "The Low Tides", seconds: 214, cover: ["#34D399", "#0EA5E9"] },
  { title: "Night Bus Home", artist: "Marlowe & Finch", seconds: 187, cover: ["#F472B6", "#8B5CF6"] },
  { title: "Soft Static", artist: "Juniper Vale", seconds: 245, cover: ["#F5A524", "#F4505E"] },
];

export const media = {
  index: 0,
  playing: true,
  /** Seconds into the track when it was last started or paused. */
  at: 47,
  /** When it was last started (ms), while playing. */
  since: Date.now(),
  /** 0…100. */
  volume: 64,
};

export function mediaPosition(now = Date.now()): number {
  const track = TRACKS[media.index];
  const pos = media.playing ? media.at + (now - media.since) / 1000 : media.at;
  return Math.min(track.seconds, pos);
}

export function mediaToggle() {
  media.at = mediaPosition();
  media.since = Date.now();
  media.playing = !media.playing;
  notify();
}

export function mediaSkip(step: 1 | -1) {
  media.index = (media.index + step + TRACKS.length) % TRACKS.length;
  media.at = 0;
  media.since = Date.now();
  notify();
}

export function mediaVolume(value: number) {
  media.volume = Math.max(0, Math.min(100, Math.round(value)));
  notify();
}

/** A track that ran to its end moves on to the next: called by whoever repaints. */
export function mediaAdvance() {
  if (media.playing && mediaPosition() >= TRACKS[media.index].seconds) mediaSkip(1);
}

// ── Timer (real: it counts down) ──────────────────────────────────────────────

export const timer = {
  durationMs: 15 * 60_000,
  /** What is left, while paused. */
  remainingMs: 12 * 60_000 + 34_000,
  /** When it reaches zero, while running. */
  endsAt: 0,
  running: false,
  done: false,
  /** The one setTimeout to the deadline (plan §4: no ticking interval while hidden). */
  deadline: 0,
};

export function timerLeft(now = Date.now()): number {
  return timer.running ? Math.max(0, timer.endsAt - now) : timer.remainingMs;
}

function clearDeadline() {
  if (timer.deadline) window.clearTimeout(timer.deadline);
  timer.deadline = 0;
}

export function timerStart() {
  if (timer.running) return;
  if (timer.remainingMs <= 0) timer.remainingMs = timer.durationMs;
  timer.done = false;
  timer.running = true;
  timer.endsAt = Date.now() + timer.remainingMs;
  clearDeadline();
  timer.deadline = window.setTimeout(() => {
    timer.deadline = 0;
    timer.running = false;
    timer.remainingMs = 0;
    timer.done = true;
    notify();
  }, timer.remainingMs);
  notify();
}

export function timerPause() {
  if (!timer.running) return;
  timer.remainingMs = timerLeft();
  timer.running = false;
  clearDeadline();
  notify();
}

export const timerToggle = () => (timer.running ? timerPause() : timerStart());

export function timerReset() {
  clearDeadline();
  timer.running = false;
  timer.done = false;
  timer.remainingMs = timer.durationMs;
  notify();
}

/** A preset or a custom time: the countdown is set to it, stopped. */
export function timerSet(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  timer.durationMs = Math.round(Math.min(minutes, 599) * 60_000);
  timerReset();
}

export function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── Reminders (fake) ──────────────────────────────────────────────────────────

export interface Reminder {
  id: number;
  text: string;
  at: number;
  done: boolean;
}

let nextId = 1;
const minutes = (n: number) => Date.now() + n * 60_000;

export const reminders: Reminder[] = [
  { id: nextId++, text: "Stand-up with the team", at: minutes(12), done: false },
  { id: nextId++, text: "Send the invoice", at: minutes(95), done: false },
  { id: nextId++, text: "Water the plants", at: minutes(240), done: false },
  { id: nextId++, text: "Book the dentist", at: minutes(-30), done: true },
];

export function addReminder(text: string, inMinutes: number) {
  reminders.push({ id: nextId++, text, at: minutes(inMinutes), done: false });
  reminders.sort((a, b) => a.at - b.at);
  notify();
}

export function toggleReminder(id: number) {
  const r = reminders.find((x) => x.id === id);
  if (r) r.done = !r.done;
  notify();
}

export function renameReminder(id: number, text: string) {
  const r = reminders.find((x) => x.id === id);
  if (r && text.trim()) r.text = text.trim();
  notify();
}

export function removeReminder(id: number) {
  const at = reminders.findIndex((x) => x.id === id);
  if (at >= 0) reminders.splice(at, 1);
  notify();
}

export const nextReminder = () =>
  reminders.filter((r) => !r.done).sort((a, b) => a.at - b.at)[0] ?? null;

/** "in 12 min", "in 2 h", "now", "5 min ago". */
export function untilText(at: number, now = Date.now()): string {
  const mins = Math.round((at - now) / 60_000);
  const abs = Math.abs(mins);
  const size = abs < 60 ? `${abs} min` : `${Math.round(abs / 60)} h`;
  if (abs < 1) return "now";
  return mins > 0 ? `in ${size}` : `${size} ago`;
}

// ── To-do: a checklist and a note (fake) ──────────────────────────────────────

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

export const todo = {
  /** Oldest first: the small card shows the last few. */
  items: [
    { id: nextId++, text: "Decide on media controls", done: true },
    { id: nextId++, text: "Try the swipe on the trackpad", done: false },
    { id: nextId++, text: "Pick the widgets for v1", done: false },
    { id: nextId++, text: "Review the shelf preview", done: false },
  ] as TodoItem[],
  notes: "Ask about the shelf order\nMirror: is 520 × 390 too big?\nCards: 3 fit, the 4th peeks",
};

/** How many of the latest items the small card shows. */
export const TODO_SMALL = 3;

export function addTodo(text: string) {
  todo.items.push({ id: nextId++, text, done: false });
  notify();
}

export function toggleTodo(id: number) {
  const item = todo.items.find((x) => x.id === id);
  if (item) item.done = !item.done;
  notify();
}

export function removeTodo(id: number) {
  const at = todo.items.findIndex((x) => x.id === id);
  if (at >= 0) todo.items.splice(at, 1);
  notify();
}

export function setTodoNotes(text: string) {
  todo.notes = text;
  notify();
}

// ── Projects (fake; launching is only said, never done) ───────────────────────

export interface Project {
  id: number;
  name: string;
  path: string;
  ago: string;
}

export const PROJECTS: Project[] = [
  { id: 1, name: "nook", path: "D:\\work\\personal\\nook", ago: "2 min ago" },
  { id: 2, name: "korus", path: "D:\\work\\korus", ago: "1 h ago" },
  { id: 3, name: "sbe-hub", path: "D:\\work\\clients\\sbe-hub", ago: "yesterday" },
  { id: 4, name: "morning-ai-brief", path: "D:\\work\\personal\\morning-ai-brief", ago: "3 d ago" },
  { id: 5, name: "ig-post", path: "D:\\work\\personal\\ig-post", ago: "5 d ago" },
  { id: 6, name: "blueboost-site", path: "D:\\work\\clients\\blueboost-site", ago: "2 w ago" },
];

/** How many of the most recent folders the small card shows. */
export const PROJECTS_SMALL = 3;

export const launch = {
  /** What the last button pressed would have run. */
  text: "nothing launched yet",
  /** The folder and the action it was for, so its button can say so for a moment. */
  project: 0,
  kind: "" as "" | "code" | "claude",
  at: 0,
};

function launched(p: Project, kind: "code" | "claude", text: string) {
  launch.text = text;
  launch.project = p.id;
  launch.kind = kind;
  launch.at = Date.now();
  notify();
  // The button says "done" for a moment, then is itself again.
  window.setTimeout(notify, 1500);
}

export const openInCode = (p: Project) =>
  launched(p, "code", `would run  code "${p.path}"  (arguments passed separately, never a shell string)`);

export const newClaudeSession = (p: Project) =>
  launched(p, "claude", `would run  wt.exe -d "${p.path}" claude  (arguments passed separately)`);

export const justLaunched = (p: Project, kind: "code" | "claude") =>
  launch.project === p.id && launch.kind === kind && Date.now() - launch.at < 1400;
