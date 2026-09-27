import { redactIntentSecrets } from "./permission-intent.ts";

export type ObservedCommand = { id: string; command: string; outcome: "completed" | "failed" };
/** Only runtime tool execution events count as verification observations. Worker
 * prose remains untrusted and cannot assert that a command actually ran.
 */
export class TaskReport {
  private buffer = "";
  private discarding = false;
  private pending = new Set<string>();
  commands: ObservedCommand[] = [];
  output = "(The subagent produced no final text.)";
  failed = false;
  incomplete = false;
  push(chunk: string): void {
    for (const char of chunk) {
      if (char === "\n") {
        if (!this.discarding && this.buffer) this.event(this.buffer);
        this.buffer = "";
        this.discarding = false;
      } else if (!this.discarding) {
        if (this.buffer.length >= 256000) { this.buffer = ""; this.discarding = true; this.incomplete = true; }
        else this.buffer += char;
      }
    }
  }
  finish(): void {
    if (this.buffer && !this.discarding) this.event(this.buffer);
    this.buffer = "";
    if (this.pending.size) this.incomplete = true;
  }
  private event(line: string): void {
    let event;
    try { event = JSON.parse(line); } catch { this.incomplete = true; return; }
    if (!event || typeof event !== "object" || Array.isArray(event)) { this.incomplete = true; return; }
    if (["bash", "worker_bash"].includes(event.toolName) && typeof event.toolCallId === "string") {
      if (event.type === "tool_execution_start") {
        if (this.pending.size < 1000) this.pending.add(event.toolCallId); else this.incomplete = true;
      }
      if (event.type === "tool_execution_end") this.pending.delete(event.toolCallId);
    }
    if (event.type === "entry_appended" && event.entry?.customType === "piexis-worker-execution") {
      const data = event.entry.data;
      if (!data || typeof data.id !== "string" || typeof data.command !== "string" || typeof data.isError !== "boolean" ||
        this.commands.length >= 100) { this.incomplete = true; return; }
      if (data.truncated === true) this.incomplete = true;
      if (!this.commands.some((command) => command.id === data.id)) this.commands.push({
        id: data.id, command: redactIntentSecrets(data.command).slice(0, 2000), outcome: data.isError ? "failed" : "completed"
      });
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = Array.isArray(event.message.content)
        ? event.message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") : "";
      if (text) this.output = redactIntentSecrets(text).slice(0, 12000);
      if (["error", "aborted"].includes(event.message.stopReason)) this.failed = true;
    }
  }
}

export function verificationSummary(commands: ObservedCommand[] = [], incomplete = false): string {
  return `${commands.length ? commands.map((command) => `${command.outcome}: ${JSON.stringify(command.command)}`).join("\n") : "No Bash verification execution was observed."}${incomplete ? "\nExecution reporting is incomplete; do not infer successful verification." : ""}`;
}
