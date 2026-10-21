#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: piexis-web [--workspace <directory>] [--port <port>] [--token <token>]");
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(value("--workspace") || process.cwd());
const port = value("--port") || process.env.PIEXIS_PORT || "4317";
const token = value("--token") || process.env.PIEXIS_TOKEN || randomBytes(32).toString("base64url");
const server = path.join(root, "apps", "server", "src", "index.ts");
const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), server], {
  cwd: workspace,
  env: { ...process.env, PIEXIS_WORKSPACE: workspace, PIEXIS_PORT: port, PIEXIS_TOKEN: token, PIEXIS_ORIGIN: `http://127.0.0.1:${port}` },
  stdio: "inherit",
  windowsHide: true
});
child.on("exit", (code) => process.exitCode = code ?? 1);
