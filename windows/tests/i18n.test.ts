import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";
import { DICTIONARIES, ENGLISH, effectiveLanguage, t, translatedValue } from "../src/core/i18n.ts";
import { LOOK_RESET_FIELDS, lookAtDefaults, lookResetPatch } from "../src/settings/reset.ts";

test("English is the default and explicit language choices stay selected", () => {
  assert.equal(DEFAULT_SETTINGS.language, "en");
  assert.equal(effectiveLanguage("en", "uk"), "en");
  assert.equal(effectiveLanguage("uk", "en"), "uk");
  assert.equal(t("settings.look.title"), ENGLISH["settings.look.title"]);
});

test("all language dictionaries cover the same translation keys", () => {
  const expected = Object.keys(ENGLISH).sort();
  for (const [language, dictionary] of Object.entries(DICTIONARIES)) {
    assert.deepEqual(Object.keys(dictionary).sort(), expected, `${language} dictionary`);
  }
});

test("missing translations use the English value instead of a key or blank", () => {
  assert.equal(translatedValue("settings.language.heading", {}), ENGLISH["settings.language.heading"]);
  assert.equal(translatedValue("settings.language.heading", { "settings.language.heading": "" }), ENGLISH["settings.language.heading"]);
  assert.notEqual(translatedValue("settings.language.heading", {}), "settings.language.heading");
});

test("explicit language wins while system selection uses Rust's boot language", () => {
  assert.equal(effectiveLanguage("en", "uk"), "en");
  assert.equal(effectiveLanguage("system", "uk"), "uk");
  assert.equal(effectiveLanguage("uk", "pl"), "uk");
  assert.equal(effectiveLanguage("system", "pl"), "pl");
  assert.equal(effectiveLanguage("system", "en"), "en");
  assert.equal(effectiveLanguage("ru", "en"), "ru");
  assert.equal(t("settings.look.title", effectiveLanguage("system", "uk")), "Вигляд і кольори");
  assert.equal(t("settings.look.title", effectiveLanguage("system", "pl")), "Wygląd i kolory");
  assert.equal(t("settings.look.title", effectiveLanguage("system", "en")), "Look and colours");
});

test("changing to system keeps the persisted preference and switches to Rust boot language", () => {
  const english = { ...DEFAULT_SETTINGS, language: "en" as const };
  const switchedFromEnglish = { ...english, language: "system" as const };
  assert.equal(effectiveLanguage(english.language, "uk"), "en");
  assert.equal(switchedFromEnglish.language, "system");
  assert.equal(effectiveLanguage(switchedFromEnglish.language, "uk"), "uk");

  const ukrainian = { ...DEFAULT_SETTINGS, language: "uk" as const };
  const switchedFromUkrainian = { ...ukrainian, language: "system" as const };
  assert.equal(effectiveLanguage(ukrainian.language, "pl"), "uk");
  assert.equal(switchedFromUkrainian.language, "system");
  assert.equal(effectiveLanguage(switchedFromUkrainian.language, "pl"), "pl");
  assert.equal(JSON.parse(JSON.stringify(switchedFromUkrainian)).language, "system");
});

test("language dictionaries return selected translations and Settings preserves language through JSON serialization", () => {
  assert.equal(t("settings.look.title", "uk"), "Вигляд і кольори");
  assert.equal(t("settings.look.title", "pl"), "Wygląd i kolory");
  assert.equal(t("settings.look.title", "ru"), "Вид и цвета");
  const restored = JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, language: "pl" }));
  assert.equal(restored.language, "pl");
});

test("resetting Look restores appearance defaults without changing Ukrainian language preference", () => {
  const selected: typeof DEFAULT_SETTINGS = {
    ...DEFAULT_SETTINGS,
    language: "uk",
    botTheme: "sky",
    playfulReactions: false,
    theme: "dark",
    reduceMotion: "on",
  };
  const reset = { ...selected, ...lookResetPatch(DEFAULT_SETTINGS) };
  assert.equal(reset.language, "uk");
  assert.equal(lookAtDefaults(selected, DEFAULT_SETTINGS), false);
  assert.equal(lookAtDefaults(reset, DEFAULT_SETTINGS), true);
  assert.deepEqual(LOOK_RESET_FIELDS.map((key) => reset[key]), LOOK_RESET_FIELDS.map((key) => DEFAULT_SETTINGS[key]));
});
