import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("native title permission is limited to the Settings window", async () => {
  const capability = JSON.parse(await readFile(new URL("../src-tauri/capabilities/settings-title.json", import.meta.url), "utf8"));
  assert.deepEqual(capability.windows, ["settings"]);
  assert.deepEqual(capability.permissions, ["core:window:allow-set-title"]);
});
