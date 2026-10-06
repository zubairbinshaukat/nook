// The screenshot stage: a made-up Windows desktop behind the island, drawn in
// plain HTML, CSS and inline SVG (stage.css) — Nook's wallpaper, a taskbar,
// desktop icons and, by `scene`, a browser, an editor or a terminal window. Every
// glyph is drawn here; none is a product's logo. Preview only: none of it ships.

import type { StageOptions, Wallpaper } from "./options";

// ── The wallpaper ────────────────────────────────────────────────────────────
// "nook": Nook's own silk-ribbon pictures in stage/wallpapers/, drawn by stage/wallpaper-gen/
// (`node scripts/make-wallpaper.mjs`) and committed. "bloom": Microsoft's Windows 11 Bloom photo in
// stage/assets/, git-ignored, so it lives on one machine only; when it is missing the Nook picture
// shows instead. The picture is a layer applied once it has loaded (a plain gradient sits under it
// until then); `wallpaperSettled()` lets a capture wait for that.

const wallpaperUrls = (wallpaper: Wallpaper, theme: string): string[] => {
  const nook = new URL(`./wallpapers/nook-${theme}.jpg`, import.meta.url).href;
  return wallpaper === "bloom" ? [new URL(`./assets/wallpaper-${theme}.jpg`, import.meta.url).href, nook] : [nook];
};
const wallpaperLoads = new Map<string, Promise<boolean>>();
const wallpaperKnown = new Map<string, boolean>();
const pending = new Set<Promise<unknown>>();

const loadWallpaper = (url: string): Promise<boolean> => {
  let p = wallpaperLoads.get(url);
  if (!p) {
    p = fetch(url, { method: "HEAD" })
      .then((r) => r.ok && (r.headers.get("content-type") ?? "").startsWith("image/"))
      .then(
        (ok) =>
          !ok
            ? false
            : new Promise<boolean>((done) => {
                const img = new Image();
                img.onload = () => done(true);
                img.onerror = () => done(false);
                img.src = url;
              }),
      )
      .catch(() => false)
      .then((ok) => (wallpaperKnown.set(url, ok), ok));
    wallpaperLoads.set(url, p);
  }
  return p;
};

/** Resolves once the wallpaper picture is shown or known to be missing. */
export const wallpaperSettled = async (): Promise<void> => {
  while (pending.size) await Promise.all([...pending]);
};

/** Shows the first picture of the list that loads; `data-photo` says which ("bloom" or "nook"). */
function applyWallpaper(host: HTMLElement, wallpaper: Wallpaper, theme: string) {
  const el = host.querySelector<HTMLElement>(".wall-photo");
  if (!el) return;
  const urls = wallpaperUrls(wallpaper, theme);
  const show = (url: string) => {
    el.style.backgroundImage = `url("${url}")`;
    host.dataset.photo = url === urls[urls.length - 1] ? "nook" : "bloom";
  };
  const known = urls.find((url) => wallpaperKnown.get(url));
  if (known && urls.slice(0, urls.indexOf(known)).every((url) => wallpaperKnown.get(url) === false)) return show(known);
  const first = async () => {
    for (const url of urls) {
      if (await loadWallpaper(url)) {
        if (el.isConnected) show(url);
        return;
      }
    }
  };
  const p: Promise<void> = first().finally(() => pending.delete(p));
  pending.add(p);
}

// ── Glyphs (24 × 24, gradients in `DEFS`) ────────────────────────────────────

const DEFS = `
<svg class="defs" width="0" height="0" aria-hidden="true"><defs>
  <linearGradient id="gFold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6c85a"/><stop offset="1" stop-color="#e29a2b"/></linearGradient>
  <linearGradient id="gFoldF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#f3b640"/></linearGradient>
  <linearGradient id="gGlobe" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4cc3ff"/><stop offset="1" stop-color="#2f62e8"/></linearGradient>
  <linearGradient id="gCode" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9a7bff"/><stop offset="1" stop-color="#5a3fd6"/></linearGradient>
  <linearGradient id="gMail" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ad0b4"/><stop offset="1" stop-color="#1f8f86"/></linearGradient>
  <linearGradient id="gGear" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b7c0cf"/><stop offset="1" stop-color="#7b8696"/></linearGradient>
  <linearGradient id="gDoc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dfe4ec"/></linearGradient>
  <linearGradient id="gBin" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9f3fb" stop-opacity=".95"/><stop offset="1" stop-color="#a8c4de" stop-opacity=".9"/></linearGradient>
  <linearGradient id="gAccent" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6fb4ff"/><stop offset="1" stop-color="#6a5cf0"/></linearGradient>
</defs></svg>`;

