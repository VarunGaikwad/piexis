import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadThemeFromPath, setThemeJsonValidator } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { validateThemeJson } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-json.js";

const themesDir = new URL("../themes/", import.meta.url);

test("bundled themes validate and render in truecolor and 256-color modes", async () => {
  setThemeJsonValidator(validateThemeJson);
  const names = new Set();
  for (const filename of await readdir(themesDir)) {
    if (!filename.endsWith(".json")) continue;
    const path = fileURLToPath(new URL(filename, themesDir));
    const json = JSON.parse(await readFile(path, "utf8"));
    validateThemeJson(filename, json);
    assert.equal(json.name, filename.slice(0, -5));
    assert.ok(!names.has(json.name), `duplicate theme: ${json.name}`);
    names.add(json.name);
    for (const mode of ["truecolor", "256color"]) {
      const theme = loadThemeFromPath(path, mode);
      assert.equal(theme.name, json.name);
      for (const role of Object.keys(json.colors)) {
        const rendered = role.endsWith("Bg") ? theme.bg(role, "sample") : theme.fg(role, "sample");
        assert.ok(rendered.includes("sample"));
        assert.ok(rendered.includes("\u001b["), `${filename}: ${role} is styled`);
      }
    }
  }
  assert.ok(names.has("midnight"));
  assert.ok(names.has("orange"));
  assert.ok(names.has("neon"));
  assert.ok(names.has("aurora"));
  assert.ok(names.has("rosewood"));
});
