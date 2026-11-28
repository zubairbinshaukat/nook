import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

class TestText {
  parentElement: TestElement | null = null;
  data: string;
  constructor(data: string) { this.data = data; }
  get textContent() { return this.data; }
  set textContent(value: string | null) { this.data = value ?? ""; }
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

  const replyRoot = dom.h("div");
  const replyField = dom.h("textarea", {
    placeholder: dom.im("island.reply.placeholder", { name: "Claude Code" }),
    title: dom.im("island.reply.title"),
    "aria-label": dom.im("island.reply.label"),
  }) as unknown as TestElement;
  const liveStatus = dom.h("span", { role: "status" }) as unknown as TestElement;
  dom.setIslandText(liveStatus as unknown as Element, dom.im("island.reply.sending", { name: "Claude Code" }));
  dom.setIslandAttribute(liveStatus as unknown as Element, "title", dom.im("island.reply.how"));
  const sessionStatus = dom.h("span", { text: dom.im("island.session.atRest") }) as unknown as TestElement;
  const permissionChip = dom.h("span", { text: dom.im("island.session.needsPermission") }) as unknown as TestElement;
  const sessionRow = dom.h("div", { title: dom.im("island.session.sessionTitle", {
    tool: "Claude Code", folder: "project", title: "A session", model: "", state: "at rest", subagents: "",
  }) }) as unknown as TestElement;
  replyRoot.append(replyField, liveStatus, sessionStatus, permissionChip, sessionRow);
  for (const locale of ["uk", "pl", "ru"] as const) {
    i18n.setIslandLanguage(locale);
    dom.refreshIslandLocalization(replyRoot as unknown as ParentNode);
    assert.equal(replyField.getAttribute("placeholder"), i18n.tIsland("island.reply.placeholder", { name: "Claude Code" }, locale));
    assert.equal(replyField.getAttribute("title"), i18n.tIsland("island.reply.title", {}, locale));
    assert.equal(replyField.getAttribute("aria-label"), i18n.tIsland("island.reply.label", {}, locale));
    assert.equal(liveStatus.textContent, i18n.tIsland("island.reply.sending", { name: "Claude Code" }, locale));
    assert.equal(liveStatus.getAttribute("title"), i18n.tIsland("island.reply.how", {}, locale));
    assert.equal(sessionStatus.textContent, i18n.tIsland("island.session.atRest", {}, locale));
    assert.equal(permissionChip.textContent, i18n.tIsland("island.session.needsPermission", {}, locale));
    assert.equal(sessionRow.getAttribute("title"), i18n.tIsland("island.session.sessionTitle", {
      tool: "Claude Code", folder: "project", title: "A session", model: "", state: "at rest", subagents: "",
    }, locale));
    for (const value of [replyField.getAttribute("placeholder"), replyField.getAttribute("title"), replyField.getAttribute("aria-label"), liveStatus.textContent, sessionStatus.textContent, permissionChip.textContent]) {
      assert.doesNotMatch(value ?? "", /^island\./, "no translation key is rendered as visible copy");
    }
  }

  const shelfRoot = dom.h("div") as unknown as TestElement;
  const shelfName = dom.h("b", { text: dom.im("island.widget.timer") }) as unknown as TestElement;
  const timerStatus = dom.h("span") as unknown as TestElement;
  dom.setIslandText(timerStatus as unknown as Element, dom.im("island.widget.timerSmallRunning", { time: "14:59" }));
  const todoEmpty = dom.h("span", { text: dom.im("island.widget.todoEmpty") }) as unknown as TestElement;
  const reminderChoice = dom.h("option", { text: dom.im("island.widget.reminderIn1h") }) as unknown as TestElement;
  const mediaControl = dom.h("button", {
    title: dom.im("island.widget.mediaPlayPause"), "aria-label": dom.im("island.widget.mediaPlayOrPause"),
  }) as unknown as TestElement;
  const cameraError = dom.h("p", { text: dom.im("island.widget.cameraErrorHelp") }) as unknown as TestElement;
  const projectControl = dom.h("button", {
    title: dom.im("island.widget.projectsOpenNamedCode", { project: "C:\\work\\demo" }),
  }) as unknown as TestElement;
  const userTodo = dom.h("span", { text: "Buy tea" }) as unknown as TestElement;
  const userReminder = dom.h("span", { text: "Call Mum" }) as unknown as TestElement;
  const mediaTitle = dom.h("span", { text: "User's track title" }) as unknown as TestElement;
  const projectName = dom.h("span", { text: "My project" }) as unknown as TestElement;
  shelfRoot.append(shelfName, timerStatus, todoEmpty, reminderChoice, mediaControl, cameraError, projectControl,
    userTodo, userReminder, mediaTitle, projectName);
  const shelfCopy = () => [shelfName.textContent, timerStatus.textContent, todoEmpty.textContent,
    reminderChoice.textContent, mediaControl.getAttribute("title"), mediaControl.getAttribute("aria-label"),
    cameraError.textContent, projectControl.getAttribute("title")];
  const shelfStates = new Map<string, string[]>();
  for (const locale of ["en", "uk", "pl", "ru", "en"] as const) {
    i18n.setIslandLanguage(locale);
    dom.refreshIslandLocalization(shelfRoot as unknown as ParentNode);
    shelfStates.set(locale + shelfStates.size, shelfCopy());
    for (const value of shelfCopy()) assert.doesNotMatch(value ?? "", /^island\./, "Shelf never renders a raw translation key");
    assert.equal(shelfName.textContent, i18n.tIsland("island.widget.timer", {}, locale));
    assert.equal(timerStatus.textContent, i18n.tIsland("island.widget.timerSmallRunning", { time: "14:59" }, locale));
    assert.equal(todoEmpty.textContent, i18n.tIsland("island.widget.todoEmpty", {}, locale));
    assert.equal(reminderChoice.textContent, i18n.tIsland("island.widget.reminderIn1h", {}, locale));
    assert.equal(mediaControl.getAttribute("title"), i18n.tIsland("island.widget.mediaPlayPause", {}, locale));
    assert.equal(mediaControl.getAttribute("aria-label"), i18n.tIsland("island.widget.mediaPlayOrPause", {}, locale));
    assert.equal(cameraError.textContent, i18n.tIsland("island.widget.cameraErrorHelp", {}, locale));
    assert.equal(projectControl.getAttribute("title"), i18n.tIsland("island.widget.projectsOpenNamedCode", { project: "C:\\work\\demo" }, locale));
  }
  assert.deepEqual([userTodo.textContent, userReminder.textContent, mediaTitle.textContent, projectName.textContent],
    ["Buy tea", "Call Mum", "User's track title", "My project"], "user content is preserved across locale changes");
  assert.equal(shelfStates.size, 5, "the Shelf paths were refreshed EN → UK → PL → RU → EN");