const svg = (body: string, cls = "", box = 24) =>
  `<svg class="g ${cls}" viewBox="0 0 ${box} ${box}" aria-hidden="true">${body}</svg>`;

const GLYPH = {
  folder: svg(
    `<path d="M2.5 6.6a2 2 0 0 1 2-2h4.3l2 2.3h8.7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" fill="url(#gFold)"/>` +
      `<path d="M2.5 10.2a1.7 1.7 0 0 1 1.7-1.7h15.6a1.7 1.7 0 0 1 1.7 1.7V18a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" fill="url(#gFoldF)"/>`,
  ),
  globe: svg(
    `<circle cx="12" cy="12" r="9.5" fill="url(#gGlobe)"/>` +
      `<g fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="1.2" stroke-linecap="round"><ellipse cx="12" cy="12" rx="4" ry="9.5"/><path d="M2.6 12h18.8M4.2 7.2c4.6 1.6 11 1.6 15.6 0M4.2 16.8c4.6-1.6 11-1.6 15.6 0"/></g>`,
  ),
  terminal: svg(
    `<rect x="2.5" y="4" width="19" height="16" rx="3.2" fill="#23262d" stroke="#4a505c" stroke-width="1"/>` +
      `<path d="M6.6 9.4 10.2 12l-3.6 2.6" fill="none" stroke="#7ee0a2" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M12.4 15.2h5" stroke="#cfd4dc" stroke-width="1.7" stroke-linecap="round"/>`,
  ),
  code: svg(
    `<rect x="2.5" y="3" width="19" height="18" rx="4.5" fill="url(#gCode)"/>` +
      `<g fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.4 8.6 6 12l3.4 3.4M14.6 8.6 18 12l-3.4 3.4"/><path d="m13 7.6-2 8.8" stroke-opacity=".7"/></g>`,
  ),
  mail: svg(
    `<rect x="2.5" y="5" width="19" height="14" rx="3" fill="url(#gMail)"/>` +
      `<path d="m4 7.6 8 5.6 8-5.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  gear: svg(
    `<g fill="url(#gGear)">${[0, 45, 90, 135].map((a) => `<rect x="10.2" y="2.4" width="3.6" height="19.2" rx="1.4" transform="rotate(${a} 12 12)"/>`).join("")}<circle cx="12" cy="12" r="7"/></g>` +
      `<circle cx="12" cy="12" r="3" fill="#4f5866"/>`,
  ),
  doc: svg(
    `<path d="M6 2.5h8l5 5V20a1.7 1.7 0 0 1-1.7 1.7H6A1.7 1.7 0 0 1 4.3 20V4.2A1.7 1.7 0 0 1 6 2.5z" fill="url(#gDoc)" stroke="#aab3c2" stroke-width=".8"/>` +
      `<path d="M14 2.5v4a1.2 1.2 0 0 0 1.2 1.2h3.8z" fill="#c3cbd8"/>` +
      `<path d="M7.6 12h8.8M7.6 15h8.8M7.6 18h5.4" stroke="#8d97a8" stroke-width="1.2" stroke-linecap="round"/>`,
  ),
  pdf: svg(
    `<path d="M6 2.5h8l5 5V20a1.7 1.7 0 0 1-1.7 1.7H6A1.7 1.7 0 0 1 4.3 20V4.2A1.7 1.7 0 0 1 6 2.5z" fill="url(#gDoc)" stroke="#aab3c2" stroke-width=".8"/>` +
      `<path d="M14 2.5v4a1.2 1.2 0 0 0 1.2 1.2h3.8z" fill="#c3cbd8"/>` +
      `<rect x="6.6" y="12" width="10.8" height="5.4" rx="1.2" fill="#e5484d"/>`,
  ),
  bin: svg(
    `<path d="M5 6.6h14l-1.2 13a1.8 1.8 0 0 1-1.8 1.6H8a1.8 1.8 0 0 1-1.8-1.6z" fill="url(#gBin)" stroke="#8fa9c2" stroke-width=".9"/>` +
      `<path d="M3.6 6.6h16.8M9.4 6.6V4.9a1 1 0 0 1 1-1h3.2a1 1 0 0 1 1 1v1.7" fill="none" stroke="#8fa9c2" stroke-width="1.3" stroke-linecap="round"/>` +
      `<path d="M9.6 10v8M12 10v8M14.4 10v8" stroke="#8fa9c2" stroke-width=".9" stroke-linecap="round"/>`,
  ),
  start: svg(`<g fill="url(#gAccent)"><circle cx="7.6" cy="7.6" r="3.1"/><circle cx="16.4" cy="7.6" r="3.1"/><circle cx="7.6" cy="16.4" r="3.1"/><circle cx="16.4" cy="16.4" r="3.1"/></g>`),
  search: svg(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/></g>`),
  wifi: svg(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 9.2a13 13 0 0 1 18 0M6 12.6a8.6 8.6 0 0 1 12 0M9 16a4.2 4.2 0 0 1 6 0"/></g><circle cx="12" cy="19" r="1.4" fill="currentColor"/>`),
  volume: svg(`<path d="M4 9.5h3.6L12 5.8v12.4l-4.4-3.7H4z" fill="currentColor"/><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M15.4 9a4.2 4.2 0 0 1 0 6M18 6.6a7.6 7.6 0 0 1 0 10.8"/></g>`),
  battery: svg(`<rect x="2.5" y="7.5" width="16" height="9" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="4.6" y="9.6" width="9.6" height="4.8" rx="1" fill="currentColor"/><path d="M20.4 10.4v3.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`),
  chevron: svg(`<path d="m6 15 6-6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`),
  back: svg(`<path d="M19 12H5m6-6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`),
  forward: svg(`<path d="M5 12h14m-6-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`),
  reload: svg(`<path d="M19 12a7 7 0 1 1-2.1-5M19 4.5V8h-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`),
  lock: svg(`<rect x="5.5" y="10.5" width="13" height="9" rx="2.2" fill="currentColor"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>`),
  plus: svg(`<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`),
  x: svg(`<path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`),
  files: svg(`<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 3.5h7l4 4V17a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 17V5A1.5 1.5 0 0 1 8 3.5z"/><path d="M4 7.5V19a1.5 1.5 0 0 0 1.5 1.5H15"/></g>`),
  branch: svg(`<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 8v8M17 11c0 3-3 3-8.5 5"/></g>`),
  bug: svg(`<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="8" y="7" width="8" height="12" rx="4"/><path d="M12 7V4M5 11h3M16 11h3M5 17h3M16 17h3"/></g>`),
  blocks: svg(`<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="4" width="7" height="7" rx="1.4"/><rect x="4" y="13" width="7" height="7" rx="1.4"/><rect x="13" y="13" width="7" height="7" rx="1.4"/></g>`),
  chevR: svg(`<path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
  chevD: svg(`<path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
};

const controls = `<div class="wc"><i><svg viewBox="0 0 10 10"><path d="M0 5.5h10" stroke="currentColor"/></svg></i><i><svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" rx="1.2" fill="none" stroke="currentColor"/></svg></i><i><svg viewBox="0 0 10 10"><path d="m0 0 10 10M10 0 0 10" stroke="currentColor"/></svg></i></div>`;

// ── Desktop icons, taskbar ───────────────────────────────────────────────────

const ICONS: [keyof typeof GLYPH, string][] = [
  ["bin", "Recycle Bin"],
  ["folder", "Projects"],
  ["doc", "Notes"],
  ["folder", "Screenshots"],
  ["pdf", "Invoice.pdf"],
];

const APPS: { glyph: keyof typeof GLYPH; scene?: string; title: string }[] = [
  { glyph: "folder", title: "Files" },
  { glyph: "globe", scene: "browser", title: "Browser" },
  { glyph: "terminal", scene: "terminal", title: "Terminal" },
  { glyph: "code", scene: "editor", title: "Editor" },
  { glyph: "mail", title: "Mail" },
  { glyph: "gear", title: "Settings" },
];

const taskbar = (o: StageOptions) => `
<div class="taskbar">
  <div class="tb-left"><span class="tb-widget"><i></i><b>18°</b></span></div>
  <div class="tb-mid">
    <span class="tb-tile tb-start">${GLYPH.start}</span>
    <span class="tb-search">${GLYPH.search}<em>Search</em></span>
    ${APPS.map((a) => `<span class="tb-tile${a.scene === o.scene ? " on" : ""}">${GLYPH[a.glyph]}</span>`).join("")}
  </div>
  <div class="tb-right">
    <span class="tb-ico">${GLYPH.chevron}</span>
    <span class="tb-sys">${GLYPH.wifi}${GLYPH.volume}${GLYPH.battery}</span>
    <span class="tb-clock"><b>${esc(o.time)}</b><b>${esc(o.date)}</b></span>
  </div>
</div>`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ── Scenes ───────────────────────────────────────────────────────────────────

const bar = (w: number) => `<i class="ln" style="width:${w}%"></i>`;

const browser = () => {
  const tabs: [string, string][] = [
    ["Getting started", "#4c8dff"], ["Release notes", "#f0a23b"], ["Pull request #214", "#46b97a"],
    ["Design review", "#a26bf2"], ["Inbox (3)", "#e8636c"], ["Weekly planning", "#34b6d6"],
  ];
  return `
<div class="win browser max">
  <div class="b-tabs">
    ${tabs.map(([t, c], i) => `<span class="b-tab${i === 1 ? " on" : ""}"><i class="fav" style="background:${c}"></i><em>${t}</em>${GLYPH.x}</span>`).join("")}
    <span class="b-new">${GLYPH.plus}</span>
    ${controls}
  </div>
  <div class="b-bar">
    <span class="b-btn">${GLYPH.back}</span><span class="b-btn dim">${GLYPH.forward}</span><span class="b-btn">${GLYPH.reload}</span>
    <span class="b-url">${GLYPH.lock}<em>docs.example.dev/guide/release-notes</em></span>
    <span class="b-btn">${GLYPH.blocks}</span><i class="b-avatar"></i>
  </div>
  <div class="b-page">
    <div class="p-nav"><i class="p-logo"></i><b>Fieldnotes</b><span>Product</span><span>Guides</span><span>Pricing</span><span>Changelog</span><i class="p-btn">Sign in</i></div>
    <div class="p-hero">
      <div class="p-copy">
        <small>Release notes</small>
        <h1>What shipped this week</h1>
        <p>A faster editor, calmer notifications and a tidier settings page. Here is everything that changed, and why.</p>
        <div class="p-cta"><i class="p-btn solid">Read the notes</i><i class="p-btn">Subscribe</i></div>
      </div>
      <div class="p-art"><i></i><i></i><i></i></div>
    </div>
    <div class="p-cards">
      ${["Faster editor", "Calmer alerts", "Tidy settings"].map((t, i) => `<div class="p-card"><i class="p-ic c${i}"></i><b>${t}</b>${bar(92)}${bar(78)}${bar(55)}</div>`).join("")}
    </div>
  </div>
</div>`;
};

const KW = (s: string) => `<k>${s}</k>`;
const code = [
  `<c>// Fold the island away after a quiet minute.</c>`,
  `${KW("import")} { State } ${KW("from")} <s>"./state"</s>;`,
  `${KW("import")} { Sound } ${KW("from")} <s>"./sound"</s>;`,
  ``,
  `${KW("const")} <v>QUIET_MS</v> = <n>60_000</n>;`,
  ``,
  `${KW("export function")} <f>settle</f>(<v>island</v>: <t>Island</t>) {`,
  `  ${KW("const")} <v>idle</v> = Date.<f>now</f>() - State.<v>heardAt</v>;`,
  `  ${KW("if")} (<v>idle</v> &lt; <v>QUIET_MS</v>) ${KW("return")};`,
  ``,
  `  ${KW("if")} (State.<v>isPinned</v>) {`,
  `    <c>// A pinned island stays where it is.</c>`,
  `    ${KW("return")};`,
  `  }`,
  `  island.<f>collapse</f>();`,
  `  Sound.<f>play</f>(<s>"fold"</s>);`,
  `}`,
  ``,
  `${KW("export function")} <f>wake</f>(<v>island</v>: <t>Island</t>, <v>view</v> = <s>"overview"</s>) {`,
  `  island.<f>alert</f>(<v>view</v>);`,
  `  State.<f>notify</f>();`,
  `}`,
  ``,
  `${KW("export const")} <v>MODES</v> = [<s>"hidden"</s>, <s>"compact"</s>, <s>"expanded"</s>] ${KW("as const")};`,
  ``,
];

const editor = () => `
<div class="win editor max">
  <div class="e-title">
    <i class="e-mark"></i>
    <span class="e-menu"><em>File</em><em>Edit</em><em>Selection</em><em>View</em><em>Go</em><em>Run</em><em>Help</em></span>
    <span class="e-search">${GLYPH.search}<em>nook</em></span>
    ${controls}
  </div>
  <div class="e-body">
    <div class="e-act">${GLYPH.files}${GLYPH.search}${GLYPH.branch}${GLYPH.bug}${GLYPH.blocks}<i></i></div>
    <div class="e-side">
      <small>EXPLORER</small>
      <div class="e-tree">
        <p class="open">${GLYPH.chevD}<b>nook</b></p>
        <p class="d1">${GLYPH.chevD}<b>src</b></p>
        <p class="d2">${GLYPH.chevR}<b>core</b></p>
        <p class="d2 open">${GLYPH.chevD}<b>island</b></p>
        <p class="d3"><u>ts</u><b>fsm.ts</b></p>
        <p class="d3 sel"><u>ts</u><b>settle.ts</b></p>
        <p class="d3"><u>ts</u><b>hooks.ts</b></p>
        <p class="d3"><u>ts</u><b>island.ts</b></p>
        <p class="d2">${GLYPH.chevR}<b>views</b></p>
        <p class="d1">${GLYPH.chevR}<b>scripts</b></p>
        <p class="d1"><u>{}</u><b>package.json</b></p>
        <p class="d1"><u>#</u><b>README.md</b></p>
      </div>
    </div>
    <div class="e-main">
      <div class="e-tabs"><span><u>ts</u>fsm.ts</span><span class="on"><u>ts</u>settle.ts</span><span><u>ts</u>hooks.ts</span></div>
      <div class="e-crumbs">src ${GLYPH.chevR} island ${GLYPH.chevR} settle.ts</div>
      <div class="e-code">
        ${code.map((l, i) => `<div class="cl"><em>${i + 1}</em><span>${l || "&nbsp;"}</span></div>`).join("")}
        <div class="e-mini">${Array.from({ length: 26 }, (_, i) => `<i style="width:${20 + ((i * 37) % 60)}%"></i>`).join("")}</div>
      </div>
    </div>
  </div>
  <div class="e-status"><span>main</span><span>0 errors</span><em></em><span>Ln 12, Col 5</span><span>UTF-8</span><span>TypeScript</span></div>
</div>`;

const terminal = () => `
<div class="win terminal">
  <div class="t-title"><span class="t-tab">${GLYPH.terminal}<em>PowerShell</em>${GLYPH.x}</span><span class="t-add">${GLYPH.plus}</span>${controls}</div>
  <div class="t-body">
<p><b class="pw">PS</b> C:\\Users\\nook\\code\\nook&gt; <b class="cm">git status -sb</b></p>
<p class="o">## main...origin/main</p>
<p class="o"> M windows/src/island/settle.ts</p>
<p class="o"> M windows/src/island/hooks.ts</p>
<p><b class="pw">PS</b> C:\\Users\\nook\\code\\nook&gt; <b class="cm">npx tsc --noEmit</b></p>
<p class="o ok">Found 0 errors.</p>
<p><b class="pw">PS</b> C:\\Users\\nook\\code\\nook&gt; <b class="cm">cargo test --workspace</b></p>
<p class="o">   Compiling nook v0.2.1 (C:\\Users\\nook\\code\\nook\\windows\\src-tauri)</p>
<p class="o">    Finished test profile [unoptimized + debuginfo] target(s) in 14.20s</p>
<p class="o">     Running unittests src\\lib.rs</p>
<p class="o">running 41 tests</p>
<p class="o ok">test result: ok. 41 passed; 0 failed; 0 ignored</p>
<p><b class="pw">PS</b> C:\\Users\\nook\\code\\nook&gt; <b class="cm">claude</b><i class="caret"></i></p>
  </div>
</div>`;

const desktopIcons = () =>
  `<div class="icons">${ICONS.map(([g, l]) => `<div class="di">${GLYPH[g]}<span>${l}</span></div>`).join("")}</div>`;

/** Draws the stage into `host`: wallpaper, desktop icons, the scene's window, the taskbar. */
export function renderStage(host: HTMLElement, o: StageOptions) {
  host.dataset.theme = o.theme;
  host.dataset.scene = o.scene;
  host.dataset.taskbar = o.taskbar;
  host.dataset.wallpaper = o.wallpaper;
  delete host.dataset.photo;
  if (o.scene === "none") {
    host.innerHTML = "";
    return;
  }
  const scene = o.scene === "browser" ? browser() : o.scene === "editor" ? editor() : o.scene === "terminal" ? terminal() : "";
  host.innerHTML =
    DEFS + `<div class="wall"><div class="wall-photo"></div></div>` + desktopIcons() + scene + (o.taskbar === "hidden" ? "" : taskbar(o));
  applyWallpaper(host, o.wallpaper, o.theme);
}

