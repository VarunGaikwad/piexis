import { randomUUID } from "node:crypto";
import { PiRpcClient } from "../../../packages/pi-integration/src/rpc-client.ts";
import type { SessionStatus, SessionSummary } from "../../../packages/shared/src/index.ts";

export interface ManagedSession {
  id: string;
  name: string;
  status: SessionStatus;
  client: PiRpcClient;
  state: unknown;
  messages: unknown[];
  sessionFile?: string;
  model?: string;
}

export class SessionManager {
  readonly sessions = new Map<string, ManagedSession>();
  constructor(private readonly cwd: string, private readonly emit: (session: ManagedSession, type: "pi_event" | "extension_ui", data: unknown) => void) {}

  async create(): Promise<ManagedSession> {
    const id = randomUUID();
    const client = new PiRpcClient(this.cwd);
    const session: ManagedSession = { id, name: "New session", status: "starting", client, state: {}, messages: [] };
    this.sessions.set(id, session);
    client.on("record", (record) => {
      if (record.type === "extension_ui_request") {
        this.emit(session, "extension_ui", record);
        return;
      }
      this.#applyEvent(session, record);
      this.emit(session, "pi_event", record);
    });
    client.on("exit", (error) => {
      session.status = "failed";
      this.emit(session, "pi_event", { type: "runtime_error", message: error.message });
    });
    try {
      const response = await client.command({ type: "get_state" });
      if (!response.success) throw new Error(response.error || "Pi rejected get_state");
      session.state = response.data ?? {};
      const data = response.data as { sessionId?: string; sessionFile?: string; sessionName?: string; model?: { id?: string } };
      session.sessionFile = data.sessionFile;
      session.name = data.sessionName || "New session";
      session.model = data.model?.id;
      const messages = await client.command({ type: "get_messages" });
      if (messages.success) session.messages = ((messages.data as { messages?: unknown[] })?.messages ?? []);
      session.status = "ready";
      return session;
    } catch (error) {
      session.status = "failed";
      throw error;
    }
  }

  async prompt(id: string, message: string): Promise<void> {
    const session = this.get(id);
    if (session.status === "running" || session.status === "cancelling") throw new Error("This session already has an active operation. Stop it before sending another prompt.");
    session.status = "running";
    const response = await session.client.command({ type: "prompt", message });
    if (!response.success) {
      session.status = "ready";
      throw new Error(response.error || "Pi rejected prompt");
    }
  }

  async abort(id: string): Promise<void> {
    const session = this.get(id);
    if (session.status !== "running") return;
    session.status = "cancelling";
    const response = await session.client.command({ type: "abort" });
    if (!response.success) throw new Error(response.error || "Pi failed to stop");
  }

  get(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown session");
    return session;
  }

  summary(session: ManagedSession): SessionSummary {
    return { id: session.id, name: session.name, status: session.status, model: session.model, sessionFile: session.sessionFile };
  }

  dispose(): void { for (const session of this.sessions.values()) session.client.dispose(); }

  #applyEvent(session: ManagedSession, event: Record<string, unknown>): void {
    if (event.type === "agent_start") session.status = "running";
    if (event.type === "agent_settled") session.status = event.aborted === true ? "ready" : "ready";
    if (event.type === "message_end") {
      const message = event.message as { role?: string } | undefined;
      if (message?.role === "assistant" || message?.role === "user") session.messages.push(event.message);
    }
    if (event.type === "session_info_changed" && typeof event.name === "string") session.name = event.name;
  }
}
