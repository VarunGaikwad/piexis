import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, waitFor } from "./harness.mjs";
import { MODE_LABELS } from "../../lib/mode-policy.ts";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const plain = (value) => value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("installed Pi TUI: Alt+M, /plan, and an actual approval dialog through a PTY", {
  timeout: 45000, skip: process.platform !== "linux" ? "PTY smoke requires Linux util-linux script/stty." : false
}, async (t) => {
  const h = await fixture(t);
  const command = `stty rows 40 cols 120; exec ${[process.execPath, ...h.args].map(quote).join(" ")}`;
  const child = h.start("script", ["-q", "-e", "-f", "-c", command, "/dev/null"]);
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-300000);
    // Answer the terminal cursor-position query; this is a PTY, not a visual terminal emulator.
    if (chunk.includes("\x1b[6n")) child.stdin.write("\x1b[1;1R");
  });
  child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-10000); });
  const diagnostic = () => `${errors}\n${plain(output).slice(-6000)}`;
  try {
    await waitFor(() => plain(output).includes(MODE_LABELS.default), diagnostic);
    output = "";
    child.stdin.write("\x1bm");
    await waitFor(() => plain(output).includes(MODE_LABELS.acceptEdits), diagnostic);
    output = "";
    child.stdin.write("/plan\r");
    await waitFor(() => plain(output).includes(`Permission mode: ${MODE_LABELS.plan}`), diagnostic);
    // Plan -> Auto -> Manual, using real terminal input rather than calling handlers.
    output = "";
    child.stdin.write("\x1bm");
    await waitFor(() => plain(output).includes(`Permission mode: ${MODE_LABELS.auto}`), diagnostic);
    output = "";
    child.stdin.write("\x1bm");
    await waitFor(() => plain(output).includes(`Permission mode: ${MODE_LABELS.default}`), diagnostic);
    output = "";
    child.stdin.write("RUNTIME_WRITE create made.txt\r");
    await waitFor(() => plain(output).includes("Allow once: write"), diagnostic);
    // Allow once is the initially selected option; do not move to a reusable grant.
    child.stdin.write("\r");
    await waitFor(async () => readFile(join(h.cwd, "made.txt"), "utf8").then((value) => value === "actual tool executed\n", () => false), diagnostic);
    await waitFor(() => plain(output).includes("Fixture complete."), diagnostic);
    output = "";
    child.stdin.write("/permissions\r");
    await waitFor(() => plain(output).includes("No session grants."), diagnostic);
    assert.equal(h.errors.length, 0);
  } finally {
    child.stdin.write("\x03");
    await new Promise((done) => setTimeout(done, 100));
    child.stdin.write("\x04");
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, diagnostic, 5000);
  }
});
