// What Claude writes, as it means it to be read: its answers are Markdown.
//
// No Markdown library — the island shows one answer at a time, and what an
// answer is made of is short to list: headings, paragraphs, lists, tables,
// fenced code, quotes and GitHub's alerts (`> [!NOTE]`…), and inside a line
// bold, italics, code and links. Anything else stays as it was written.
// Everything is built as text nodes: nothing an answer contains is ever read
// as HTML, and a link is shown, not followed.
//
// An answer is read in two steps: `parse` makes blocks of it, with no DOM in
// sight — what is an alert, where a very long answer is cut (`collapsePlan`) and
// what looks like a file (`filePath`) are plain functions of the text — and
// `markdown` / `reply` draw them.

import { h } from "./dom";
import { LUCIDE, lucide } from "./iconset";

// ── Reading: an answer as blocks ──────────────────────────────────────────────

/** GitHub's five alerts, by the word between `[!` and `]`. */
export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

export interface ListItem {
  /** Spaces before its mark: what makes it one level deeper. */
  indent: number;
  /** "•", or its number: "1." */
  mark: string;
  text: string;
}

export type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "list"; items: ListItem[] }
  | { kind: "rule" }
  /** A quote; with `callout`, one of GitHub's alerts. What it holds is Markdown too. */
  | { kind: "quote"; callout: CalloutKind | null; blocks: Block[] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*```/;
const RULE = /^\s*([-*_])\s*(\1\s*){2,}$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/i;

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

/**
 * The first line of a quote, when it makes the quote an alert: `[!NOTE]`,
 * `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`, in any case, at the
 * very start of the line. GitHub wants the marker alone on its line; words
 * after it on the same line are taken as the start of what the alert says.
 */
export function calloutOf(line: string): { kind: CalloutKind; rest: string } | null {
  const found = CALLOUT.exec(line.trim());
  return found ? { kind: found[1].toLowerCase() as CalloutKind, rest: found[2].trim() } : null;
}

function blocksOf(lines: string[]): Block[] {
  const out: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) out.push({ kind: "p", lines: paragraph });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      // Every line that starts with `>`, without it; the first other line ends the quote.
      let inner: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) inner.push(QUOTE.exec(lines[i])![1]);
      i--;
      const callout = calloutOf(inner[0]);
      if (callout) inner = callout.rest ? [callout.rest, ...inner.slice(1)] : inner.slice(1);
      out.push({ kind: "quote", callout: callout?.kind ?? null, blocks: blocksOf(inner) });
      continue;
    }

    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? "")) {
      flush();
      const rows: string[][] = [];
      const head = cells(line);
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      out.push({ kind: "table", head, rows });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      out.push({ kind: "h", level: heading[1].length, text: heading[2] });
      continue;
    }

    if (ITEM.test(line)) {
      flush();
      const items: ListItem[] = [];
      for (; i < lines.length; i++) {
        const item = ITEM.exec(lines[i]);
        if (!item) {
          // A line that goes on under its item belongs to it; anything else ends the list.
          if (lines[i].trim() && /^\s+/.test(lines[i])) {
            items[items.length - 1].text += ` ${lines[i].trim()}`;
            continue;
          }
          break;
        }
        items.push({ indent: item[1].length, mark: /\d/.test(item[2]) ? item[2].replace(")", ".") : "•", text: item[3] });
      }
      i--;
      out.push({ kind: "list", items });
      continue;
    }

    if (RULE.test(line)) {
      flush();
      out.push({ kind: "rule" });
      continue;
    }

    if (line.trim() === "") flush();
    else paragraph.push(line.trim());
  }
  flush();
  return out;
}

/** An answer, block by block. */
export function parse(source: string): Block[] {
  return blocksOf(source.replace(/\r\n/g, "\n").split("\n"));
}

/** True for an answer that holds an `[!IMPORTANT]` alert: Claude is waiting on a decision. */
export function needsDecision(source: string | null): boolean {
  // The marker is looked for before anything is parsed: most answers have none.
  if (!source || !/\[!IMPORTANT\]/i.test(source)) return false;
  return parse(source).some((block) => block.kind === "quote" && block.callout === "important");
}

// ── A very long answer: where it is cut ───────────────────────────────────────

/**
 * An answer of more lines than this, once drawn, is cut: it is shown from its
 * beginning up to about this many lines, with the way to the rest at its end.
 * Anything shorter is shown whole — a reply, and a subagent's result alike.
 */
export const CUT_OVER = 150;
/** Letters in a line of the journal, about: what a long source line is counted as several by. */
const WRAP_CHARS = 86;

const wrapped = (text: string) => Math.max(1, Math.ceil(text.length / WRAP_CHARS));
const sum = (blocks: Block[]) => blocks.reduce((n, block) => n + linesOf(block), 0);

/** How many lines a block takes once drawn, about: read from the source, never measured. */
export function linesOf(block: Block): number {
  switch (block.kind) {
    case "p": return block.lines.reduce((n, line) => n + wrapped(line), 0);
    case "h": return block.level <= 2 ? 2 : 1;
    case "code": return block.text.split("\n").length + 1;
    case "table": return block.rows.length + 1;
    case "list": return block.items.reduce((n, item) => n + wrapped(item.text), 0);
    case "rule": return 1;
    case "quote": return (block.callout ? 1 : 0) + sum(block.blocks);
  }
}

/** True for an `[!IMPORTANT]` alert, or a quote that holds one. */
const asksDecision = (block: Block): boolean =>
  block.kind === "quote" && (block.callout === "important" || block.blocks.some(asksDecision));

export interface CollapsePlan {
  /** The answer from its beginning, as far as it is shown: whole blocks, in their order. */
  lead: Block[];
  /** Lines left out, about. */
  hidden: number;
  /** `[!IMPORTANT]` alerts in what is left out: said above the way to the rest, so none is missed. */
  decisions: number;
}

/**
 * Where a very long answer is cut — or null for one that is shown whole
 * (`CUT_OVER` lines or fewer, as `linesOf` counts them).
 *
 * It is shown from its beginning: every block, in order, for as long as the
 * count stays within `CUT_OVER` lines — the first block at least, whole. The
 * cut falls between two blocks, never inside one: a code fence, a table, a
 * list or an alert is either all there or all in the rest. Nothing is
 * reordered and nothing is lifted out of the rest; only the number of
 * IMPORTANT alerts in it is counted.
 */
export function collapsePlan(blocks: Block[]): CollapsePlan | null {
  const total = sum(blocks);
  if (total <= CUT_OVER) return null;
  let lines = 0;
  let cut = 0;
  for (; cut < blocks.length; cut++) {
    lines += linesOf(blocks[cut]);
    if (cut > 0 && lines > CUT_OVER) break;
  }
  if (cut >= blocks.length) return null;
  const lead = blocks.slice(0, cut);
  const hidden = total - sum(lead);
  return hidden > 0 ? { lead, hidden, decisions: blocks.slice(cut).filter(asksDecision).length } : null;
}

// ── A file, named in an answer ────────────────────────────────────────────────

export interface FilePath {
  path: string;
  line: number | null;
  col: number | null;
  /**
   * A single name with no folder and no position — `markdown.ts`, `node.js`:
   * it may be a file, or just a word with a dot in it. It is drawn as a link
   * only once Rust has said such a file exists (`PathOpener.exists`).
   */
  bare: boolean;
}

/** `:line` or `:line:col` at the end of a path. */
const POSITION = /:(\d{1,7})(?::(\d{1,7}))?$/;
/** What a folder's or a file's name is made of here: no space, no quote, nothing a shell or a URL would mean something by. */
const SEGMENT = /^[\w.\-+@~()[\]]+$/;
const EXTENSION = /\.([A-Za-z][A-Za-z0-9]{0,9})$/;
/** Longer than Windows lets a path be, it is not one. */
const PATH_CHARS = 260;
/** Extensions that make a file of a name on its own, with no folder before it: `markdown.ts`, not `session.answer`. */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "rs", "toml", "md", "mdx", "css", "scss", "html", "htm",
  "py", "go", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "sh", "ps1", "bat", "cmd",
  "yml", "yaml", "lock", "txt", "sql", "xml", "svg", "vue", "svelte", "ini", "cfg", "conf", "gradle", "csproj", "sln",
]);
/** Files with no extension that a path may end on. */
const BARE_FILES: ReadonlySet<string> = new Set(["Makefile", "Dockerfile", "LICENSE", "NOTICE", "README", "CHANGELOG", "Cargo.lock", "Gemfile", "Procfile"]);

/**
 * A piece of inline code, or a link's target, read as a file's path — or null:
 * when in doubt it is not one, and stays what it was.
 *
 * It is one when, its `:line` or `:line:col` taken off the end, it has no
 * space and is at most 260 characters; every part between separators (`/` or
 * `\`) is made of letters, digits and `_ . - + @ ~ ( ) [ ]` (so no URL, no
 * glob, no option, no empty part, no trailing separator); it does not end on
 * `.` or `..`; and
 * - it is absolute (`C:\…`, `C:/…`) or has a separator in it, and ends on a
 *   name with an extension (a letter, then up to nine letters or digits) or on
 *   one of a few files known to have none (`Makefile`, `LICENSE`…) — an
 *   absolute path from the root (`/…`) needs two parts, so `/clear` is not one;
 * - or it is a single name with an extension source files have (`.ts`, `.rs`,
 *   `.md`, `.json`…): `markdown.ts` is a file, `session.answer` is not.
 * Whether the file exists is not known here: Rust says, when it is opened.
 * A single name alone (`bare`) is the doubtful case — `node.js` is as likely
 * a word as a file — and is a link only after Rust was asked.
 */
export function filePath(text: string): FilePath | null {
  if (text.length > PATH_CHARS || /\s/.test(text)) return null;
  const at = POSITION.exec(text);
  const path = at ? text.slice(0, at.index) : text;
  const drive = /^[A-Za-z]:[\\/]/.test(path);
  const rooted = path.startsWith("/");
  const parts = path.slice(drive ? 3 : rooted ? 1 : 0).split(/[\\/]/);
  const last = parts[parts.length - 1];
  if (parts.some((part) => !SEGMENT.test(part)) || /^\.+$/.test(last) || path.startsWith("-")) return null;
  const extension = EXTENSION.exec(last)?.[1].toLowerCase() ?? null;
  const inFolder = drive || parts.length > 1;
  const isFile = inFolder ? extension != null || BARE_FILES.has(last) : !rooted && extension != null && KNOWN_EXTENSIONS.has(extension);
  if (!isFile) return null;
  return { path, line: at ? Number(at[1]) : null, col: at?.[2] ? Number(at[2]) : null, bare: !inFolder && !at };
}

// ── Drawing ───────────────────────────────────────────────────────────────────

/**
 * The way to open a file an answer names, where there is one: the session runs
 * in an editor. Without it a path is drawn as the code it is.
 */
export interface PathOpener {
  /** "Open in VS Code", "Open in Cursor". */
  tip: string;
  /** True when the editor was asked to open it; anything else, and the chip says the file was not found. */
  open(path: string, line: number | null): Promise<boolean | null>;
  /**
   * Whether a bare name is a file of the session's folder: the answer at once
   * when it is known already, a promise of it otherwise. Without this, a bare
   * name stays the code it is.
   */
  exists?(path: string): boolean | Promise<boolean>;
}

/** Bare names one answer asks about, at most: the rest stay code. */
export const MAX_EXIST_CHECKS = 20;

/**
 * The opener for one answer being drawn: it asks about `MAX_EXIST_CHECKS`
 * names and no more. What is known already costs nothing and is not counted.
 */
function capped(opener: PathOpener | null): PathOpener | null {
  if (!opener?.exists) return opener;
  let asked = 0;
  return {
    ...opener,
    exists(path) {
      if (asked >= MAX_EXIST_CHECKS) return false;
      const known = opener.exists!(path);
      if (typeof known !== "boolean") asked++;
      return known;
    },
  };
}

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|\*[^*\s][^*\n]*\*)/g;
/** Spaces of indentation that make a list item one level deeper, and how far in a level sits, in px. */
const INDENT = 2;
const LEVEL_PX = 12;
/** A piece of code longer than this may break across lines; a shorter one stays in one piece. */
const CHIP_CHARS = 28;
/** How long a path that could not be opened says so. */
const MISS_MS = 1_600;
/** An item that opens on bold words — "**Name**: …", "**Name** — …" — has them as its lead-in. */
const LEAD_IN = /^\*\*[^*\n]+\*\*/;

const chipClass = (text: string, base: string) => (text.length > CHIP_CHARS ? `${base} long` : base);

/**
 * A path as a chip that opens it. `shown` is what it reads: the path itself,
 * or a link's words. A span, not a button: it sits in a line like the code it
 * is, and a long one breaks with the line.
 */
function pathChip(shown: string, file: FilePath, opener: PathOpener, link = false): HTMLElement {
  const chip = h("span", { class: chipClass(shown, link ? "md-path link" : "md-path"), role: "button", title: opener.tip, text: shown });
  let busy = false;
  // The keyboard stays where it was: a chip is clicked, never focused.
  chip.addEventListener("mousedown", (e) => e.preventDefault());
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (busy) return;
    busy = true;
    const done = (went: boolean | null) => {
      busy = false;
      if (went === true) return;
      chip.classList.add("miss");
      window.setTimeout(() => chip.classList.remove("miss"), MISS_MS);
    };
    opener.open(file.path, file.line).then(done, () => done(false));
  });
  return chip;
}

/**
 * A bare name — `markdown.ts`, `node.js`: the code it is, until Rust says a
 * file of that name is in the session's folder. Then, and only then, it is
 * the chip that opens it.
 */
function bareName(code: string, file: FilePath, opener: PathOpener): HTMLElement {
  const known = opener.exists ? opener.exists(file.path) : false;
  if (known === true) return pathChip(code, file, opener);
  const plain = h("code", { class: chipClass(code, ""), text: code });
  if (known !== false) {
    void known.then((there) => {
      if (there) plain.replaceWith(pathChip(code, file, opener));
    }, () => {});
  }
  return plain;
}

/** A line's words, with what is bold, in italics, code or a link marked as such. */
function inline(text: string, opener: PathOpener | null, lead = false): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const piece = match[0];
    const start = match.index ?? 0;
    if (start > at) out.push(document.createTextNode(text.slice(at, start)));
    if (piece.startsWith("**")) out.push(h("b", { class: lead && start === 0 ? "md-lead" : undefined, text: piece.slice(2, -2) }));
    else if (piece.startsWith("`")) {
      const code = piece.slice(1, -1);
      const file = opener ? filePath(code) : null;
      // A path with a folder or a position in it is a link as it stands; a bare name is asked about first.
      out.push(file && opener ? (file.bare ? bareName(code, file, opener) : pathChip(code, file, opener)) : h("code", { class: chipClass(code, ""), text: code }));
    } else if (piece.startsWith("[")) {
      const words = piece.slice(1, piece.indexOf("]("));
      // A link to a file opens it; one to anywhere else is shown, and goes nowhere.
      const file = opener ? filePath(piece.slice(piece.indexOf("](") + 2, -1).trim()) : null;
      out.push(file && opener ? pathChip(words, file, opener, true) : h("span", { class: "md-link", text: words }));
    } else out.push(h("em", { text: piece.slice(1, -1) }));
    at = start + piece.length;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

