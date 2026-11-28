import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { localeFor, setIslandLanguage, type Language } from "../src/core/i18n.ts";
import { newStep, type SessionStep } from "../src/core/state.ts";
import { cacheJournalEntry, journalEntryCopy, type JournalEntryNode } from "../src/views/journal-cache.ts";

interface RenderedRow {
  tool: string;
  target: string | null;
  heading: string;
  message: string;
  time: string;
}

test("the production journal cache rerenders existing rows across EN → UK → PL → RU → EN", () => {
  const search = newStep("WebSearch", "search", "exact query");
  const error = newStep("Error", "note", null);
  error.messageKey = "island.tool.errorStopped";
  const steps = [search, error];
  const entries = new WeakMap<SessionStep, JournalEntryNode<RenderedRow>>();
  const renders = new Map<SessionStep, number>();
  const sequence: Language[] = ["en", "uk", "pl", "ru", "en"];
  const headings: Record<Language, string> = { en: "Search", uk: "Пошук", pl: "Wyszukiwanie", ru: "Поиск" };
  const errors: Record<Language, string> = {
    en: "The session stopped on an error.",
    uk: "Сеанс зупинився через помилку.",
    pl: "Sesja została zatrzymana z powodu błędu.",
    ru: "Сеанс остановился из-за ошибки.",
  };

  try {
    for (const [localeIndex, language] of sequence.entries()) {
      setIslandLanguage(language);
      const rendered = steps.map((step) => {
        const result = cacheJournalEntry(entries, step, `${step.kind}:${step.state}:${step.target ?? ""}`, () => {
          renders.set(step, (renders.get(step) ?? 0) + 1);
          return { tool: step.tool, target: step.target, ...journalEntryCopy(step) };
        });
        assert.equal(result.changed, true, `${language} invalidates prior locale's cached row`);
        assert.equal(Boolean(result.previous), localeIndex > 0, `${language} reuses or replaces the existing row as appropriate`);
        assert.equal(result.localeChanged, localeIndex > 0, `${language} locale changes rerender without treating it as new event data`);
        return result.entry.el;
      });

      assert.equal(rendered.length, steps.length, "row count remains stable");
      assert.equal(new Set(rendered).size, steps.length, "each step has one row");
      assert.deepEqual(rendered.map((row) => row.tool), ["WebSearch", "Error"], "journal ordering and raw tool IDs remain unchanged");
      assert.equal(rendered[0]!.heading, headings[language]);
      assert.equal(rendered[0]!.target, "exact query");
      assert.equal(rendered[1]!.message, errors[language]);
      assert.equal(rendered[0]!.time, new Intl.DateTimeFormat(localeFor(language), { hour: "2-digit", minute: "2-digit" }).format(new Date(search.at)));

      // A second sync in the same locale must reuse, not duplicate or redraw, the rows.
      const repeated = steps.map((step) => cacheJournalEntry(entries, step, `${step.kind}:${step.state}:${step.target ?? ""}`, () => {
        renders.set(step, (renders.get(step) ?? 0) + 1);
        return { tool: step.tool, target: step.target, ...journalEntryCopy(step) };
      }));
      assert.ok(repeated.every((entry) => !entry.changed));
      assert.ok(repeated.every((entry) => !entry.localeChanged));
      assert.deepEqual(repeated.map((entry) => entry.entry.el), rendered);
    }
    assert.deepEqual([...renders.values()], [5, 5], "each existing row redraws once per locale change");
    assert.deepEqual(steps.map((step) => step.tool), ["WebSearch", "Error"]);
    assert.deepEqual(steps.map((step) => step.target), ["exact query", null]);
  } finally {
    setIslandLanguage("en");
  }
});

test("syncJournal uses the locale-aware cache and production row renderer", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/views/session.ts", import.meta.url)), "utf8");
  assert.match(source, /cacheJournalEntry\(entries, step, key/);
  assert.match(source, /journalEntryCopy\(step\)/);
});
