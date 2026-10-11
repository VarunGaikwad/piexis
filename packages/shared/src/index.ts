export type SessionStatus = "starting" | "ready" | "running" | "waiting" | "cancelling" | "failed" | "stopped";

export interface SessionSummary {
  id: string;
  name: string;
  status: SessionStatus;
  model?: string;
  sessionFile?: string;
}

export type ClientCommand =
  | { type: "list_sessions" }
  | { type: "subscribe"; sessionId: string }
  | { type: "create_session" }
  | { type: "prompt"; sessionId: string; message: string }
  | { type: "abort"; sessionId: string }
  | { type: "extension_ui_response"; sessionId: string; id: string; value?: string; confirmed?: boolean; cancelled?: boolean }
  | { type: "git_status"; sessionId: string }
  | { type: "git_diff"; sessionId: string; path: string };

export type ServerMessage =
  | { type: "snapshot"; sessions: SessionSummary[]; sessionId: string; state: unknown; messages: unknown[] }
  | { type: "session"; session: SessionSummary }
  | { type: "pi_event"; sessionId: string; event: unknown }
  | { type: "extension_ui"; sessionId: string; request: unknown }
  | { type: "workspace"; sessionId: string; action: "git_status" | "git_diff"; data: unknown }
  | { type: "error"; message: string; sessionId?: string };
