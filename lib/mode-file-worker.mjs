// Runs INSIDE the OS sandbox. Inputs are data, never executable JavaScript.
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { createJiti } from "jiti";
import {
  createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createLsToolDefinition
} from "@earendil-works/pi-coding-agent";

// Pi packages may live in node_modules, where Node's native TS stripping is forbidden.
// Never write a compilation cache from a read-only tool.
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { validateTarget } = await jiti.import("./mode-policy.ts");
const { createProtectedGrep, createProtectedFind } = await jiti.import("./mode-grep.ts");
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { mode, tool, input, root, settings } = JSON.parse(Buffer.concat(chunks).toString());
  const check = async (path, name = tool) => validateTarget(mode, name, { ...input, path }, root, settings);
  input.path = await check(input.path);
  const safeRead = async path => { await check(path, "read"); return readFile(path); };
  const safeWrite = async (path, content) => { await check(path); await writeFile(path, content); };
  const definitions = {
    read: () => createReadToolDefinition(root),
    edit: () => createEditToolDefinition(root, { operations: { access: async path => { await check(path); }, readFile: safeRead, writeFile: safeWrite } }),
    write: () => createWriteToolDefinition(root, { operations: {
      writeFile: safeWrite,
      mkdir: async directory => { await check(input.path); await mkdir(directory, { recursive: true }); }
    } }),
    grep: () => createProtectedGrep(root),
    find: () => createProtectedFind(root),
    ls: () => createLsToolDefinition(root)
  };
  let result;
  if (tool === "delete_plan") {
    await check(input.path);
    await unlink(input.path);
    result = { content: [{ type: "text", text: `Deleted plan ${input.path}` }], details: undefined };
  } else {
    if (!Object.hasOwn(definitions, tool)) throw new Error(`Unmanaged worker tool: ${tool}`);
    // The OS profile also protects actual reads through symlink aliases and prevents
    // mutation by tool subprocesses; validation alone would not provide containment.
    result = await definitions[tool]().execute("sandbox", input, undefined, undefined, { cwd: root });
  }
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
