// A self-check of the rules the journal's Markdown is read by — what is an
// alert, what is a file's path, what a long reply shows first. They are plain
// functions of the text (src/views/markdown.ts) and there is no test runner
// on this side, so they are checked here, where a preview page loads: the
// console says how many held, and names each one that did not. Preview only.

import { EXAMPLE_REPLY, LONG_REPLY } from "./session-data";
import { CUT_OVER, MAX_EXIST_CHECKS, calloutOf, collapsePlan, filePath, linesOf, markdown, needsDecision, parse, type Block, type PathOpener } from "../../src/views/markdown";

export function checkMarkdown(): { passed: number; failed: string[] } {
  let passed = 0;
  const failed: string[] = [];
  const check = (what: string, held: boolean) => {
    if (held) passed++;
    else failed.push(what);
  };
  const same = (what: string, got: unknown, wanted: unknown) => check(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`, JSON.stringify(got) === JSON.stringify(wanted));

  // ── Alerts ──
  same("marker alone", calloutOf("[!NOTE]"), { kind: "note", rest: "" });
  same("any case", calloutOf("[!important]"), { kind: "important", rest: "" });
  same("words on the marker's line", calloutOf("[!WARNING] Mind the gap"), { kind: "warning", rest: "Mind the gap" });
  same("spaces around", calloutOf("  [!Tip]  "), { kind: "tip", rest: "" });
  for (const not of ["[!INFO]", "[NOTE]", "!NOTE", "Note: [!NOTE]", "[! NOTE]", "[!NOTE", ""]) same(`not a marker: ${not}`, calloutOf(not), null);

  const quote = (source: string) => parse(source)[0] as Extract<Block, { kind: "quote" }>;
  same("an alert's kind", quote("> [!CAUTION]\n> Careful.").callout, "caution");
  same("an alert's body is Markdown", quote("> [!NOTE]\n> One.\n>\n> - a\n> - b").blocks.map((b) => b.kind), ["p", "list"]);
  same("words after the marker start the body", quote("> [!TIP] Short.\n> More.").blocks, [{ kind: "p", lines: ["Short.", "More."] }]);
  same("a plain quote", quote("> Just a quote.").callout, null);
  same("the marker must come first", quote("> Text\n> [!NOTE]").callout, null);
  same("a quote ends on the first other line", parse("> a\nb").map((b) => b.kind), ["quote", "p"]);
  same("raw HTML stays text", parse("<b>bold</b>"), [{ kind: "p", lines: ["<b>bold</b>"] }]);
  same("a fence wins over a quote inside it", parse("```\n> [!NOTE]\n```").map((b) => b.kind), ["code"]);
  check("a decision is an IMPORTANT alert", needsDecision("Text\n\n> [!IMPORTANT]\n> Pick one."));
  check("…not the words alone", !needsDecision("Use `[!IMPORTANT]` for that."));
  check("…nor in a code block", !needsDecision("```\n> [!IMPORTANT]\n```"));
  check("…nor another alert", !needsDecision("> [!WARNING]\n> Careful."));
  check("no reply, no decision", !needsDecision(null));

  // ── Paths ──
  const path = (text: string) => filePath(text);
  same("relative, with a folder", path("src/views/markdown.ts"), { path: "src/views/markdown.ts", line: null, col: null, bare: false });
  same("with a line", path("src/a.ts:12"), { path: "src/a.ts", line: 12, col: null, bare: false });
  same("with a line and a column", path("src/a.ts:12:5"), { path: "src/a.ts", line: 12, col: 5, bare: false });
  same("a drive", path("C:\\work\\nook\\NOTICE"), { path: "C:\\work\\nook\\NOTICE", line: null, col: null, bare: false });
  same("a drive, with a line", path("C:/work/a.rs:7"), { path: "C:/work/a.rs", line: 7, col: null, bare: false });
  same("from the root", path("/usr/local/etc/app.conf"), { path: "/usr/local/etc/app.conf", line: null, col: null, bare: false });
  // A single name: a path only as far as its shape goes — a link once the file is known to exist.
  same("a name with a known extension is bare", path("markdown.ts"), { path: "markdown.ts", line: null, col: null, bare: true });
  same("so is a word that only looks like a file", path("node.js")?.bare, true);
  same("a bare name with a line is a path as it stands", path("markdown.ts:40"), { path: "markdown.ts", line: 40, col: null, bare: false });
  same("a backslash is a separator too", path("views\\markdown.ts")?.bare, false);
  same("a dot folder", path(".github/workflows/ci.yml")?.path, ".github/workflows/ci.yml");
  same("up and across", path("../other/Cargo.toml")?.path, "../other/Cargo.toml");
  same("brackets in a name", path("app/(shop)/[id]/page.tsx")?.path, "app/(shop)/[id]/page.tsx");
  same("a file with no extension, in a folder", path("docker/Dockerfile")?.path, "docker/Dockerfile");
  for (const not of [
    "session.answer", "Math.round()", "console.log", "v1.2.3", "e.g.", "and/or", "TCP/IP", "application/json", "src/views", "src/", "/clear", "/",
    "https://example.com/a.ts", "file:///C:/a.ts", "--goto", "-x/a.ts", "*.ts", "src/*.ts", "a b/c.ts", "..", "./..", "C:\\Users\\nook", "README",
    "npm run build", "foo.bar", "//server/share/a.ts", "\\\\server\\share\\a.ts", "a.ts:", "a.ts:x", "$HOME/a.ts", "%APPDATA%\\a.ts", "~", "",
  ]) same(`not a path: ${not}`, path(not), null);

  // ── A very long reply ──
  const count = (source: Block[]) => source.reduce((n, block) => n + linesOf(block), 0);
  same("a short reply is shown whole", collapsePlan(parse("# One\n\nTwo lines.\n\n## Two\n\nMore.")), null);
  // The example — some fifty lines, with an IMPORTANT alert in its second half — is shown whole: no button.
  const example = parse(EXAMPLE_REPLY);
  check("the example is 40 to 60 lines", count(example) >= 40 && count(example) <= 60);
  same("…and is not cut", collapsePlan(example), null);
  same("exactly the limit is still whole", collapsePlan(parse(Array.from({ length: CUT_OVER }, (_, i) => `Line ${i}.`).join("\n\n"))), null);
  // One line more is cut: from its beginning, in order, up to the limit.
  const flat = parse(Array.from({ length: CUT_OVER + 40 }, (_, i) => `Line ${i}.`).join("\n\n"));
  const cut = collapsePlan(flat);
  same("past the limit: its start, up to the limit", [cut?.lead.length, cut?.hidden, cut?.decisions], [CUT_OVER, 40, 0]);
  same("…the very blocks it starts with, in their order", cut?.lead, flat.slice(0, CUT_OVER));
  // The long example: cut near its end, between two blocks, with its decision counted and not moved.
  const long = parse(LONG_REPLY);
  const plan = collapsePlan(long);
  check("the long example is past the limit", count(long) > CUT_OVER && plan != null);
  check("what is shown stays within the limit", plan != null && count(plan.lead) <= CUT_OVER && count(plan.lead) > CUT_OVER - 30);
  same("it is the reply's own beginning", plan?.lead, long.slice(0, plan?.lead.length));
  same("the lines left out are counted", plan?.hidden, count(long) - count(plan?.lead ?? []));
  same("the decision in the rest is counted", plan?.decisions, 1);
  check("…and not shown before its place", !(plan?.lead ?? []).some((block) => block.kind === "quote" && block.callout === "important"));
  check("the badge still reads the whole reply", needsDecision(LONG_REPLY));
  // A block is never cut: a code fence or a table that would cross the limit is left out whole.
  const fence = `\`\`\`\n${Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")}\n\`\`\``;
  const before = Array.from({ length: CUT_OVER - 20 }, (_, i) => `Line ${i}.`).join("\n\n");
  const crossing = collapsePlan(parse(`${before}\n\n${fence}\n\nAfter.`));
  same("a fence that would cross the limit is all in the rest", [crossing?.lead.length, crossing?.lead.some((block) => block.kind === "code"), crossing?.hidden], [CUT_OVER - 20, false, 62]);
  const table = `| a | b |\n|---|---|\n${Array.from({ length: 60 }, (_, i) => `| ${i} | x |`).join("\n")}`;
  same("and so is a table", collapsePlan(parse(`${before}\n\n${table}\n\nAfter.`))?.lead.some((block) => block.kind === "table"), false);
  // The first block is shown whole, however long it is; a reply that is one block is not cut at all.
  const huge = `\`\`\`\n${Array.from({ length: CUT_OVER + 50 }, (_, i) => `line ${i}`).join("\n")}\n\`\`\``;
  same("a first block longer than the limit is shown whole", collapsePlan(parse(`${huge}\n\nAfter.`))?.lead.map((block) => block.kind), ["code"]);
  same("a reply that is one block is whole", collapsePlan(parse(huge)), null);
  // Decisions in the rest: each IMPORTANT alert, one inside a quote too; none of what is shown.
  const asks = "> [!IMPORTANT]\n> Pick one.";
  same("two decisions further down", collapsePlan(parse(`${before}\n\n${fence}\n\n${asks}\n\nText.\n\n> Quoted:\n> > [!IMPORTANT]\n> > And this.`))?.decisions, 2);
  same("a decision that is shown is not counted", collapsePlan(parse(`${asks}\n\n${before}\n\n${fence}`))?.decisions, 0);

  if (failed.length > 0) console.error(`[markdown self-check] ${failed.length} failed:\n${failed.join("\n")}`);
  else console.info(`[markdown self-check] ${passed} checks passed`);
  return { passed, failed };
}

/**
 * Which pieces of inline code are drawn as links that open a file: a path
 * with a folder or a position at once; a bare name only after the session's
 * folder was asked and has it; and never more than `MAX_EXIST_CHECKS`
 * questions for one answer. The folder here is made up.
 */
export async function checkPathLinks(): Promise<{ passed: number; failed: string[] }> {
  let passed = 0;
  const failed: string[] = [];
  const same = (what: string, got: unknown, wanted: unknown) => {
    if (JSON.stringify(got) === JSON.stringify(wanted)) passed++;
    else failed.push(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`);
  };
  const there = new Set(["markdown.ts", "README.md"]);
  const asked: string[] = [];
  const known = new Map<string, boolean>();
  const opener: PathOpener = {
    tip: "Open in the editor",
    open: async () => true,
    // As the panel does: what is known is said at once, the rest is asked.
    exists(name) {
      const before = known.get(name);
      if (before != null) return before;
      asked.push(name);
      return new Promise((settle) => window.setTimeout(() => {
        known.set(name, there.has(name));
        settle(there.has(name));
      }, 0));
    },
  };
  const links = (el: HTMLElement) => [...el.querySelectorAll(".md-path")].map((chip) => chip.textContent);
  const codes = (el: HTMLElement) => [...el.querySelectorAll("code")].map((chip) => chip.textContent);
  const settle = () => new Promise((done) => window.setTimeout(done, 5));

  const reply = "See `src/views/markdown.ts`, `markdown.ts`, `node.js`, `main.rs:12`, `README.md` and `session.answer`.";
  const drawn = markdown(reply, opener);
  same("at once: only what has a folder or a position", links(drawn), ["src/views/markdown.ts", "main.rs:12"]);
  same("the bare names are code meanwhile", codes(drawn), ["markdown.ts", "node.js", "README.md", "session.answer"]);
  same("only bare names with a known extension are asked about", asked, ["markdown.ts", "node.js", "README.md"]);
  await settle();
  same("the ones that exist become links", links(drawn), ["src/views/markdown.ts", "markdown.ts", "main.rs:12", "README.md"]);
  same("node.js stays a plain chip", codes(drawn), ["node.js", "session.answer"]);
  // Drawn again: what is known is a link from the start, and nothing is asked twice.
  asked.length = 0;
  const again = markdown(reply, opener);
  same("drawn again: links at once", links(again), ["src/views/markdown.ts", "markdown.ts", "main.rs:12", "README.md"]);
  same("…and no question", asked, []);
  // With no way to ask, or no way to open, a bare name is never a link.
  same("no existence check: bare names stay code", links(markdown(reply, { tip: "", open: async () => true })), ["src/views/markdown.ts", "main.rs:12"]);
  same("no editor: nothing is a link", links(markdown(reply, null)), []);
  // A reply that names a great many: twenty questions, and the rest stay code.
  asked.length = 0;
  const many = Array.from({ length: MAX_EXIST_CHECKS + 15 }, (_, i) => `\`file${i}.ts\``).join(" ");
  markdown(many, opener);
  same("questions for one answer are capped", asked.length, MAX_EXIST_CHECKS);

  if (failed.length > 0) console.error(`[path-link self-check] ${failed.length} failed:\n${failed.join("\n")}`);
  else console.info(`[path-link self-check] ${passed} checks passed`);
  return { passed, failed };
}
