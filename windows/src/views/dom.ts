// Minimal DOM helpers — no framework, as specified.

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | null | undefined | false;

type TextTranslator = (source: string) => string;
let textTranslator: TextTranslator | null = null;
const textSources = new WeakMap<Text, { source: string; rendered: string }>();
const attributeSources = new WeakMap<Element, Map<string, { source: string; rendered: string }>>();

/** Enable source-preserving UI text localization for a standalone window. */
export function configureTextLocalization(translate: TextTranslator): void {
  textTranslator = translate;
}

function setText(el: Element, source: string): void {
  const rendered = textTranslator?.(source) ?? source;
  const text = document.createTextNode(rendered);
  textSources.set(text, { source, rendered });
  el.replaceChildren(text);
}

export function setLocalizedAttribute(el: Element, name: string, source: string): void {
  const sources = attributeSources.get(el) ?? new Map<string, { source: string; rendered: string }>();
  const rendered = textTranslator?.(source) ?? source;
  sources.set(name, { source, rendered });
  attributeSources.set(el, sources);
  el.setAttribute(name, rendered);
}

/** Repaint translated text and attributes without replacing nodes or controls. */
export function refreshTextLocalization(root: ParentNode = document): void {
  if (!textTranslator) return;
  if (root instanceof Element && root.closest("[data-no-l10n]")) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (text.parentElement?.closest("[data-no-l10n]")) continue;
    const prior = textSources.get(text);
    const source = prior && text.data === prior.rendered ? prior.source : text.data;
    const rendered = textTranslator(source);
    textSources.set(text, { source, rendered });
    text.data = rendered;
  }
  const elements: Element[] = root instanceof Element ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
  for (const el of elements) {
    if (el.closest("[data-no-l10n]")) continue;
    for (const [name, prior] of attributeSources.get(el) ?? []) {
      const source = el.getAttribute(name) === prior.rendered ? prior.source : el.getAttribute(name) ?? prior.source;
      const rendered = textTranslator(source);
      attributeSources.get(el)!.set(name, { source, rendered });
      el.setAttribute(name, rendered);
    }
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const rawText = Boolean(attrs["data-no-l10n"]);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "text") {
      if (rawText) el.textContent = String(v);
      else setText(el, String(v));
    }
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "style") el.setAttribute("style", String(v));
    else if (textTranslator && ["title", "aria-label", "placeholder", "aria-description"].includes(k) && !rawText) setLocalizedAttribute(el, k, String(v));
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (typeof c === "string") {
      const source = rawText ? c : textTranslator?.(c) ?? c;
      const text = document.createTextNode(source);
      if (textTranslator && !rawText) textSources.set(text, { source: c, rendered: text.data });
      el.append(text);
    } else el.append(c);
  }
  return el;
}

export function svg(path: string, size = 14, opts: { fill?: string; stroke?: number } = {}): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  if (opts.stroke) {
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", String(opts.stroke));
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
  } else {
    p.setAttribute("fill", opts.fill ?? "currentColor");
  }
  el.append(p);
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Card dot used in every "who" row. */
export function dot(color: string, size = 7): HTMLElement {
  return h("i", {
    class: "dot",
    style: `width:${size}px;height:${size}px;background:${color}`,
  });
}

/**
 * Plays an element's entrance again: the class that carries the animation is
 * taken off and put back, with a look at the layout between the two so the
 * browser sees it go.
 */
export function replay(el: HTMLElement, animation: string) {
  el.classList.remove(animation);
  void el.offsetWidth;
  el.classList.add(animation);
}

/** Same shape as the Swift `timeAgo` computed properties. */
export function timeAgo(value: unknown): string {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  const diff = (Date.now() - date.getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
