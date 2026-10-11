import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Could not select a local PIXIS WebUI port.");
  return address.port;
}

/** Starts the separate local WebUI; Pi's TUI remains usable in this process. */
export default function webui(pi: ExtensionAPI) {
  const servers = new Map<string, ChildProcess>();
  const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/piexis-web.mjs");

  pi.registerCommand("webui", {
    description: "Start the local PIXIS WebUI for this workspace",
    handler: async (_args, ctx) => {
      const running = servers.get(ctx.cwd);
      if (running && running.exitCode === null && !running.killed) {
        ctx.ui.notify("PIXIS WebUI is already running for this workspace.", "info");
        return;
      }
      const token = randomBytes(32).toString("base64url");
      const port = await availablePort();
      const child = spawn(process.execPath, [launcher, "--workspace", ctx.cwd, "--port", `${port}`, "--token", token], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
      servers.set(ctx.cwd, child);
      ctx.ui.notify(`PIXIS WebUI started: http://127.0.0.1:${port}/#token=${token}`, "info");
    }
  });
}
