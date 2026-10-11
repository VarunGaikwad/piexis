import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Session = { id: string; name: string; status: string; model?: string };
type Message = { role?: string; content?: unknown; timestamp?: number };
type Tool = { id: string; name: string; args?: unknown; result?: unknown; error?: boolean; running?: boolean };
type UiRequest = { id: string; method: "confirm" | "select" | "input" | "editor"; title?: string; message?: string; options?: string[]; prefill?: string };
const text = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.filter((x): x is { type: string; text?: string } => !!x && typeof x === "object").map(x => x.text || "").join("\n") : "";

function App() {
  const [sessions, setSessions] = useState<Session[]>([]); const [active, setActive] = useState("");
  const [messages, setMessages] = useState<Message[]>([]); const [draft, setDraft] = useState(""); const [stream, setStream] = useState("");
  const [tools, setTools] = useState<Tool[]>([]); const [connected, setConnected] = useState(false); const [error, setError] = useState("");
  const [git, setGit] = useState<{ branch: string; files: { status: string; path: string }[] }>(); const [dialog, setDialog] = useState<UiRequest>();
  const socket = useRef<WebSocket | null>(null); const activeRef = useRef(active); activeRef.current = active; const current = sessions.find(s => s.id === active); const running = current?.status === "running" || current?.status === "cancelling";
  const send = (value: unknown) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify(value));
  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get("token") || import.meta.env.VITE_PIXIS_TOKEN || "";
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(token)}`); socket.current = ws;
    ws.onopen = () => { setConnected(true); send({ type: "list_sessions" }); };
    ws.onclose = (event) => { setConnected(false); setError(event.reason || "Connection to the PIXIS local server closed. Run /webui again and open its new URL."); };
    ws.onerror = () => setError("Could not connect to the PIXIS local server. Confirm that /webui started successfully, then open the URL it displayed.");
    ws.onmessage = ({ data }) => {
      const item = JSON.parse(data);
      if (item.type === "error") return setError(item.message);
      if (item.type === "snapshot") { setSessions(item.sessions); if (item.sessionId) { setActive(item.sessionId); setMessages(item.messages); setStream(""); } else send({ type: "create_session" }); return; }
      if (item.type === "session") return setSessions(prev => [...prev.filter(s => s.id !== item.session.id), item.session]);
      if (item.type === "extension_ui") return setDialog(item.request);
      if (item.type === "workspace") { if (item.action === "git_status") setGit(item.data); return; }
      if (item.type !== "pi_event" || item.sessionId !== activeRef.current) return;
      const event = item.event;
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") setStream(prev => prev + event.assistantMessageEvent.delta);
      if (event.type === "message_end" && event.message?.role === "assistant") { setMessages(prev => [...prev, event.message]); setStream(""); }
      if (event.type === "tool_execution_start") setTools(prev => [...prev, { id: event.toolCallId, name: event.toolName, args: event.args, running: true }]);
      if (event.type === "tool_execution_end") setTools(prev => prev.map(tool => tool.id === event.toolCallId ? { ...tool, result: event.result, error: event.isError, running: false } : tool));
      if (event.type === "runtime_error") setError(event.message);
    };
    return () => ws.close();
  }, []);
  const submit = () => { if (!draft.trim() || !active || running) return; setMessages(prev => [...prev, { role: "user", content: draft }]); send({ type: "prompt", sessionId: active, message: draft }); setDraft(""); };
  const respond = (value?: string, confirmed?: boolean, cancelled?: boolean) => { if (dialog && active) send({ type: "extension_ui_response", sessionId: active, id: dialog.id, value, confirmed, cancelled }); setDialog(undefined); };
  const activity = useMemo(() => tools.slice(-8).reverse(), [tools]);
  return <main className="shell">
    <aside className="sidebar"><header className="brand"><span>✦</span> PIXIS <small>2.0</small></header><button className="new" onClick={() => send({ type: "create_session" })}>+ New session</button><div className="section-label">SESSIONS</div><nav>{sessions.map(s => <button className={`session ${s.id === active ? "active" : ""}`} key={s.id} onClick={() => send({ type: "subscribe", sessionId: s.id })}><span>{s.name}</span><i className={s.status}/></button>)}</nav><footer><span className="online">●</span> {connected ? "Local runtime" : "Reconnecting…"}</footer></aside>
    <section className="conversation"><header className="topbar"><div><strong>{current?.name || "Starting PIXIS"}</strong><span>{current?.model || "Pi session"}</span></div><button className="ghost" onClick={() => active && send({ type: "git_status", sessionId: active })}>Refresh workspace</button></header>
      <div className="messages">{messages.length === 0 && !stream && <div className="empty"><b>Ready when you are.</b><p>Ask PIXIS to understand, change, or review this workspace.</p></div>}{messages.map((m, i) => <article key={i} className={`message ${m.role === "user" ? "user" : "assistant"}`}><label>{m.role === "user" ? "YOU" : "PIXIS"}</label><pre>{text(m.content)}</pre></article>)}{stream && <article className="message assistant"><label>PIXIS · streaming</label><pre>{stream}</pre></article>}</div>
      {error && <div className="error">{error}<button onClick={() => setError("")}>×</button></div>}<div className="composer"><textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} placeholder="Message PIXIS…" aria-label="Message PIXIS"/><div><span>{current?.model || "No model selected"}</span>{running ? <button className="stop" onClick={() => send({ type: "abort", sessionId: active })}>Stop</button> : <button onClick={submit} disabled={!draft.trim() || !connected}>Send ↵</button>}</div></div>
    </section>
    <aside className="context"><header>WORKSPACE</header><div className="branch">⎇ {git?.branch || "Refresh to inspect Git"}</div><div className="section-label">CHANGED FILES</div>{git?.files.length ? git.files.map(file => <button className="file" key={file.path}><b>{file.status}</b>{file.path}</button>) : <p className="muted">No changed files loaded.</p>}<div className="section-label">AGENT ACTIVITY</div>{activity.length ? activity.map(tool => <details key={tool.id} open={tool.running}><summary><i className={tool.error ? "failed" : tool.running ? "running" : "done"}/>{tool.name}<small>{tool.running ? "Running" : tool.error ? "Failed" : "Done"}</small></summary><pre>{JSON.stringify(tool.result ?? tool.args, null, 2)}</pre></details>) : <p className="muted">Tool calls appear here as Pi executes them.</p>}</aside>
    {dialog && <div className="modal"><div><h2>{dialog.title}</h2><p>{dialog.message}</p>{dialog.method === "select" ? <div>{dialog.options?.map(option => <button key={option} onClick={() => respond(option)}>{option}</button>)}</div> : dialog.method === "confirm" ? <div><button onClick={() => respond(undefined, true)}>Confirm</button><button className="ghost" onClick={() => respond(undefined, false)}>Cancel</button></div> : <DialogInput request={dialog} onSubmit={value => respond(value)} onCancel={() => respond(undefined, undefined, true)}/>}</div></div>}
  </main>;
}
function DialogInput({ request, onSubmit, onCancel }: { request: UiRequest; onSubmit(value: string): void; onCancel(): void }) { const [value, setValue] = useState(request.prefill || ""); return <><textarea value={value} onChange={e => setValue(e.target.value)}/><button onClick={() => onSubmit(value)}>Submit</button><button className="ghost" onClick={onCancel}>Cancel</button></>; }
createRoot(document.getElementById("root")!).render(<StrictMode><App/></StrictMode>);