/** Each alert's name, as its title says it, and its icon. Its colour is the style sheet's. */
const CALLOUTS: Record<CalloutKind, { title: string; icon: string }> = {
  note: { title: "Note", icon: LUCIDE.info },
  tip: { title: "Tip", icon: LUCIDE.lightbulb },
  important: { title: "Important", icon: LUCIDE.messageSquareWarning },
  warning: { title: "Warning", icon: LUCIDE.triangleAlert },
  caution: { title: "Caution", icon: LUCIDE.octagonAlert },
};
const CALLOUT_ICON = 13;

function draw(block: Block, opener: PathOpener | null): HTMLElement {
  switch (block.kind) {
    case "p": return h("p", {}, ...inline(block.lines.join("\n"), opener));
    // `#` and `##` stand out, `###` less, anything deeper is the body's own size in bold.
    case "h": return h("div", { class: `md-h h${Math.min(block.level, 4)}` }, ...inline(block.text, opener));
    case "code": return h("pre", { class: "md-code", text: block.text });
    case "rule": return h("hr", { class: "md-rule" });
    case "table":
      return h(
        "table", { class: "md-table" },
        h("thead", {}, h("tr", {}, ...block.head.map((cell) => h("th", {}, ...inline(cell, opener))))),
        h("tbody", {}, ...block.rows.map((row) => h("tr", {}, ...row.map((cell) => h("td", {}, ...inline(cell, opener)))))),
      );
    case "list":
      return h("div", { class: "md-list" }, ...block.items.map((item) => {
        const row = h("div", { class: "md-item" }, h("i", { text: item.mark }), h("span", {}, ...inline(item.text, opener, LEAD_IN.test(item.text))));
        row.style.paddingLeft = `${Math.floor(item.indent / INDENT) * LEVEL_PX}px`;
        return row;
      }));
    case "quote": {
      const body = block.blocks.map((inner) => draw(inner, opener));
      if (!block.callout) return h("blockquote", { class: "md-quote" }, ...body);
      const { title, icon } = CALLOUTS[block.callout];
      return h(
        "div", { class: `md-callout ${block.callout}`, role: "note" },
        h("div", { class: "md-callout-h" }, lucide(icon, CALLOUT_ICON), h("b", { text: title })),
        ...body,
      );
    }
  }
}

