import { createHash } from "node:crypto";

export const INTENT_PROVENANCE = "piexis-input-provenance";
const MAX_MESSAGES = 16;
const MAX_MESSAGE_CHARS = 6000;
const MAX_CONTEXT_CHARS = 24000;

type InputSource = "interactive" | "rpc" | "extension";
type Message = { role: string; content?: unknown; timestamp?: number };
export type IntentEntry = {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
  message?: Message;
  targetId?: string;
};
export type IntentMessage = { id: string; source: "interactive" | "rpc"; text: string };
export type UserIntent = {
  currentRequestId?: string;
  messages: IntentMessage[];
  complete: boolean;
  issues: string[];
};
type Provenance = { version: 1; hash: string; timestamp: number; source: InputSource | "unknown" };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("");
}
function hash(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(content) ?? "null").digest("hex");
}

/** Best effort only: arbitrary secrets cannot be reliably recognized in prose. */
export function redactIntentSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, "[REDACTED AUTHORIZATION]")
    .replace(/\b(?:[A-Z_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)|password|api[-_]?key)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "[REDACTED SECRET]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED TOKEN]");
}

/** Observational provenance, not an isolation boundary against trusted extensions.
 * Exact matching deliberately declines to authenticate expanded/transformed prompts.
 * Persist only a digest and source, not a second copy of the user's prompt.
 */
export class IntentTracker {
  private pending: { hash: string; source: InputSource }[] = [];

  reset(): void { this.pending = []; }
  get hasPendingInput(): boolean { return this.pending.length > 0; }

  input(text: string, source: InputSource): void {
    this.pending.push({ hash: hash(text), source });
    // Overflow drops provenance rather than guessing an origin.
    if (this.pending.length > 64) this.pending = [];
  }

  message(message: Message): Provenance | undefined {
    if (message.role !== "user") return undefined;
    const textHash = hash(textOf(message.content));
    const matches = this.pending.filter((item) => item.hash === textHash);
    this.pending = this.pending.filter((item) => item.hash !== textHash);
    return {
      version: 1, hash: hash(message.content), timestamp: message.timestamp ?? -1,
      source: matches.length === 1 ? matches[0]!.source : "unknown"
    };
  }
}

/** Read raw active-branch entries, not projected model context: compaction and
 * worker/assistant summaries must never manufacture human authorization.
 * A marker is bound to the next user message by its full content hash/timestamp.
 */
export function userIntentFromBranch(branch: readonly IntentEntry[]): UserIntent {
  const messages: IntentMessage[] = [];
  const issues = new Set<string>();
  const edited = new Set(branch.filter((entry) => entry.type === "context_edit").map((entry) => entry.targetId));
  let marker: Provenance | undefined;
  let currentRequestId: string | undefined;
  let currentVerified = false;
  let complete = true;
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === INTENT_PROVENANCE) {
      marker = entry.data as Provenance | undefined;
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const message = entry.message;
    currentRequestId = entry.id;
    currentVerified = Boolean(marker?.version === 1 && marker.timestamp === message.timestamp &&
      marker.hash === hash(message.content) && (marker.source === "interactive" || marker.source === "rpc") && !edited.has(entry.id));
    if (currentVerified) {
      const text = textOf(message.content);
      const redacted = redactIntentSecrets(text);
      if (!text.trim() || redacted !== text || text.length > MAX_MESSAGE_CHARS ||
        Array.isArray(message.content) && message.content.some((part) => part?.type !== "text")) {
        complete = false;
        issues.add("user-content-incomplete-or-redacted");
      }
      messages.push({ id: entry.id, source: marker!.source as "interactive" | "rpc", text: redacted.slice(0, MAX_MESSAGE_CHARS) });
    } else {
      issues.add("unverified-user-messages-excluded");
      // Changed historical user constraints must not silently disappear.
      if (edited.has(entry.id)) complete = false;
    }
    marker = undefined;
  }
  let total = 0;
  const bounded: IntentMessage[] = [];
  for (const message of messages.reverse()) {
    if (bounded.length >= MAX_MESSAGES || total + message.text.length > MAX_CONTEXT_CHARS) {
      complete = false;
      issues.add("user-history-limit");
      break;
    }
    bounded.unshift(message);
    total += message.text.length;
  }
  if (!currentVerified) {
    complete = false;
    issues.add("current-request-unverified");
  }
  return { currentRequestId, messages: bounded, complete, issues: [...issues] };
}
