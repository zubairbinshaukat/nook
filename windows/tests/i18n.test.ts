import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_SETTINGS, ramWords, targetTip, targetWords } from "../src/core/state.ts";
import { cardinalForm, contextUsageLabel, DICTIONARIES, ENGLISH, effectiveLanguage, formatNumber, localeFor, ISLAND_DICTIONARIES, ISLAND_ENGLISH, setIslandLanguage, t, tIsland, translatedValue, usageSourceDescription } from "../src/core/i18n.ts";
import { repliedWords } from "../src/core/state.ts";
import { LOOK_RESET_FIELDS, lookAtDefaults, lookResetPatch } from "../src/settings/reset.ts";
import { searchResultCount, settingsCopyKeys, settingsSearchMatches, settingsSearchWords, tSettings, translateSettingsSource } from "../src/core/settings-copy.ts";
import { formatDateTime, formatDurationSeconds, formatPercent, pluralCategory } from "../src/core/i18n.ts";
import { applySettingsEchoEffects, changedSettingKeys, composeShortcutRefusal, createLocalizedPainter, formatSettingsDuration, shortcutProblemText } from "../src/settings/settings-behavior.ts";

function islandCatalogSource(language: "en" | "uk" | "pl" | "ru"): string {
  const source = readFileSync(fileURLToPath(new URL("../src/core/i18n.ts", import.meta.url)), "utf8");
  const islandStart = source.indexOf("export const ISLAND_ENGLISH = {");
  const settingsStart = source.indexOf("export const DICTIONARIES:");
  const dictionarySource = source.slice(islandStart, settingsStart);
  const startMarker = language === "en" ? "export const ISLAND_ENGLISH = {" : `  ${language}: {`;
  const start = language === "en" ? dictionarySource.indexOf(startMarker) : dictionarySource.indexOf(startMarker, dictionarySource.indexOf("export const ISLAND_DICTIONARIES"));
  assert.notEqual(start, -1, `${language} catalog exists in source`);
  const endMarker = language === "en" ? "} as const;" : language === "uk" ? "  pl: {" : language === "pl" ? "  ru: {" : "export function tIsland";
  const end = dictionarySource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${language} catalog ends in source`);
  return dictionarySource.slice(start, end);
}

function sourceEntries(source: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const match of source.matchAll(/^\s*"(island\.[^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) {
    const [, key, value] = match;
    assert.ok(!entries.has(key!), `duplicate Island key ${key}`);
    entries.set(key!, value!);
  }
  return entries;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([a-zA-Z][\w]*)\}/g)].map((match) => match[1]!).sort();
}

test("Island catalogs have unique keys, full coverage, non-empty values and matching placeholders", () => {
  const expectedKeys = Object.keys(ISLAND_ENGLISH).sort();
  for (const language of ["en", "uk", "pl", "ru"] as const) {
    const entries = sourceEntries(islandCatalogSource(language));
    assert.deepEqual([...entries.keys()].sort(), expectedKeys, `${language} source keys`);
    const catalog = language === "en" ? ISLAND_ENGLISH : ISLAND_DICTIONARIES[language];
    for (const [key, value] of Object.entries(catalog)) {
      assert.ok(value.trim(), `${language}.${key} is non-empty`);
      assert.deepEqual(placeholders(value), placeholders(ISLAND_ENGLISH[key as keyof typeof ISLAND_ENGLISH]), `${language}.${key} placeholders`);
      assert.equal(entries.get(key), value, `${language}.${key} source/runtime value`);
    }
  }
});

test("reviewed English Island source changes require an explicit translation review", () => {
  const reviewed = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/island-english-reviewed.json", import.meta.url)), "utf8")) as Record<string, string>;
  const keys = new Set([...Object.keys(reviewed), ...Object.keys(ISLAND_ENGLISH)]);
  for (const key of [...keys].sort()) {
    assert.equal(ISLAND_ENGLISH[key as keyof typeof ISLAND_ENGLISH], reviewed[key],
      `English source ${key} changed; review UK/PL/RU translations, then update tests/fixtures/island-english-reviewed.json`);
  }
});

test("target, time, RAM and reply-error copy follows the selected Island locale", async () => {
  const { Reply } = await import("../src/core/reply.ts");
  const target = { kind: "terminal", label: "Windows Terminal", tabbed: true } as const;
  const session = { target, title: "Build", project: "demo" } as never;
  const targetWordsExpected = { en: "Open terminal", uk: "Відкрити термінал", pl: "Otwórz terminal", ru: "Открыть терминал" } as const;
  for (const language of ["en", "uk", "pl", "ru"] as const) {
    setIslandLanguage(language);
    assert.equal(targetWords(target), targetWordsExpected[language]);
    for (const kind of ["vscode", "cursor"] as const) {
      assert.equal(targetWords({ kind, label: kind === "vscode" ? "VS Code" : "Cursor", tabbed: false }),
        tIsland("island.target.open", { target: kind === "vscode" ? "VS Code" : "Cursor" }, language));
    }
    assert.equal(targetTip(session), tIsland("island.target.openTab", { target: "Windows Terminal", tab: "Build" }, language));
    const relative = tIsland("island.timeAgo.minutes", { count: formatNumber(2, language) }, language);
    assert.equal((await import("../src/views/dom.ts")).timeAgo(Date.now() - 120_000), relative);
    assert.equal(ramWords({ ramUsed: 2 * 1024 ** 3, ramTotal: 8 * 1024 ** 3 } as never),
      tIsland("island.metric.ramUsedOfTotal", {
        used: new Intl.NumberFormat(localeFor(language), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(2),
        total: new Intl.NumberFormat(localeFor(language), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(8),
      }, language));
    const id = `reply-test-${language}`;
    Reply.ended({ tool: "claude", sessionId: id, ok: false });
    assert.equal(Reply.error({ id } as never), tIsland("island.reply.errorGeneric", {}, language));
    Reply.ended({ tool: "claude", sessionId: `${id}-external`, ok: false, error: "system refused" });
    assert.equal(Reply.error({ id: `${id}-external` } as never), tIsland("island.reply.errorNotSent", { error: "system refused" }, language));
    for (const count of [1, 2, 5]) {
      const warningSession = { subagents: Array.from({ length: count }, () => ({ state: "running" })) } as never;
      const form = cardinalForm(count, language);
      assert.equal(Reply.warning(warningSession), tIsland(`island.reply.subagentsWarning.${form}`, { count: formatNumber(count, language) }, language));
    }
  }
  setIslandLanguage("en");
});

test("session count, Markdown line plural, and contextual widget names render reviewed phrases", () => {
  const sessionSource = readFileSync(fileURLToPath(new URL("../src/views/session.ts", import.meta.url)), "utf8");
  assert.match(sessionSource, /setIslandText\(el, im\(countKey\("sessionCount", count\)/, "visible chip uses the localized singular/plural count label");
  assert.match(sessionSource, /const replied = repliedWords\(session\);[\s\S]*words: replied\.toLowerCase\(\)/, "visible replied-subagent status uses the localized plural helper");
  assert.doesNotMatch(sessionSource, /island\.tool\.repliedSubagents/, "the singular status no longer uses a hard-coded plural phrase");
  const expected = {
    en: ["1 session", "2 sessions", "1 more line", "2 more lines"],
    uk: ["1 сеанс", "2 сеанси", "ще 1 рядок", "ще 2 рядки"],
    pl: ["1 sesja", "2 sesje", "jeszcze 1 wiersz", "jeszcze 2 wiersze"],
    ru: ["1 сеанс", "2 сеанса", "ещё 1 строка", "ещё 2 строки"],
  } as const;
  for (const language of ["en", "uk", "pl", "ru"] as const) {
    setIslandLanguage(language);
    assert.equal(tIsland("island.session.sessionCount.one", { count: "1" }, language), expected[language][0]);
    assert.equal(tIsland(`island.session.sessionCount.${cardinalForm(2, language)}`, { count: "2" }, language), expected[language][1]);
    assert.equal(tIsland("island.markdown.moreLine.one", { count: "1" }, language), expected[language][2]);
    assert.equal(tIsland(`island.markdown.moreLine.${cardinalForm(2, language)}`, { count: "2" }, language), expected[language][3]);
  }
  setIslandLanguage("en");
});

test("reviewed fixes keep Ukrainian in the Ukrainian catalog and preserve placeholders", () => {
  assert.equal(ISLAND_DICTIONARIES.uk["island.session.needsPermission"], "потрібен дозвіл");
  assert.equal(ISLAND_DICTIONARIES.uk["island.session.waitingForYouCount"], ", на вас чекає: {count}");
  assert.equal(ISLAND_DICTIONARIES.uk["island.markdown.decisionsBelow"], "Ще важливі рішення нижче: {count}");
  assert.deepEqual(placeholders(ISLAND_DICTIONARIES.uk["island.session.waitingForYouCount"]), ["count"]);
});

test("Shelf controls have contextual translated accessible names in all locales", () => {
  const uiSource = readFileSync(fileURLToPath(new URL("../src/widgets/ui.ts", import.meta.url)), "utf8");
  assert.match(uiSource, /title: im\(EXPAND_LABEL\[id\]\), "aria-label": im\(EXPAND_LABEL\[id\]\)/);
  assert.match(uiSource, /island\.control\.removeItem/);
  const widgets = ["Media", "Timer", "Reminders", "Todo", "Mirror", "Projects"] as const;
  for (const language of ["en", "uk", "pl", "ru"] as const) {
    for (const widget of widgets) {
      const label = tIsland(`island.widget.expand${widget}`, {}, language);
      assert.ok(label.length > 0);
      assert.notEqual(label, tIsland("island.widget.expand", {}, language), `${language} expand ${widget} has contextual copy`);
    }
    const remove = tIsland("island.control.removeItem", { item: "Buy tea" }, language);
    assert.ok(remove.includes("Buy tea"), `${language} remove label names the specific user item`);
  }
});

test("Island translations stay in their language catalogs and blank values fall back to English", () => {
  assert.equal(ISLAND_DICTIONARIES.uk["island.reply.label"], "Відповісти");
  assert.equal(ISLAND_DICTIONARIES.pl["island.reply.label"], "Odpowiedz");
  assert.equal(ISLAND_DICTIONARIES.ru["island.reply.label"], "Ответить");
  assert.equal(ISLAND_DICTIONARIES.uk["island.view.comingNext"], "Буде доступно пізніше");
  assert.equal(ISLAND_DICTIONARIES.pl["island.view.comingNext"], "Wkrótce");
  assert.equal(ISLAND_DICTIONARIES.ru["island.view.comingNext"], "Скоро появится");
  const dictionary = ISLAND_DICTIONARIES.uk as Record<string, string>;
  const original = dictionary["island.home.needsYou"];
  dictionary["island.home.needsYou"] = "";
  try {
    assert.equal(tIsland("island.home.needsYou", {}, "uk"), ISLAND_ENGLISH["island.home.needsYou"]);
  } finally {
    dictionary["island.home.needsYou"] = original!;
  }
});

test("Island catalogs reject the cross-locale script contamination found in review", () => {
  // Product names and technical tokens remain Latin in every locale. These checks target
  // the copied Polish diacritics and Cyrillic strings that had crossed dictionary boundaries.
  for (const [key, value] of Object.entries(ISLAND_DICTIONARIES.uk)) {
    assert.doesNotMatch(value, /[łŁąĄęĘśŚćĆńŃźŹżŻóÓ]/, `uk.${key} contains a Polish-script marker`);
    assert.doesNotMatch(value, /potrzebuje pozwolenia|czeka na ciebie/i, `uk.${key} contains the reviewed Polish catalog contamination`);
  }
  for (const [key, value] of Object.entries(ISLAND_DICTIONARIES.pl)) {
    assert.doesNotMatch(value, /[\u0400-\u04ff]/, `pl.${key} contains Cyrillic text`);
  }
  for (const [key, value] of Object.entries(ISLAND_DICTIONARIES.ru)) {
    assert.doesNotMatch(value, /[łŁąĄęĘśŚćĆńŃźŹżŻóÓ]/, `ru.${key} contains a Polish-script marker`);
  }
  assert.equal(ISLAND_DICTIONARIES.uk["island.session.all"], "Усі");
  assert.equal(ISLAND_DICTIONARIES.pl["island.session.all"], "Wszystkie");
  assert.equal(ISLAND_DICTIONARIES.ru["island.session.all"], "Все");
});

test("production Island views do not stringify typed translation keys", () => {
  for (const file of ["../src/views/reply-box.ts", "../src/views/session.ts", "../src/views/shelf.ts",
    "../src/widgets/ui.ts", "../src/widgets/timer.ts", "../src/widgets/todo.ts", "../src/widgets/reminders.ts",
    "../src/widgets/media.ts", "../src/widgets/mirror.ts", "../src/widgets/projects.ts"]) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /im\([^\n]*\)\.key/, `${file} must render im() through the Island DOM helpers`);
    if (file.endsWith("session.ts")) assert.doesNotMatch(source, /yet:\s*steps\.length/, "empty-state production paths must use complete localized phrases");
  }
});

test("every built-in Shelf widget consumes typed Island copy on its production path", () => {
  const expected: Record<string, string[]> = {
    "../src/widgets/ui.ts": ["island.widget.back", "island.control.removeItem", "island.widget.markDone"],
    "../src/widgets/timer.ts": ["island.widget.timerPresets", "island.widget.timerSmallRunning", "island.widget.timerOf"],
    "../src/widgets/todo.ts": ["island.widget.todoAddLabel", "island.widget.todoEmpty", "island.widget.todoCount"],
    "../src/widgets/reminders.ts": ["island.widget.reminderAddLabel", "island.widget.remindersEmpty", "island.widget.reminderIn"],
    "../src/widgets/media.ts": ["island.widget.mediaPlayPause", "island.widget.mediaVolume", "island.widget.mediaNothingPlaying"],
    "../src/widgets/mirror.ts": ["island.widget.cameraOn", "island.widget.cameraWaiting", "island.widget.cameraDeniedHelp"],
    "../src/widgets/projects.ts": ["island.widget.projectsNote", "island.widget.projectsNoneHelp", "island.widget.projectsOpenCode"],
  };
  for (const [file, keys] of Object.entries(expected)) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    for (const key of keys) assert.ok(source.includes(key), `${file} consumes ${key}`);
  }
  const englishKeys = Object.keys(ISLAND_ENGLISH).filter((key) => key.startsWith("island.widget."));
  const localeNeutralKeys = new Set([
    "island.widget.mediaState", "island.widget.minutesShort", "island.widget.minutesUnit",
    "island.widget.reminder10m", "island.widget.reminder30m", "island.widget.unitMinutes",
  ]);
  assert.ok(englishKeys.length > 0, "the runtime widget inventory remains part of the typed Island catalog");
  for (const language of ["uk", "pl", "ru"] as const) {
    for (const key of englishKeys) {
      assert.ok(ISLAND_DICTIONARIES[language][key as keyof typeof ISLAND_ENGLISH], `${language}.${key} is translated`);
      if (!localeNeutralKeys.has(key)) assert.notEqual(ISLAND_DICTIONARIES[language][key as keyof typeof ISLAND_ENGLISH], ISLAND_ENGLISH[key as keyof typeof ISLAND_ENGLISH], `${language}.${key} must not silently fall back to English`);
    }
  }
  for (const file of ["../src/widgets/defs.ts", "../src/widgets/ui.ts", "../src/widgets/timer.ts", "../src/widgets/todo.ts",
    "../src/widgets/reminders.ts", "../src/widgets/media.ts", "../src/widgets/mirror.ts", "../src/widgets/projects.ts",
    "../src/views/shelf.ts"]) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /\b(?:text|title|aria-label|placeholder)\s*:\s*["`]/, `${file} must use typed copy for literal UI labels`);
  }
  const markdown = readFileSync(fileURLToPath(new URL("../src/views/markdown.ts", import.meta.url)), "utf8");
  assert.match(markdown, /h\("b", \{ text: im\(title\) \}\)/, "Markdown callout headings resolve typed Island keys");
  for (const key of ["island.markdown.showLess", "island.markdown.showFullReply", "island.markdown.decisionsBelow"]) {
    assert.ok(markdown.includes(key), `folded session replies consume ${key}`);
  }
  assert.match(markdown, /island\.markdown\.moreLine\.\$\{cardinalForm/);
});

