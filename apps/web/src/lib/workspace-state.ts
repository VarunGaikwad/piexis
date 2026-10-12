import type { SessionSummary } from "../../../../packages/shared/src/index.ts";

export type Session = SessionSummary;
export type Message = { role?: string; content?: unknown; timestamp?: number };
export type Tool = { id: string; name: string; args?: unknown; result?: unknown; error?: boolean; running?: boolean };
export type UiRequest = { id: string; method: "confirm" | "select" | "input" | "editor"; title?: string; message?: string; options?: string[]; prefill?: string };
export type Git = { branch: string; files: { status: string; path: string }[] };
export type SessionView = { messages: Message[]; stream: string; tools: Tool[]; git?: Git };
export type Dialog = { sessionId: string; request: UiRequest };
export type WorkspaceState = {
  sessions: Session[];
  activeId: string;
  views: Record<string, SessionView>;
  dialogs: Record<string, UiRequest>;
  error: string;
};

type PiEvent = {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
  message?: Message | string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  aborted?: boolean;
};
type Action =
  | { type: "snapshot"; sessions: Session[]; sessionId: string; messages: Message[] }
  | { type: "session"; session: Session }
  | { type: "pi_event"; sessionId: string; event: PiEvent }
  | { type: "extension_ui"; sessionId: string; request: UiRequest }
  | { type: "workspace"; sessionId: string; action: string; data: Git }
  | { type: "error"; message: string }
  | { type: "error_clear" }
  | { type: "dialog_clear"; sessionId: string }
  | { type: "prompt_sent" | "prompt_rejected"; sessionId: string };

export const initialWorkspaceState: WorkspaceState = { sessions: [], activeId: "", views: {}, dialogs: {}, error: "" };
const emptyView = (): SessionView => ({ messages: [], stream: "", tools: [] });
const withView = (state: WorkspaceState, id: string, change: (view: SessionView) => SessionView): WorkspaceState => ({
  ...state,
  views: { ...state.views, [id]: change(state.views[id] || emptyView()) }
});
const updateStatus = (state: WorkspaceState, id: string, status: Session["status"]): WorkspaceState => ({
  ...state,
  sessions: state.sessions.map((session) => session.id === id ? { ...session, status } : session)
});
function clearDialog(state: WorkspaceState, sessionId: string): WorkspaceState {
  const dialogs = { ...state.dialogs };
  delete dialogs[sessionId];
  return { ...state, dialogs };
}

export function reduceWorkspace(state: WorkspaceState, input: unknown): WorkspaceState {
  if (!input || typeof input !== "object" || !("type" in input)) return state;
  // Wire payloads originate from the authenticated local server; unknown event types are ignored.
  const item = input as Action;
  if (item.type === "dialog_clear") return clearDialog(state, item.sessionId);
  if (item.type === "error_clear") return { ...state, error: "" };
  if (item.type === "error") return { ...state, error: item.message || "The local server reported an error." };
  if (item.type === "prompt_sent") return updateStatus({ ...state, error: "" }, item.sessionId, "running");
  if (item.type === "prompt_rejected") return updateStatus(state, item.sessionId, "ready");
  if (item.type === "snapshot") {
    const sessionId = typeof item.sessionId === "string" ? item.sessionId : "";
    const views = { ...state.views };
    if (sessionId) {
      const view = views[sessionId] || emptyView();
      const busy = item.sessions.some((session) => session.id === sessionId && (session.status === "running" || session.status === "cancelling"));
      views[sessionId] = { ...view, messages: Array.isArray(item.messages) ? item.messages : [], stream: busy ? view.stream : "" };
    }
    return { ...state, sessions: item.sessions, activeId: sessionId, views };
  }
  if (item.type === "session" && item.session?.id) {
    const index = state.sessions.findIndex((session) => session.id === item.session.id);
    const sessions = [...state.sessions];
    if (index < 0) sessions.push(item.session);
    else sessions[index] = item.session;
    return { ...state, sessions };
  }
  if (item.type === "extension_ui" && item.sessionId && item.request?.id) {
    if (!["confirm", "select", "input", "editor"].includes(item.request.method)) return state;
    return { ...state, dialogs: { ...state.dialogs, [item.sessionId]: item.request } };
  }
  if (item.type === "workspace" && item.sessionId && item.action === "git_status") {
    return withView(state, item.sessionId, (view) => ({ ...view, git: item.data }));
  }
  if (item.type !== "pi_event" || !item.sessionId || !item.event) return state;
  const event = item.event;
  let next = state;
  if (event.type === "agent_start") next = updateStatus(next, item.sessionId, "running");
  if (event.type === "agent_settled") {
    next = clearDialog(updateStatus(next, item.sessionId, "ready"), item.sessionId);
    return withView(next, item.sessionId, (view) => ({
      ...view,
      stream: "",
      tools: view.tools.map((tool) => tool.running ? { ...tool, running: false, error: true, result: "Operation ended before this tool completed." } : tool)
    }));
  }
  if (event.type === "runtime_error") {
    const message = event.message;
    const error = typeof message === "string" ? message : "The Pi runtime stopped unexpectedly.";
    return withView({ ...clearDialog(updateStatus(next, item.sessionId, "failed"), item.sessionId), error }, item.sessionId, (view) => ({
      ...view,
      tools: view.tools.map((tool) => tool.running ? { ...tool, running: false, error: true, result: error } : tool)
    }));
  }
  return withView(next, item.sessionId, (view) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      return { ...view, stream: view.stream + (event.assistantMessageEvent.delta || "") };
    }
    const message = typeof event.message === "object" ? event.message : undefined;
    if (event.type === "message_end" && (message?.role === "assistant" || message?.role === "user")) {
      return { ...view, messages: [...view.messages, message], stream: message.role === "assistant" ? "" : view.stream };
    }
    if (event.type === "tool_execution_start" && event.toolCallId && event.toolName) {
      return { ...view, tools: [...view.tools, { id: event.toolCallId, name: event.toolName, args: event.args, running: true }] };
    }
    if (event.type === "tool_execution_end") {
      return { ...view, tools: view.tools.map((tool) => tool.id === event.toolCallId ? { ...tool, result: event.result, error: event.isError, running: false } : tool) };
    }
    return view;
  });
}
