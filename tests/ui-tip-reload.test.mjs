import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("UI tip JSON reload bypasses Pi-loader legacy data and rejects invalid tips", async () => {
  const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const jitiPackage = pathToFileURL(hostRequire.resolve("jiti/package.json"));
  const { createJiti } = await import(new URL("./lib/jiti-static.mjs", jitiPackage).href);
  const root = await mkdtemp(join(tmpdir(), "piexis-ui-reload-"));
  const entry = join(root, "extensions", "ui.ts");
  const asset = join(root, "lib", "ui-tips.json");
  const load = () => createJiti(import.meta.url, {
    moduleCache: false,
    alias: { "@earendil-works/pi-tui": import.meta.resolve("@earendil-works/pi-tui") }
  }).import(entry, { default: true });
  async function render(factory) {
    const handlers = new Map();
    let header;
    factory({ on(name, handler) { handlers.set(name, handler); } });
    await handlers.get("session_start")({}, {
      mode: "tui", cwd: "/projects/demo",
      ui: {
        setTitle() {}, setFooter() {},
        setHeader(make) { header = make({}, { fg: (_color, text) => text, bold: (text) => text }); }
      }
    });
    return header.render(200).join("\n");
  }
  try {
    await mkdir(join(root, "extensions"));
    await mkdir(join(root, "lib"));
    await writeFile(asset, JSON.stringify(["Legacy cached tip"]));
    await writeFile(entry, 'import tips from "../lib/ui-tips.json" with { type: "json" }; export default () => tips;');
    assert.deepEqual((await load())(), ["Legacy cached tip"]);

    const tips = [
      { category: "Coding", text: "Fresh coding tip" },
      { category: "Style", text: "Fresh style tip" },
      { category: "Planning", text: "Fresh planning tip" }
    ];
    await writeFile(asset, JSON.stringify(tips));
    await writeFile(entry, await readFile(new URL("../extensions/ui.ts", import.meta.url), "utf8"));
    const text = await render(await load());
    for (const tip of tips) assert.ok(text.includes(`[${tip.category}] ${tip.text}`));
    assert.doesNotMatch(text, /undefined|Legacy cached tip/);

    const updated = tips.map((tip) => ({ ...tip, text: `Updated ${tip.text}` }));
    await writeFile(asset, JSON.stringify(updated));
    const factory = await load();
    const reloaded = await render(factory);
    for (const tip of updated) assert.ok(reloaded.includes(tip.text));
    assert.doesNotMatch(reloaded, /undefined/);

    for (const invalid of [null, [null], ["Legacy tip"], [{ category: "Coding" }], [{ category: "", text: "Tip" }]]) {
      await writeFile(asset, JSON.stringify(invalid));
      assert.throws(() => factory({ on() {} }), /Invalid ui-tips.json/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
