import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/settings/settings.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/settings/main.ts", import.meta.url), "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected CSS rule for ${selector}`);
  return match[1];
}

function containerRule(query, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = css.match(new RegExp(`${query}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(block, `expected container query ${query}`);
  const match = block[1].match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected ${selector} inside ${query}`);
  return match[1];
}

test("Settings preview sticks over the pane's responsive top padding", () => {
  const pane = rule(".sp-pane");
  const live = rule(".sp-live");
  assert.match(pane, /--sp-pane-top-padding:\s*22px\s*;/);
  assert.match(pane, /padding:\s*var\(--sp-pane-top-padding\)\s+14px\s+28px\s+24px\s*;/);
  assert.match(live, /top:\s*calc\(0px\s*-\s*var\(--sp-pane-top-padding\)\)\s*;/);

  const narrowPane = containerRule("@container win \\(max-width: 500px\\)", ".sp-pane");
  assert.match(narrowPane, /--sp-pane-top-padding:\s*18px\s*;/);
  assert.match(narrowPane, /padding:\s*var\(--sp-pane-top-padding\)\s+10px\s+24px\s+20px\s*;/);

  const widePane = containerRule("@container win \\(min-width: 700px\\)", ".sp-pane");
  assert.match(widePane, /--sp-pane-top-padding:\s*28px\s*;/);
  assert.match(widePane, /padding:\s*var\(--sp-pane-top-padding\)\s+26px\s+32px\s+36px\s*;/);

  assert.match(rule(".sp-live.side"), /position:\s*static\s*;/);
  assert.match(pane, /overflow-y:\s*auto\s*;/);
  assert.match(rule(".sp-main"), /overflow:\s*hidden\s*;/);
  assert.match(rule("html"), /overflow:\s*hidden\s*;/);
});

test("Settings window has one contained page scroller and a compact language control", () => {
  assert.match(rule("html"), /overflow:\s*hidden\s*;/);
  assert.match(rule(".sp-app"), /grid-template-rows:\s*minmax\(0,\s*1fr\)\s*;/);
  assert.match(rule(".sp-main"), /overflow:\s*hidden\s*;/);
  assert.match(rule(".sp-pane"), /overflow-y:\s*auto\s*;/);

  const languageSelect = rule(".sp-language-select");
  assert.match(languageSelect, /flex:\s*0\s+0\s+auto\s*;/);
  assert.match(languageSelect, /min-height:\s*36px\s*;/);
  assert.doesNotMatch(languageSelect, /flex-basis:\s*\d+px\s*;/);
  assert.match(languageSelect, /appearance:\s*none\s*;/);
  assert.match(rule(".sp-select-wrap > svg"), /right:\s*12px\s*;/);
  assert.match(main, /class: "sp-select-wrap"[^;]*languagePicker, icon\(LUCIDE\.chevronDown/);
});
