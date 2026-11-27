import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";
import { DICTIONARIES, ENGLISH, effectiveLanguage, t, translatedValue } from "../src/core/i18n.ts";
import { LOOK_RESET_FIELDS, lookAtDefaults, lookResetPatch } from "../src/settings/reset.ts";
import { searchResultCount, settingsCopyKeys, settingsSearchMatches, settingsSearchWords, tSettings, translateSettingsSource } from "../src/core/settings-copy.ts";
import { formatDateTime, formatDurationSeconds, formatNumber, formatPercent, pluralCategory } from "../src/core/i18n.ts";
import { applySettingsEchoEffects, changedSettingKeys, composeShortcutRefusal, createLocalizedPainter, formatSettingsDuration, shortcutProblemText } from "../src/settings/settings-behavior.ts";

test("English is the default and explicit language choices stay selected", () => {
  assert.equal(DEFAULT_SETTINGS.language, "en");
  assert.equal(effectiveLanguage("en", "uk"), "en");
  assert.equal(effectiveLanguage("uk", "en"), "uk");
  assert.equal(tSettings("Look and colours"), "Look and colours");
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
  assert.equal(tSettings("Look and colours", effectiveLanguage("system", "uk")), "Вигляд і кольори");
  assert.equal(tSettings("Look and colours", effectiveLanguage("system", "pl")), "Wygląd i kolory");
  assert.equal(tSettings("Look and colours", effectiveLanguage("system", "en")), "Look and colours");
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
  assert.equal(tSettings("Look and colours", "uk"), "Вигляд і кольори");
  assert.equal(tSettings("Look and colours", "pl"), "Wygląd i kolory");
  assert.equal(tSettings("Look and colours", "ru"), "Вид и цвета");
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

test("Settings copy has a complete, non-empty translation tuple for every source", () => {
  const keys = settingsCopyKeys();
  assert.ok(keys.length > 300);
  assert.equal(new Set(keys).size, keys.length);
  for (const dead of ["One min", "{count} setting found.", "{count} settings found."]) assert.ok(!keys.includes(dead as never), `${dead} is removed`);
  for (const key of keys) {
    for (const language of ["uk", "pl", "ru"] as const) {
      const translated = tSettings(key, language);
      assert.ok(translated.trim(), `${language}: ${key}`);
    }
  }
});

test("Settings source translation handles templates and leaves user text intact", () => {
  assert.equal(translateSettingsSource("Changes to settings.json", "uk"), "Зміни у файлі settings.json");
  assert.equal(translateSettingsSource("Move Shelf. Use the up and down arrows.", "pl"), "Move Shelf. Use the up and down arrows.");
  assert.equal(translateSettingsSource("Some Codex events are missing from Nook's hooks, so sessions may not be fully reported.", "ru"), "В хуках Nook отсутствуют некоторые события Codex, поэтому данные о сеансах могут быть неполными.");
  assert.equal(translateSettingsSource("You have version 0.2.3", "uk"), "У вас версія 0.2.3");
  assert.equal(translateSettingsSource("Nook prints no status line of its own. ? for shortcuts", "pl"), "Nook nie tworzy własnego wiersza stanu. ? for shortcuts");
  assert.equal(translateSettingsSource("In Island. Open it.", "uk"), "Розділ «Острівець». Відкрити.");
  assert.equal(translateSettingsSource("Portfolio: zubyr.dev. Opens in your browser.", "pl"), "Portfolio: zubyr.dev. Otwiera się w przeglądarce.");
  assert.equal(translateSettingsSource("C:\\Users\\someone\\settings.json", "ru"), "C:\\Users\\someone\\settings.json");
  assert.equal(translateSettingsSource("unrecognized content", "uk"), "unrecognized content");
  assert.equal(translateSettingsSource("Show me everything", "uk"), "Show me everything");
  assert.equal(translateSettingsSource("My notes: on", "pl"), "My notes: on");
  assert.equal(translateSettingsSource("Ctrl+Shift+P", "ru"), "Ctrl+Shift+P");
  assert.equal(translateSettingsSource("Українська", "pl"), "Українська");
  assert.notEqual(tSettings("Setup", "uk"), tSettings("Connect", "uk"));
  assert.notEqual(tSettings("Setup", "ru"), tSettings("Connect", "ru"));
  assert.equal(translateSettingsSource("My widget shown", "uk"), "My widget shown");
  assert.equal(translateSettingsSource("Gullu · sessions", "en"), "Gullu · sessions");
  assert.equal(translateSettingsSource("Gullu · sessions", "uk"), "Gullu · сеанси");
});

test("plural counts and numeric/date formatting follow the selected locale", () => {
  assert.equal(searchResultCount(1, "uk"), "Знайдено 1 налаштування.");
  assert.equal(searchResultCount(3, "pl"), "Znaleziono 3 ustawienia.");
  assert.equal(searchResultCount(5, "ru"), "Найдено 5 настроек.");
  assert.equal(searchResultCount(1, "ru"), "Найдена 1 настройка.");
  for (const language of ["en", "uk", "pl", "ru"] as const) {
    assert.equal(formatDurationSeconds(3, language), new Intl.NumberFormat(({ en: "en-US", uk: "uk-UA", pl: "pl-PL", ru: "ru-RU" })[language], { style: "unit", unit: "second", unitDisplay: "narrow" }).format(3));
  }
  assert.equal(pluralCategory(2, "uk"), "few");
  assert.equal(formatNumber(12345, "pl"), "12 345");
  assert.equal(formatPercent(50, "en"), "50%");
  assert.equal(formatPercent(50, "ru"), "50 %" );
  assert.match(formatDateTime(0, "uk"), /1970/);
});

test("settings echo comparison keeps combined language and feature changes", () => {
  const before = { ...DEFAULT_SETTINGS } as unknown as Record<string, unknown>;
  const after = { ...before, language: "uk" };
  assert.deepEqual(changedSettingKeys(before, after), ["language"]);
  assert.deepEqual(new Set(changedSettingKeys(before, { ...after, soundEnabled: !before.soundEnabled })), new Set(["language", "soundEnabled"]));
  assert.deepEqual(changedSettingKeys(before, before), []);
});

test("ordinary Settings echoes avoid localization and search rebuild while feature followers still run", () => {
  const calls = { localize: 0, appearance: 0, follow: 0, resets: 0, runSearch: 0, recreateResults: 0 };
  applySettingsEchoEffects({ ...DEFAULT_SETTINGS }, { ...DEFAULT_SETTINGS, soundEnabled: !DEFAULT_SETTINGS.soundEnabled }, "en", "en", {
    localize: () => { calls.localize++; calls.runSearch++; calls.recreateResults++; },
    applyAppearance: () => calls.appearance++, followFeatures: () => calls.follow++, paintResets: () => calls.resets++,
  });
  assert.deepEqual(calls, { localize: 0, appearance: 0, follow: 1, resets: 1, runSearch: 0, recreateResults: 0 });
});

test("language-only and combined Settings echoes localize and retain feature updates", () => {
  const makeEffects = () => { const calls = { localize: 0, appearance: 0, follow: 0, resets: 0 }; return { calls, effects: {
    localize: () => calls.localize++, applyAppearance: () => calls.appearance++, followFeatures: () => calls.follow++, paintResets: () => calls.resets++,
  } }; };
  const onlyLanguage = makeEffects();
  applySettingsEchoEffects({ language: "en", soundEnabled: true }, { language: "uk", soundEnabled: true }, "en", "uk", onlyLanguage.effects);
  assert.deepEqual(onlyLanguage.calls, { localize: 1, appearance: 0, follow: 1, resets: 1 });
  const combined = makeEffects();
  applySettingsEchoEffects({ language: "en", soundEnabled: true }, { language: "pl", soundEnabled: false }, "en", "pl", combined.effects);
  assert.deepEqual(combined.calls, { localize: 1, appearance: 0, follow: 1, resets: 1 });
});

test("async localized painters use the effective language at paint time", () => {
  let language = "en";
  let painted = "";
  const paint = createLocalizedPainter(() => language, (current) => { painted = current; });
  language = "ru";
  paint();
  assert.equal(painted, "ru");
});

test("shortcut conflict errors use all four Settings locales and repaint immediately", () => {
  const conflict = "Already used by another app — pick another";
  const expected = {
    en: conflict,
    uk: "Цю комбінацію вже використовує інша програма — виберіть іншу.",
    pl: "Ta kombinacja jest już używana przez inną aplikację — wybierz inną.",
    ru: "Это сочетание уже используется другим приложением — выберите другое.",
  } as const;
  for (const language of ["en", "uk", "pl", "ru"] as const) {
    assert.equal(shortcutProblemText(conflict, null, true, false, language, translateSettingsSource), expected[language], language);
  }

  let language: "en" | "uk" | "pl" | "ru" = "en";
  const paintVisibleConflict = () => shortcutProblemText(conflict, null, true, false, language, translateSettingsSource);
  assert.equal(paintVisibleConflict(), expected.en);
  language = "uk";
  assert.equal(paintVisibleConflict(), expected.uk, "the visible row resolves the currently selected locale on repaint");
});

test("shortcut row removes the conflict after successful registration", () => {
  const conflict = "Already used by another app — pick another";
  assert.equal(shortcutProblemText(conflict, null, true, false, "pl", translateSettingsSource), "Ta kombinacja jest już używana przez inną aplikację — wybierz inną.");
  assert.equal(shortcutProblemText(null, null, true, false, "pl", translateSettingsSource), null);
  assert.equal(shortcutProblemText(conflict, null, false, false, "ru", translateSettingsSource), null);
});

test("shortcut refusal messages from Rust have reviewed translations in every Settings language", () => {
  const refusals = [
    ["Windows keeps the Win key's shortcuts for itself — pick another", "Windows залишає комбінації з клавішею Win для себе — виберіть іншу.", "Windows rezerwuje dla siebie skróty z klawiszem Win — wybierz inny.", "Windows оставляет сочетания с клавишей Win для себя — выберите другое."],
    ["Windows uses that one for its windows — pick another", "Windows використовує цю комбінацію для керування вікнами — виберіть іншу.", "Windows używa tego skrótu do obsługi okien — wybierz inny.", "Windows использует это сочетание для управления окнами — выберите другое."],
    ["Windows keeps Ctrl+Alt+Del for itself — pick another", "Windows залишає Ctrl+Alt+Del для себе — виберіть іншу комбінацію.", "Windows rezerwuje Ctrl+Alt+Del — wybierz inny skrót.", "Windows оставляет Ctrl+Alt+Del для себя — выберите другое сочетание."],
    ["Windows uses that one for the Start menu and the Task Manager — pick another", "Windows використовує цю комбінацію для меню «Пуск» і Диспетчера завдань — виберіть іншу.", "Windows używa tego skrótu do otwierania menu Start i Menedżera zadań — wybierz inny.", "Windows использует это сочетание для меню «Пуск» и Диспетчера задач — выберите другое."],
    ["Every program uses that one (copy, paste, undo, save…) — pick another", "Цю комбінацію використовують програми для копіювання, вставлення, скасування дії та збереження — виберіть іншу.", "Ten skrót służy w programach do kopiowania, wklejania, cofania i zapisywania — wybierz inny.", "Эта комбинация используется в программах для копирования, вставки, отмены и сохранения — выберите другую."],
  ] as const;
  const languages = ["en", "uk", "pl", "ru"] as const;
  for (const [source, uk, pl, ru] of refusals) {
    const expected = [source, uk, pl, ru];
    for (const [index, language] of languages.entries()) {
      assert.equal(translateSettingsSource(source, language), expected[index], `${language}: ${source}`);
    }
  }
});

test("shortcut refusal composition has one period for conflicts, locale changes and kept keys", () => {
  const conflicts = [
    ["Already used by another app — pick another", "Цю комбінацію вже використовує інша програма — виберіть іншу.", "Ta kombinacja jest już używana przez inną aplikację — wybierz inną.", "Это сочетание уже используется другим приложением — выберите другое."],
    ["Already another Nook shortcut — pick another", "Це вже інша комбінація Nook — виберіть іншу.", "To już inny skrót Nook — wybierz inny.", "Это уже другое сочетание Nook — выберите другое."],
  ] as const;
  const languages = ["en", "uk", "pl", "ru"] as const;
  for (const [source, uk, pl, ru] of conflicts) {
    const expected = [source, uk, pl, ru];
    for (const [index, language] of languages.entries()) {
      const localized = translateSettingsSource(source, language);
      const finalText = composeShortcutRefusal(localized, null, () => "");
      const expectedFinal = `${expected[index].replace(/[.!?…]+$/u, "")}.`;
      assert.equal(finalText, expectedFinal, `${language}: ${source}`);
      assert.doesNotMatch(finalText, /\.{2,}$/);
      const withExistingKey = composeShortcutRefusal(localized, "Ctrl+Alt+Enter", (reason, keys) =>
        tSettings("{reason}. Still using {keys}.", language, { reason, keys }));
      const reason = expected[index].replace(/[.!?…]+$/u, "");
      const suffix = {
        en: ` Still using Ctrl+Alt+Enter.`,
        uk: ` Далі використовується Ctrl+Alt+Enter.`,
        pl: ` Nadal używany jest skrót Ctrl+Alt+Enter.`,
        ru: ` По-прежнему используется сочетание Ctrl+Alt+Enter.`,
      }[language];
      assert.equal(withExistingKey, `${reason}.${suffix}`, `${language}: retained shortcut`);
      assert.doesNotMatch(withExistingKey, /\.{2,}/);
    }
  }

  let language: "en" | "uk" | "pl" | "ru" = "en";
  const source = conflicts[0][0];
  const paint = () => composeShortcutRefusal(translateSettingsSource(source, language), null, () => "");
  assert.equal(paint(), `${conflicts[0][0]}.`);
  language = "uk";
  assert.equal(paint(), conflicts[0][1], "a repaint uses the newly selected locale while the error remains visible");
});

test("both Island Settings duration controls share locale-aware labels and preserve seconds", () => {
  const locale = { en: "en-US", uk: "uk-UA", pl: "pl-PL", ru: "ru-RU" } as const;
  for (const language of ["en", "uk", "pl", "ru"] as const) {
    for (const seconds of [5, 10, 30, 60]) {
      const expected = new Intl.NumberFormat(locale[language], { style: "unit", unit: "second", unitDisplay: "narrow" }).format(seconds);
      assert.equal(formatSettingsDuration(seconds, language, tSettings("Never", language), formatDurationSeconds), expected, `${language}: ${seconds}s`);
      assert.equal(formatSettingsDuration(seconds, language, tSettings("Never", language), formatDurationSeconds), formatDurationSeconds(seconds, language));
    }
    assert.equal(formatSettingsDuration(0, language, tSettings("Never", language), formatDurationSeconds), tSettings("Never", language));
  }
});

test("long search help is translated and searchable with locale metadata", () => {
  const help = "Drag its header to move it. Drag its sides to change its width, and its bottom edge to set how tall it may grow. Double-click its header to put the size back.";
  const searchTerms = { en: "double", uk: "Перетягніть", pl: "Przeciągnij", ru: "Перетащите" };
  for (const language of ["en", "uk", "pl", "ru"] as const) {
    const words = settingsSearchWords("Move and size it with the mouse", help, "Agents list", "", language);
    assert.equal(settingsSearchMatches(words, searchTerms[language]), true, language);
  }
});
