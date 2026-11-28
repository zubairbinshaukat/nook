import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setIslandLanguage, tIsland, type IslandTranslationKey, type Language } from "../src/core/i18n.ts";
import { newStep } from "../src/core/state.ts";
import { journalEntryCopy } from "../src/views/journal-cache.ts";
import { activityLineText, stepActivityLine, stepMessage, stepName } from "../src/views/step-labels.ts";

const languages: Language[] = ["en", "uk", "pl", "ru"];

test("activity action labels repaint in the active language while preserving commands and paths", () => {
  const read = stepActivityLine("Read", { file_path: "C:/work/main.ts" });
  const run = stepActivityLine("Bash", { command: "npm test" });
  assert.deepEqual(read, { key: "island.tool.reads", target: "main.ts" });
  assert.deepEqual(run, { key: "island.tool.runs", target: "npm test" });

  try {
    const outputs = new Map<Language, [string, string]>();
    for (const language of languages) {
      setIslandLanguage(language);
      outputs.set(language, [activityLineText(read), activityLineText(run)]);
    }
    assert.deepEqual(outputs.get("en"), ["Reads · main.ts", "Runs · npm test"]);
    assert.deepEqual(outputs.get("uk"), ["Читає · main.ts", "Запускає · npm test"]);
    assert.deepEqual(outputs.get("pl"), ["Czyta · main.ts", "Uruchamia · npm test"]);
    assert.deepEqual(outputs.get("ru"), ["Читает · main.ts", "Запускает · npm test"]);
    setIslandLanguage("en");
    assert.equal(activityLineText(read), outputs.get("en")![0], "typed activity resolves using the current locale at render time");
  } finally {
    setIslandLanguage("en");
  }
});

test("hook-authored state labels and session step headings use translations in all locales", () => {
  const markers = [
    ["island.tool.thinkingEllipsis", "Thinking…", "Обмірковує…", "Myśli…", "Думает…"],
    ["island.tool.failed", "⚠ failed", "⚠ помилка", "⚠ niepowodzenie", "⚠ ошибка"],
    ["island.tool.waitingSubagents", "… waiting for its subagents", "… очікує на субагентів", "… czeka na subagentów", "… ждёт субагентов"],
    ["island.tool.subagent", "+ subagent", "+ субагент", "+ subagent", "+ субагент"],
    ["island.tool.subagentDone", "• subagent done", "• субагент завершив роботу", "• subagent zakończył pracę", "• субагент завершил работу"],
    ["island.tool.note", "Note", "Нотатка", "Notatka", "Заметка"],
    ["island.tool.error", "Error", "Помилка", "Błąd", "Ошибка"],
    ["island.tool.notification", "Notification", "Сповіщення", "Powiadomienie", "Уведомление"],
    ["island.tool.cursorSaid", "Cursor said", "Cursor повідомив", "Cursor napisał", "Cursor сообщил"],
    ["island.tool.searchesWeb", "Searches the web", "Шукає в інтернеті", "Szuka w internecie", "Ищет в интернете"],
    ["island.tool.fetches", "Fetches", "Завантажує", "Pobiera", "Загружает"],
    ["island.tool.shell", "Shell", "Командний рядок", "Powłoka", "Командная строка"],
    ["island.tool.todos", "Todos", "Завдання", "Zadania", "Задачи"],
    ["island.tool.notebook", "Notebook", "Notebook", "Notebook", "Notebook"],
  ] as const;
  const step = newStep("WebSearch", "search", "cats");
  const fetch = newStep("WebFetch", "other", "https://example.test");
  const headings = ["Search", "Пошук", "Wyszukiwanie", "Поиск"];
  const fetchHeadings = ["Fetch", "Завантаження", "Pobieranie", "Загрузка"];
  const languagesExpected = ["en", "uk", "pl", "ru"] as const;

  try {
    for (let i = 0; i < languagesExpected.length; i++) {
      const language = languagesExpected[i]!;
      setIslandLanguage(language);
      for (const [key, ...expected] of markers) {
        const text = activityLineText({ key });
        assert.equal(text, expected[i], `${language} ${key}`);
        assert.ok(!text.startsWith("island."));
      }
      assert.equal(stepName(step), headings[i]);
      assert.equal(stepName(fetch), fetchHeadings[i]);
      assert.equal(step.tool, "WebSearch", "display formatting must not rewrite the event/tool identifier");
      assert.equal(step.kind, "search", "display formatting must not change event classification");
      assert.equal(step.target, "cats");
    }
  } finally {
    setIslandLanguage("en");
  }
});

test("provider text and unknown tool IDs remain verbatim; app-authored error copy is localized", () => {
  const userText = "Thinking… · arbitrary agent text";
  assert.equal(activityLineText(userText), userText);

  const custom = stepActivityLine("CustomTool", { command: "keep --as-is" });
  assert.deepEqual(custom, { label: "CustomTool", target: "keep --as-is" });
  assert.equal(activityLineText(custom), "CustomTool · keep --as-is");

  const failure = newStep("Error", "note", null);
  failure.messageKey = "island.tool.errorStopped";
  const expected = {
    en: "The session stopped on an error.",
    uk: "Сеанс зупинився через помилку.",
    pl: "Sesja została zatrzymana z powodu błędu.",
    ru: "Сеанс остановился из-за ошибки.",
  } as const;
  try {
    for (const language of languages) {
      setIslandLanguage(language);
      assert.equal(stepMessage(failure), expected[language]);
    }
  } finally {
    setIslandLanguage("en");
  }
});