/** An answer, whole. With `opener`, the files it names open in the session's editor. */
export function markdown(source: string, opener: PathOpener | null = null): HTMLElement {
  const files = capped(opener);
  return h("div", { class: "md" }, ...parse(source).map((block) => draw(block, files)));
}

/** A very long answer's two forms — cut, and whole: which one is on show, and the way to the other. */
export interface ReplyFold {
  open: boolean;
  toggle(open: boolean): void;
}

/** True for an answer long enough to be cut. */
export const collapses = (source: string) => collapsePlan(parse(source)) != null;

/**
 * An answer as the journal shows it: whole — unless it is very long
 * (`CUT_OVER`), and then from its beginning to the cut, with the way to all
 * of it at the end, and back. A decision asked for in what is left out is
 * said, in one quiet line, above that way.
 */
export function reply(source: string, opener: PathOpener | null, fold: ReplyFold): HTMLElement {
  const blocks = parse(source);
  const plan = collapsePlan(blocks);
  const files = capped(opener);
  const all = (shown: Block[]) => shown.map((block) => draw(block, files));
  if (!plan) return h("div", { class: "md" }, ...all(blocks));
  const control = (label: string, note: string) =>
    h("button", { class: "md-more", type: "button", "aria-expanded": String(fold.open), onclick: () => fold.toggle(!fold.open) }, h("b", { text: label }), note ? h("span", { text: note }) : null);
  if (fold.open) return h("div", { class: "md" }, ...all(blocks), control("Show less", ""));
  return h(
    "div", { class: "md folded" },
    ...all(plan.lead),
    plan.decisions > 0 ? h("div", { class: "md-skip", text: `${plan.decisions} ${plan.decisions === 1 ? "decision" : "decisions"} further down` }) : null,
    control("Show full reply", `${plan.hidden} more ${plan.hidden === 1 ? "line" : "lines"}`),
  );
}