test("context usage messages contain exactly one locale-formatted percent sign", () => {
  for (const language of ["en", "uk", "pl", "ru"] as const) {
    const message = contextUsageLabel(50, language);
    const number = formatNumber(50, language);
    assert.equal(message, tIsland("island.session.context", { percent: number }, language));
    assert.equal([...message].filter((character) => character === "%").length, 1, `${language} context label`);
    assert.ok(message.includes(number), `${language} localized number`);
  }
});

test("empty step messages use complete localized phrases for both age states", () => {
  const pairs = [
    ["island.session.noSessionStepKind", "island.session.noSessionStepKindYet"],
    ["island.session.noSubagentStepKind", "island.session.noSubagentStepKindYet"],
  ] as const;
  for (const language of ["en", "uk", "pl", "ru"] as const) {
    for (const [currentKey, yetKey] of pairs) {
      const current = tIsland(currentKey, {}, language);
      const yet = tIsland(yetKey, {}, language);
      assert.ok(current.length > 0 && yet.length > 0, `${language} empty-state phrases exist`);
      assert.doesNotMatch(current + yet, /\{yet\}/);
      if (language !== "en") assert.doesNotMatch(yet, /\byet\b/i, `${language} must not contain English yet`);
    }
  }
});

test("replied subagent status uses locale-correct singular and plural forms", () => {
  const expected = {
    en: ["Replied · 1 subagent still running", "Replied · 2 subagents still running"],
    uk: ["Відповів · ще працює 1 субагент", "Відповів · ще працюють 2 субагенти"],
    pl: ["Odpowiedział · nadal działa 1 subagent", "Odpowiedział · nadal działają 2 subagenci"],
    ru: ["Ответил · ещё работает 1 субагент", "Ответил · ещё работают 2 субагента"],
  } as const;
  for (const language of ["en", "uk", "pl", "ru"] as const) {
    setIslandLanguage(language);
    for (const n of [1, 2]) {
      const session = { parked: true, toldReply: true, subagents: Array.from({ length: n }, () => ({ state: "running" })) } as never;
      assert.equal(repliedWords(session), expected[language][n === 1 ? 0 : 1]);
    }
    assert.equal(cardinalForm(5, language), language === "en" ? "other" : "many");
  }
  setIslandLanguage("en");
});

test("usage tooltip source follows the stable provider identity in every locale", () => {
  const headerStats = readFileSync(fileURLToPath(new URL("../src/views/header-stats.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(headerStats, /startsWith\("Codex"\)/);
  assert.match(headerStats, /usage\(codexFive,[^\n]*"codex"/);
  assert.match(headerStats, /usage\(five,[^\n]*"claude"/);
  for (const language of ["en", "uk", "pl", "ru"] as const) {
    assert.equal(usageSourceDescription("codex", language), tIsland("island.usage.codexSource", {}, language));
    assert.equal(usageSourceDescription("claude", language), tIsland("island.usage.sourceUsage", {}, language));
    assert.notEqual(usageSourceDescription("codex", language), usageSourceDescription("claude", language));
  }
});

test("Island document language follows the effective locale without changing Settings language resolution", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/island/island.ts", import.meta.url)), "utf8");
  assert.match(source, /document\.documentElement\.lang\s*=\s*localeFor\(language\)/);
  assert.equal(effectiveLanguage("system", "uk"), "uk");
  assert.equal(effectiveLanguage("system", "pl"), "pl");
  assert.equal(effectiveLanguage("system", "ru"), "ru");
});

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
