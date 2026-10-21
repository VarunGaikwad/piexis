import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const token = process.env.PIEXIS_TOKEN || randomBytes(32).toString("base64url");
const env = { ...process.env, PIEXIS_TOKEN: token, VITE_PIEXIS_TOKEN: token, PIEXIS_ORIGIN: "http://127.0.0.1:5173" };
const run = (command, args) => spawn(command, args, { env, stdio: "inherit", shell: process.platform === "win32" });
const server = run("tsx", ["apps/server/src/index.ts"]);
const web = run("vite", ["--config", "apps/web/vite.config.ts"]);
const stop = () => { server.kill(); web.kill(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
