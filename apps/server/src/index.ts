import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolveSoundFile } from "../../../lib/sound.ts";
import { soundEvents, type SoundEvent } from "../../../packages/shared/src/sound.ts";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { SessionManager, type ManagedSession } from "./session-manager.ts";
import { gitDiff, gitStatus } from "./workspace.ts";
import type { ClientCommand, ServerMessage } from "../../../packages/shared/src/index.ts";

const port = Number(process.env.PIEXIS_PORT || 4317);
const workspace = path.resolve(process.env.PIEXIS_WORKSPACE || process.cwd());
const token = process.env.PIEXIS_TOKEN || randomBytes(32).toString("base64url");
const allowedOrigin = process.env.PIEXIS_ORIGIN || `http://127.0.0.1:${port}`;
const webRoot = path.resolve(process.env.PIXIS_WEB_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist"));
const clients = new Set<{ send(data: string): void; readyState: number }>();
const app = Fastify({ logger: { level: process.env.PIXIS_LOG_LEVEL || "warn" } });

const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list_sessions") }),
  z.object({ type: z.literal("subscribe"), sessionId: z.string().uuid() }),
  z.object({ type: z.literal("create_session") }),
  z.object({ type: z.literal("prompt"), sessionId: z.string().uuid(), message: z.string().trim().min(1).max(100_000) }),
  z.object({ type: z.literal("abort"), sessionId: z.string().uuid() }),
  z.object({ type: z.literal("extension_ui_response"), sessionId: z.string().uuid(), id: z.string().min(1), value: z.string().optional(), confirmed: z.boolean().optional(), cancelled: z.boolean().optional() }),
  z.object({ type: z.literal("git_status"), sessionId: z.string().uuid() }),
  z.object({ type: z.literal("git_diff"), sessionId: z.string().uuid(), path: z.string().min(1).max(4096) })
]);

function secureEqual(a: string, b: string) {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
function send(client: { send(data: string): void; readyState: number }, message: ServerMessage) {
  if (client.readyState === 1) client.send(JSON.stringify(message));
}
function broadcast(message: ServerMessage) { for (const client of clients) send(client, message); }

const manager = new SessionManager(workspace, (session, type, data) => {
  broadcast(type === "pi_event" ? { type, sessionId: session.id, event: data } : { type, sessionId: session.id, request: data });
  broadcast({ type: "session", session: manager.summary(session) });
});

await app.register(websocket);
await app.register(fastifyStatic, { root: webRoot, wildcard: false });
app.get("/health", async () => ({ ok: true }));
app.get("/sounds/:event.wav", async (request, reply) => {
  const suppliedToken = (request.query as { token?: string }).token;
  if (typeof suppliedToken !== "string" || !secureEqual(suppliedToken, token)) return reply.code(401).send({ error: "Unauthorized" });
  const event = (request.params as { event: string }).event;
  if (!soundEvents.includes(event as SoundEvent)) return reply.code(404).send({ error: "Unknown sound" });
  try {
    const file = await resolveSoundFile(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"), event as SoundEvent);
    return reply.header("Cache-Control", "private, no-store").type("audio/wav").send(await readFile(file));
  } catch { return reply.code(404).send({ error: "Local sound file unavailable" }); }
});
app.get("/ws", { websocket: true }, (socket, request) => {
  const origin = request.headers.origin;
  const suppliedToken = (request.query as { token?: string }).token;
  if (origin !== allowedOrigin || !suppliedToken || !secureEqual(suppliedToken, token)) {
    socket.close(1008, "Unauthorized PIXIS client");
    return;
  }
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("message", async (raw: Buffer) => {
    try {
      const command = commandSchema.parse(JSON.parse(raw.toString("utf8"))) as ClientCommand;
      await handle(socket, command);
    } catch (error) {
      send(socket, { type: "error", message: error instanceof Error ? error.message : "Invalid request" });
    }
  });
});

async function handle(client: { send(data: string): void; readyState: number }, command: ClientCommand) {
  if (command.type === "list_sessions") {
    const first = manager.sessions.values().next().value as ManagedSession | undefined;
    if (first) return snapshot(client, first);
    return send(client, { type: "snapshot", sessions: [], sessionId: "", state: {}, messages: [] });
  }
  if (command.type === "create_session") {
    const session = await manager.create();
    broadcast({ type: "session", session: manager.summary(session) });
    return snapshot(client, session);
  }
  const session = manager.get(command.sessionId);
  if (command.type === "subscribe") return snapshot(client, session);
  if (command.type === "prompt") await manager.prompt(session.id, command.message);
  if (command.type === "abort") await manager.abort(session.id);
  if (command.type === "extension_ui_response") session.client.send({ type: "extension_ui_response", id: command.id, value: command.value, confirmed: command.confirmed, cancelled: command.cancelled });
  if (command.type === "git_status") send(client, { type: "workspace", sessionId: session.id, action: "git_status", data: await gitStatus(workspace) });
  if (command.type === "git_diff") send(client, { type: "workspace", sessionId: session.id, action: "git_diff", data: await gitDiff(workspace, command.path) });
  broadcast({ type: "session", session: manager.summary(session) });
}
function snapshot(client: { send(data: string): void; readyState: number }, session: ManagedSession) {
  send(client, { type: "snapshot", sessions: [...manager.sessions.values()].map((item) => manager.summary(item)), sessionId: session.id, state: session.state, messages: session.messages });
}

const shutdown = async () => { manager.dispose(); await app.close(); };
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
await app.listen({ port, host: "127.0.0.1" });
console.log(`PIXIS server listening on http://127.0.0.1:${port}`);
console.log(`Open http://127.0.0.1:${port}/#token=${token}`);
if (!process.env.PIEXIS_TOKEN) console.log(`PIEXIS token (set PIEXIS_TOKEN to persist it): ${token}`);