test("localized step headings cover app event labels without translating provider content", () => {
  const ids = ["Thinking", "Note", "Error", "Notification", "Cursor said"];
  const keys = ["island.tool.thinking", "island.tool.note", "island.tool.error", "island.tool.notification", "island.tool.cursorSaid"] as const;
  try {
    for (const language of languages) {
      setIslandLanguage(language);
      ids.forEach((id, index) => {
        const step = newStep(id, "note", "agent supplied words");
        assert.equal(stepName(step), tIsland(keys[index]!));
        assert.equal(step.target, "agent supplied words");
      });
    }
  } finally {
    setIslandLanguage("en");
  }
});

test("original technical tool labels and short aliases are preserved", () => {
  const raw = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "LS"];
  const activityKeys: Readonly<Record<string, IslandTranslationKey>> = {
    Bash: "island.tool.runs", Read: "island.tool.reads", Write: "island.tool.writes", Edit: "island.tool.edits",
    MultiEdit: "island.tool.edits", Glob: "island.tool.finds", Grep: "island.tool.searches", Task: "island.tool.agent",
    LS: "island.tool.lists", PowerShell: "island.tool.runs", TodoWrite: "island.tool.todos",
    NotebookEdit: "island.tool.notebook", WebSearch: "island.tool.searchesWeb", WebFetch: "island.tool.fetches",
  };
  const aliases: Readonly<Record<string, string>> = {
    AskUserQuestion: "Question", NotebookEdit: "Notebook", MultiEdit: "Edit", TodoWrite: "Todos", PowerShell: "Shell",
  };
  for (const language of languages) {
    setIslandLanguage(language);
    for (const id of raw) {
      const step = newStep(id, "other", "target");
      assert.equal(stepName(step), id);
      const activity = stepActivityLine(id, { command: "npm test" });
      assert.deepEqual(activity, { key: activityKeys[id]!, target: "npm test" });
      assert.equal(activityLineText(activity), `${tIsland(activityKeys[id]!)} · npm test`);
      assert.equal(step.tool, id, "raw journal/roster tool ID is unchanged");
      assert.equal(typeof activity === "object" && activity.target, "npm test");
    }
    for (const [id, alias] of Object.entries(aliases)) {
      assert.equal(stepName(newStep(id, "other", null)), alias, id);
    }
    for (const [id, key] of Object.entries(activityKeys)) {
      assert.deepEqual(stepActivityLine(id, {}), { key }, `${language} ${id} activity key`);
      assert.equal(activityLineText(stepActivityLine(id, {})), tIsland(key));
    }
  }
  setIslandLanguage("en");
});

test("journal and roster keep technical names while Island activity uses action translations", () => {
  for (const language of languages) {
    setIslandLanguage(language);
    const bash = newStep("Bash", "command", "npm test");
    const read = newStep("Read", "read", "main.ts");
    assert.equal(stepName(bash), "Bash");
    assert.equal(stepName(read), "Read");
    assert.equal(journalEntryCopy(bash).heading, "Bash");
    assert.equal(journalEntryCopy(read).heading, "Read");
    assert.deepEqual(stepActivityLine("Bash", { command: "npm test" }), { key: "island.tool.runs", target: "npm test" });
    assert.deepEqual(stepActivityLine("Read", { file_path: "C:/work/main.ts" }), { key: "island.tool.reads", target: "main.ts" });
  }
  const roster = readFileSync(fileURLToPath(new URL("../src/views/roster.ts", import.meta.url)), "utf8");
  const journal = readFileSync(fileURLToPath(new URL("../src/views/session.ts", import.meta.url)), "utf8");
  assert.match(roster, /stepName\(last\)/, "roster labels use the technical-name helper");
  assert.match(journal, /journalEntryCopy\(step\)/, "journal labels use the technical-name helper");
  setIslandLanguage("en");
});

test("Agents feed can explicitly render typed Island activity in English", () => {
  const failure = { key: "island.tool.failed" } as const;
  setIslandLanguage("ru");
  assert.equal(activityLineText(failure), "⚠ ошибка");
  assert.equal(activityLineText(failure, "en"), "⚠ failed");
  const feed = readFileSync(fileURLToPath(new URL("../src/agents/feed.ts", import.meta.url)), "utf8");
  assert.match(feed, /activityLineText\(line,\s*"en"\)/, "the English Agents window receives English activity strings");
  setIslandLanguage("en");
});

test("hook lifecycle events still produce distinct localized subagent markers", () => {
  const hooks = readFileSync(fileURLToPath(new URL("../src/island/hooks.ts", import.meta.url)), "utf8");
  assert.match(hooks, /say\(session,\s*\{\s*key:\s*"island\.tool\.subagent"\s*\}\)/);
  assert.match(hooks, /say\(session,\s*\{\s*key:\s*"island\.tool\.subagentDone"\s*\}\)/);
  assert.match(hooks, /State\.appendStep\(agentId,\s*\{\s*key:\s*"island\.tool\.subagent"\s*\}\)/);
  assert.match(hooks, /State\.appendStep\(agentId,\s*\{\s*key:\s*"island\.tool\.subagentDone"\s*\}\)/);
});
