import assert from "node:assert/strict";
import test from "node:test";

class TestText {
  parentElement: TestElement | null = null;
  data: string;
  constructor(data: string) { this.data = data; }
}

class TestElement {
  children: (TestElement | TestText)[] = [];
  attributes = new Map<string, string>();
  parentElement: TestElement | null = null;
  value = "";
  className = "";
  style = { setProperty() {} };
  classList = { toggle() {}, add() {}, remove() {} };
  listeners = new Map<string, (event: any) => void>();

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === "value") this.value = value;
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(...children: (TestElement | TestText)[]) {
    for (const child of children) {
      child.parentElement = this instanceof TestElement ? this : null;
      this.children.push(child);
    }
  }
  replaceChildren(...children: (TestElement | TestText)[]) { this.children = []; this.append(...children); }
  addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, listener); }
  dispatch(name: string, event: any = {}) { this.listeners.get(name)?.(event); }
  focus() { (globalThis.document as any).activeElement = this; }
  closest(selector: string): TestElement | null {
    if (selector !== "[data-no-l10n]") return null;
    for (let el: TestElement | null = this; el; el = el.parentElement) if (el.attributes.has("data-no-l10n")) return el;
    return null;
  }
  querySelectorAll(selector: string): TestElement[] {
    if (selector !== "*") return [];
    const result: TestElement[] = [];
    const visit = (el: TestElement) => { for (const child of el.children) if (child instanceof TestElement) { result.push(child); visit(child); } };
    visit(this);
    return result;
  }
  get textContent(): string { return this.children.map((child) => child instanceof TestText ? child.data : child.textContent).join(""); }
  set textContent(value: string) { this.replaceChildren(new TestText(value)); }
}

test("localized text and labels update in place while a searched control keeps focus", async () => {
  const global = globalThis as any;
  global.Element = TestElement;
  global.NodeFilter = { SHOW_TEXT: 4 };
  global.document = {
    activeElement: null,
    createElement: () => new TestElement(),
    createTextNode: (value: string) => new TestText(value),
    createTreeWalker(root: TestElement) {
      const nodes: TestText[] = [];
      const visit = (el: TestElement) => { for (const child of el.children) child instanceof TestText ? nodes.push(child) : visit(child); };
      visit(root);
      let index = 0;
      return { nextNode: () => nodes[index++] ?? null };
    },
  };
  const dom = await import("../src/views/dom.ts");
  const copy = await import("../src/core/settings-copy.ts");
  const i18n = await import("../src/core/i18n.ts");
  let language: "en" | "uk" | "pl" | "ru" = "en";
  dom.configureTextLocalization((source) => copy.translateSettingsSource(source, language));

  const results = new TestElement();
  const control = dom.h("button", { type: "button", text: "Play sounds", "aria-label": "Play sounds" }) as unknown as TestElement;
  const updateCheck = dom.h("button", { text: "Check now" }) as unknown as TestElement;
  const updateStatus = dom.h("p", { text: "Not checked yet." }) as unknown as TestElement;
  const queryTitle = dom.h("h1", { text: "Search" }) as unknown as TestElement;
  results.append(queryTitle, control);
  results.append(updateCheck, updateStatus);
  queryTitle.setAttribute("data-no-l10n", "");
  queryTitle.textContent = "“sound”";
  control.focus();
  const textNode = control.children[0];
  for (const locale of ["uk", "pl", "ru"] as const) {
    language = locale;
    dom.refreshTextLocalization(results as unknown as ParentNode);
    assert.equal(control.children[0], textNode, "the text node is updated, not replaced");
    assert.equal(global.document.activeElement, control, "focused control stays focused");
    assert.equal(control.getAttribute("aria-label"), copy.tSettings("Play sounds", locale));
    assert.equal(updateCheck.textContent, copy.tSettings("Check now", locale));
    assert.equal(updateStatus.textContent, copy.tSettings("Not checked yet.", locale));
    assert.equal(queryTitle.textContent, "“sound”", "the open search query is preserved as user input");
  }
  updateCheck.textContent = "Checking…"; // async completion paints with the current source copy
  language = "ru";
  dom.refreshTextLocalization(results as unknown as ParentNode);
  assert.equal(updateCheck.textContent, copy.tSettings("Checking…", "ru"));

  const volumeRow = dom.h("div", {}, dom.h("input", { type: "range", min: "0", max: "100", value: "45", "aria-label": "Volume" }), dom.h("output", { text: i18n.formatPercent(45, language) })) as unknown as TestElement;
  const volumeInput = volumeRow.children[0] as TestElement;
  results.append(volumeRow);
  volumeInput.focus();
  const valueDuringDrag = volumeInput.value;
  language = "ru";
  dom.refreshTextLocalization(results as unknown as ParentNode);
  assert.equal(volumeRow.children[0], volumeInput, "slider input stays in place during a locale refresh");
  assert.equal(volumeInput.value, valueDuringDrag, "the in-progress drag value is preserved");
  assert.equal(global.document.activeElement, volumeInput, "slider focus stays in place");

  const technical = dom.h("kbd", { text: "Ctrl+Shift+P", "data-no-l10n": true }) as unknown as TestElement;
  results.append(technical);
  language = "uk";
  dom.refreshTextLocalization(results as unknown as ParentNode);
  assert.equal(technical.textContent, "Ctrl+Shift+P");
  queryTitle.removeAttribute("data-no-l10n");
  queryTitle.textContent = "Search";
  dom.refreshTextLocalization(results as unknown as ParentNode);
  assert.equal(queryTitle.textContent, copy.tSettings("Search", "uk"));
});
