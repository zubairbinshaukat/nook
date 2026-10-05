// The stage's tooling: a left sidebar, hidden by default, that overlays the page
// (it never changes the stage's layout) and a small button to open it. Every
// control writes the URL (history.replaceState), so the state is a link; the
// stage's own keys apply live, any other key reloads the page. Preview only.

import { LIVE_KEYS, type StageOptions } from "./options";
import { PRESET_GROUPS, SCENARIO_KEYS } from "./presets";

type Changes = Record<string, string | null>;
const live = new Set<string>(LIVE_KEYS);

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "", attrs: Record<string, string> = {}) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

export interface SidebarHost {
  /** The stage's keys changed: parse them again and redraw. */
  onLive(): void;
}

export function mountSidebar(initial: StageOptions, host: SidebarHost) {
  const q = () => new URLSearchParams(location.search);
  const get = (key: string) => q().get(key);

  /** Writes the URL; the page follows live when only the stage's own keys changed, by a reload otherwise. */
  const commit = (changes: Changes, clear: readonly string[] = []) => {
    const p = q();
    for (const k of clear) p.delete(k);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === "") p.delete(k);
      else p.set(k, v);
    }
    // The old names, `zoom` and `light`, give way to the new ones.
    if ("scale" in changes) p.delete("zoom");
    if ("theme" in changes) {
      if (p.has("light") && !p.has("theme")) p.set("theme", "dark");
      p.delete("light");
    }
    const next = `${location.pathname}${p.toString() ? `?${p}` : ""}`;
    const before = `${location.pathname}${location.search}`;
    history.replaceState(null, "", next);
    const keys = new Set([...clear, ...Object.keys(changes)]);
    if ([...keys].every((k) => live.has(k))) {
      host.onLive();
      sync();
    } else if (next !== before) location.reload();
  };

  // ── Panel and toggle ──
  const panel = el("aside", "sb", "", { id: "sb", "aria-label": "Stage controls" });
  const toggle = el("button", "sb-toggle", "", { type: "button", "aria-label": "Stage controls (S)", title: "Stage controls (S)" });
  toggle.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 7h10M18 7h2M4 17h2M10 17h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><circle cx="16" cy="7" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="17" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  const isOpen = () => get("ui") != null && get("ui") !== "0" && get("ui") !== "false" && get("ui") !== "off";
  const setOpen = (open: boolean) => commit({ ui: open ? "1" : null });
  toggle.onclick = () => setOpen(!isOpen());

  const head = el("div", "sb-head");
  const close = el("button", "sb-x", "×", { type: "button", "aria-label": "Close" });
  close.onclick = () => setOpen(false);
  head.append(el("b", "", "Screenshot stage"), el("span", "", "Nook preview"), close);
  const scroll = el("div", "sb-scroll");
  panel.append(head, scroll);

  // ── Controls ──
  const syncs: (() => void)[] = [];
  const sync = () => {
    panel.hidden = false;
    document.documentElement.dataset.sb = isOpen() ? "open" : "closed";
    panel.toggleAttribute("inert", !isOpen());
    panel.setAttribute("aria-hidden", String(!isOpen()));
    toggle.hidden = !initial.toggle || ["0", "false", "off"].includes(get("toggle") ?? "");
    for (const s of syncs) s();
  };

  const group = (title: string) => {
    const g = el("section", "sb-group");
    g.append(el("h2", "", title));
    scroll.append(g);
    return g;
  };
  const row = (g: HTMLElement, label: string, ...kids: HTMLElement[]) => {
    const r = el("div", "sb-row");
    r.append(el("label", "", label));
    const body = el("div", "sb-opts");
    body.append(...kids);
    r.append(body);
    g.append(r);
    return r;
  };

  /** One of several, as a row of buttons; the first is the default and is not written in the URL. */
  const seg = (g: HTMLElement, label: string, key: string, options: readonly (readonly [string, string])[]) => {
    const buttons = options.map(([value, text], i) => {
      const b = el("button", "sb-chip", text, { type: "button" });
      b.onclick = () => commit({ [key]: i === 0 ? null : value });
      return [value, b] as const;
    });
    row(g, label, ...buttons.map(([, b]) => b));
    syncs.push(() => {
      const now = get(key) ?? options[0][0];
      const known = options.some(([v]) => v === now);
      for (const [v, b] of buttons) b.classList.toggle("on", known ? v === now : v === options[0][0]);
    });
  };

  const text = (g: HTMLElement, label: string, key: string, placeholder: string, width = "") => {
    const input = el("input", "sb-in", "", { type: "text", placeholder, spellcheck: "false", autocomplete: "off" });
    if (width) input.style.width = width;
    input.onchange = () => commit({ [key]: input.value.trim() || null });
    input.onkeydown = (e) => e.stopPropagation();
    row(g, label, input);
    syncs.push(() => {
      if (document.activeElement !== input) input.value = get(key) ?? "";
    });
  };

  const check = (g: HTMLElement, label: string, key: string, on: string, off: string | null) => {
    const b = el("button", "sb-chip", "", { type: "button" });
    b.onclick = () => commit({ [key]: b.classList.contains("on") ? off : on });
    row(g, label, b);
    syncs.push(() => {
      const v = get(key);
      const active = off === null ? v != null && v !== "0" : v === on;
      b.classList.toggle("on", active);
      b.textContent = active ? "On" : "Off";
    });
  };

  // Scenario
  const scenario = group("Scenario");
  const matches = (preset: string) => {
    const want = new URLSearchParams(preset);
    const have = q();
    for (const k of SCENARIO_KEYS) if ((want.get(k) ?? null) !== (have.get(k) ?? null)) return false;
    return true;
  };
  const chips: [string, HTMLElement][] = [];
  for (const { title, items } of PRESET_GROUPS) {
    const fold = el("details", "sb-fold");
    if (title === "Cards") fold.open = true;
    fold.append(el("summary", "", title));
    const wrap = el("div", "sb-opts sb-wrap");
    for (const it of items) {
      const b = el("button", "sb-chip", it.label, { type: "button" });
      b.onclick = () => commit(Object.fromEntries(new URLSearchParams(it.q)), SCENARIO_KEYS);
      chips.push([it.q, b]);
      wrap.append(b);
    }
    fold.append(wrap);
    scenario.append(fold);
  }
  syncs.push(() => {
    // The first card whose key set is exactly the page's lights; the same scenario in two groups lights both.
    for (const [qs, b] of chips) b.classList.toggle("on", matches(qs));
  });
  scenario.append(el("h3", "", "Any other scenario keys"));
  const raw = el("input", "sb-in wide", "", { type: "text", placeholder: "quiet=5&phantoms=one&ids=missing", spellcheck: "false", autocomplete: "off" });
  raw.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") raw.dispatchEvent(new Event("change"));
  };
  raw.onchange = () => {
    const extra = new URLSearchParams(raw.value.replace(/^[?&]/, ""));
    commit(Object.fromEntries(extra));
  };
  scenario.append(raw);

  // Island
  const island = group("Island");
  seg(island, "Dock", "dock", [["top", "Top"], ["bottom", "Bottom"], ["left", "Left"], ["right", "Right"]]);
  seg(island, "Opens in", "target", [["claude", "Claude app"], ["vscode", "VS Code"], ["cursor", "Cursor"], ["wt", "Terminal"], ["powershell", "PowerShell"], ["cmd", "cmd"], ["none", "Nowhere"]]);
  check(island, "Folded", "fold", "1", null);
  seg(island, "Usage", "usage", [["fresh", "Fresh"], ["warm", "70 %"], ["hot", "95 %"], ["worst", "Used up"], ["none", "None"]]);
  seg(island, "Metrics", "metrics", [["live", "Live"], ["worst", "Worst"], ["wait", "No CPU"], ["off", "Off"]]);
  seg(island, "Motion", "motion", [["full", "Full"], ["reduce", "Reduced"]]);
  seg(island, "Display", "scale", [["1", "100 %"], ["1.25", "125 %"], ["1.5", "150 %"], ["2", "200 %"]]);
  text(island, "Seed", "seed", "1", "70px");

  // Scene
  const scene = group("Scene");
  seg(scene, "Scene", "scene", [["desktop", "Desktop"], ["browser", "Browser"], ["editor", "Editor"], ["terminal", "Terminal"], ["none", "None"]]);
  seg(scene, "Theme", "theme", [["dark", "Dark"], ["light", "Light"]]);
  seg(scene, "Taskbar", "taskbar", [["bottom", "Bottom"], ["top", "Top"], ["hidden", "Hidden"]]);
  seg(scene, "Wallpaper", "wallpaper", [["nook", "Nook"], ["bloom", "Bloom"]]);
  text(scene, "Clock", "time", "10:09", "70px");
  text(scene, "Date", "date", "10/6/2026", "110px");
  text(scene, "Page colour", "bg", "#2a2d34 or transparent", "150px");

  // Capture
  const capture = group("Capture");
  text(capture, "Width", "w", "window", "70px");
  text(capture, "Height", "h", "window", "70px");
  const showToggle = el("button", "sb-chip", "", { type: "button" });
  showToggle.onclick = () => commit({ toggle: get("toggle") === "0" ? null : "0" });
  row(capture, "Corner button", showToggle);
  syncs.push(() => {
    const on = get("toggle") !== "0";
    showToggle.classList.toggle("on", on);
    showToggle.textContent = on ? "Shown" : "Hidden";
  });
  const link = el("input", "sb-in wide", "", { type: "text", readonly: "", spellcheck: "false" });
  link.onfocus = () => link.select();
  link.onkeydown = (e) => e.stopPropagation();
  const copy = (label: string, value: () => string) => {
    const b = el("button", "sb-chip", label, { type: "button" });
    b.onclick = () => {
      const v = value();
      void navigator.clipboard?.writeText(v).then(() => {
        b.textContent = "Copied";
        window.setTimeout(() => (b.textContent = label), 1200);
      });
    };
    return b;
  };
  const shotUrl = () => {
    const p = q();
    p.delete("ui");
    p.delete("toggle");
    p.set("shot", "1");
    return `${location.origin}${location.pathname}?${p}`;
  };
  const w = () => get("w") ?? "1920";
  const h = () => get("h") ?? "1080";
  row(
    capture, "Share",
    copy("Copy link", () => location.href),
    copy("Copy shot link", shotUrl),
    copy("Copy shot command", () => `node scripts/shot.mjs "${shotUrl()}" --size ${w()}x${h()} --out shot.png`),
  );
  const open = el("button", "sb-chip", "Open as a shot", { type: "button" });
  open.onclick = () => window.open(shotUrl(), "_blank");
  row(capture, "Preview", open);
  capture.append(link);
  syncs.push(() => (link.value = location.search));

  document.body.append(panel, toggle);
  sync();

  // The keyboard: S or ` anywhere that is not a field.
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (e.key === "s" || e.key === "S" || e.key === "`" || e.code === "Backquote") {
      e.preventDefault();
      setOpen(!isOpen());
    }
  });
  return { sync };
}
