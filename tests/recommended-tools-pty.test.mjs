import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const python = spawnSync("python3", ["-c", "import pty, termios"], { encoding: "utf8" });
const driver = fileURLToPath(new URL("fixtures/ask-question-pty.py", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/recommended-tools-terminal.mjs", import.meta.url));

for (const scenario of ["setup-enable", "setup-agent-upgrade", "setup-not-now", "setup-disabled"]) {
  test(`real terminal startup: ${scenario}`, { skip: python.status !== 0 ? "Python/Unix PTY support unavailable" : false }, () => {
    const result = spawnSync("python3", [driver, fixture, scenario, process.execPath], { encoding: "utf8", timeout: 12000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).terminalRestored, true);
  });
}