  // Settings can detach a widget while the language changes. The detached
  // node must be repainted immediately before Shelf reinserts it.
  i18n.setIslandLanguage("en");
  const disabledWidget = dom.h("div", {}, dom.h("span", { text: dom.im("island.widget.timer") })) as unknown as TestElement;
  assert.equal(disabledWidget.textContent, "Timer");
  i18n.setIslandLanguage("uk");
  dom.refreshIslandLocalization(shelfRoot as unknown as ParentNode);
  assert.equal(disabledWidget.textContent, "Timer", "a disabled detached widget is not refreshed with the rest of the Island");
  dom.refreshIslandLocalization(disabledWidget as unknown as ParentNode);
  shelfRoot.append(disabledWidget);
  assert.equal(disabledWidget.textContent, "Таймер", "the widget is localized before it reappears after being enabled");
  const shelfSource = readFileSync(new URL("../src/views/shelf.ts", import.meta.url), "utf8");
  assert.match(shelfSource, /refreshIslandLocalization\(small\);\s*row\.append\(small\)/,
    "Shelf refreshes the retained small widget just before reinsertion");

  // Replacing a translated tooltip with user or path data must remove its
  // source-map entry so the next language refresh cannot restore stale copy.
  dom.setIslandAttribute(mediaControl as unknown as Element, "title", dom.im("island.widget.mediaPlayPause"));
  i18n.setIslandLanguage("pl");
  dom.refreshIslandLocalization(shelfRoot as unknown as ParentNode);
  dom.clearIslandAttribute(mediaControl as unknown as Element, "title");
  mediaControl.setAttribute("title", "C:\\work\\project");
  dom.refreshIslandLocalization(shelfRoot as unknown as ParentNode);
  assert.equal(mediaControl.getAttribute("title"), "C:\\work\\project", "replaced tooltips stay as user/path values after locale refresh");

  const tooltipRoot = dom.h("div") as unknown as TestElement;
  const removedTitle = dom.h("button", {
    title: dom.im("island.status.needsDecision"),
    "aria-label": dom.im("island.session.needsDecision"),
  }) as unknown as TestElement;
  const headingNode = dom.h("b", {
    title: dom.im("island.session.sessionTitle", {
      tool: "Claude Code", folder: "old", title: "old", model: "", state: "old", subagents: "",
    }),
  }, "Project") as unknown as TestElement;
  tooltipRoot.append(removedTitle, headingNode);
  const retainedChild = headingNode.children[0];
  for (const locale of ["en", "uk", "pl", "ru"] as const) {
    i18n.setIslandLanguage(locale);
    dom.refreshIslandLocalization(tooltipRoot as unknown as ParentNode);
    assert.equal(removedTitle.getAttribute("title"), i18n.tIsland("island.status.needsDecision", {}, locale));
    assert.equal(removedTitle.getAttribute("aria-label"), i18n.tIsland("island.session.needsDecision", {}, locale));
  }
  dom.clearIslandAttribute(removedTitle as unknown as Element, "title");
  const heading = "Claude Code · project";
  dom.clearIslandAttribute(headingNode as unknown as Element, "title");
  headingNode.setAttribute("title", heading);
  for (const locale of ["en", "uk", "pl", "ru"] as const) {
    i18n.setIslandLanguage(locale);
    dom.refreshIslandLocalization(tooltipRoot as unknown as ParentNode);
    assert.equal(removedTitle.getAttribute("title"), null, `${locale} refresh does not restore an intentionally removed tooltip`);
    assert.equal(removedTitle.getAttribute("aria-label"), i18n.tIsland("island.session.needsDecision", {}, locale), "unrelated localized attributes continue to update");
    assert.equal(headingNode.getAttribute("title"), heading, `${locale} refresh preserves the dynamic session heading`);
    assert.equal(headingNode.children[0], retainedChild, "replacing the title leaves DOM children intact");
  }
  const homeSource = readFileSync(new URL("../src/views/home.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/views/session.ts", import.meta.url), "utf8");
  assert.match(homeSource, /else\s+clearIslandAttribute\(cell\.el,\s*"title"\)/, "home clears the tracked source when the decision tooltip disappears");
  assert.match(sessionSource, /clearIslandAttribute\(name,\s*"title"\);\s*name\.title\s*=\s*heading/, "session clears the tracked source before writing its dynamic heading");
  queryTitle.removeAttribute("data-no-l10n");
  queryTitle.textContent = "Search";
  dom.refreshTextLocalization(results as unknown as ParentNode);
  assert.equal(queryTitle.textContent, copy.tSettings("Search", "uk"));
});
