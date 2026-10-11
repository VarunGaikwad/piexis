import { ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type RpcRecord = Record<string, unknown>;

/** Long-lived, documented Pi RPC client. It treats stdout as strict JSONL. */
export class PiRpcClient extends EventEmitter {
  #child?: ChildProcess;
  #buffer = "";
  #pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (reason: Error) => void }>();

  constructor(
    private readonly cwd: string,
    private readonly executable = process.env.PIXIS_PI_BIN || (process.platform === "win32" ? "pi.cmd" : "pi"),
    private readonly executableArgs: string[] = []
  ) {
    super();
  }

  start(): void {
    if (this.#child) return;
    const child = spawn(this.executable, [...this.executableArgs, "--mode", "rpc"], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.#consume(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => this.emit("diagnostic", chunk.toString("utf8")));
    child.on("error", (error) => this.#fail(error));
    child.on("exit", (code, signal) => this.#fail(new Error(`Pi exited (${code ?? signal ?? "unknown"})`)));
  }

  async command(command: Record<string, unknown>): Promise<RpcResponse> {
    this.start();
    const id = randomUUID();
    const record = { ...command, id };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const input = this.#child?.stdin;
      if (!input || input.destroyed) return reject(new Error("Pi RPC stdin is unavailable"));
      input.write(`${JSON.stringify(record)}\n`, "utf8", (error) => {
        if (error) {
          this.#pending.delete(id);
          reject(error);
        }
      });
    });
  }

  send(record: Record<string, unknown>): void {
    const input = this.#child?.stdin;
    if (!input || input.destroyed) throw new Error("Pi RPC stdin is unavailable");
    input.write(`${JSON.stringify(record)}\n`, "utf8");
  }

  dispose(): void {
    this.#child?.stdin?.end();
    this.#child = undefined;
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const record = JSON.parse(line) as RpcRecord;
        if (record.type === "response" && typeof record.id === "string" && typeof record.command === "string" && typeof record.success === "boolean") {
          const pending = this.#pending.get(record.id);
          if (pending) {
            this.#pending.delete(record.id);
            pending.resolve(record as unknown as RpcResponse);
            continue;
          }
        }
        this.emit("record", record);
      } catch {
        this.emit("diagnostic", `Ignoring malformed Pi RPC record: ${line.slice(0, 200)}`);
      }
    }
  }

  #fail(error: Error): void {
    if (!this.#child && this.#pending.size === 0) return;
    this.#child = undefined;
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
    this.emit("exit", error);
  }
}
