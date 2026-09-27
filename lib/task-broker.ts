import { randomUUID } from "node:crypto";
import { lstat, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const BROKER_LIMIT = 1024 * 1024;
export type BrokerAnswer = { id: string; outcome: "allowed" | "denied" | "cancelled" | "expired" | "unavailable"; reason?: string };
export type BrokerRequest = { id: string; token: string; tool: string; input: unknown; expiresAt: number };
export function validBrokerRequest(value: unknown, filename: string, token: string): value is BrokerRequest {
  const request = value as BrokerRequest | undefined;
  return Boolean(request && /^[a-f0-9-]{36}$/.test(request.id) && filename === `${request.id}.request.json` &&
    request.token === token && typeof request.tool === "string" && request.tool.length < 100 &&
    request.input && typeof request.input === "object" && !Array.isArray(request.input) &&
    Number.isFinite(request.expiresAt) && request.expiresAt <= Date.now() + 5 * 60_000 + 1000);
}
export async function readBrokerJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > BROKER_LIMIT) throw new Error("Invalid broker file.");
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(BROKER_LIMIT + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > BROKER_LIMIT) throw new Error("Oversized broker file.");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}
export async function publishBrokerJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(`${path}.tmp`, path);
}

export async function requestWorkerPermission(
  broker: string, token: string, tool: string, input: unknown, signal?: AbortSignal,
  options: { timeoutMs?: number; pollMs?: number; heartbeatMs?: number } = {}
): Promise<BrokerAnswer> {
  const id = randomUUID();
  const request = join(broker, `${id}.request.json`);
  const response = join(broker, `${id}.response.json`);
  const expiresAt = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  try {
    if (signal?.aborted) return { id, outcome: "cancelled" };
    const message = { id, token, tool, input, expiresAt };
    if (Buffer.byteLength(JSON.stringify(message)) > BROKER_LIMIT) return { id, outcome: "denied", reason: "Worker action exceeds the broker size limit." };
    await publishBrokerJson(request, message);
    while (Date.now() < expiresAt) {
      if (signal?.aborted) return { id, outcome: "cancelled" };
      try {
        const heartbeat = await stat(join(broker, "heartbeat"));
        if (Date.now() - heartbeat.mtimeMs > (options.heartbeatMs ?? 10000)) return { id, outcome: "unavailable" };
      } catch { return { id, outcome: "unavailable" }; }
      try {
        const answer = await readBrokerJson(response) as BrokerAnswer;
        if (answer.id !== id || !["allowed", "denied", "cancelled", "expired"].includes(answer.outcome))
          return { id, outcome: "denied", reason: "Invalid broker response." };
        return signal?.aborted ? { id, outcome: "cancelled" } : answer;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { id, outcome: "denied", reason: "Invalid broker response." };
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100));
    }
    return { id, outcome: "expired" };
  } catch { return { id, outcome: "unavailable" }; }
  finally {
    await Promise.all([request, `${request}.tmp`, response].map((path) => rm(path, { force: true }).catch(() => undefined)));
  }
}
