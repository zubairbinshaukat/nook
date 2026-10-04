// The "Preview controls" strip under a preview page: rows of buttons that put
// the page in each of the states to look at. Preview only — none of this ships.

import { h } from "../../src/views/dom";

export interface Picker<T extends string> {
  el: HTMLElement;
  /** Shows `value` as the one picked, without calling back. */
  set(value: T): void;
}

/** One of several: a row of buttons, the one picked lit. */
export function picker<T extends string>(
  label: string,
  options: readonly (readonly [T, string])[],
  value: T,
  onPick: (value: T) => void,
): Picker<T> {
  const buttons = new Map<T, HTMLElement>();
  const row = h("div", { class: "pvc-opts" });
  const set = (v: T) => {
    for (const [id, button] of buttons) button.classList.toggle("on", id === v);
  };
  for (const [id, text] of options) {
    const button = h("button", {
      class: "pvc-btn",
      text,
      onclick: () => {
        set(id);
        onPick(id);
      },
    });
    buttons.set(id, button);
    row.append(button);
  }
  set(value);
  return { el: h("div", { class: "pvc-row" }, h("span", { class: "pvc-label", text: label }), row), set };
}

/** The strip itself, under its heading. */
export function controls(note: string, ...rows: HTMLElement[]): HTMLElement {
  return h(
    "div",
    { class: "pvc" },
    h("div", { class: "pvc-title" }, h("b", { text: "Preview controls" }), h("span", { text: note })),
    ...rows,
  );
}
