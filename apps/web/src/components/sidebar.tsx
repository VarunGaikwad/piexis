import { type Session, type SessionView } from "../lib/workspace-state.ts";
import { BranchIcon } from "./icons.tsx";
import { Button, PanelTitle, Tabs, TabsContent, TabsList, TabsTrigger } from "./ui.tsx";

type SessionSidebarProps = {
  sessions: Session[];
  activeId: string;
  connected: boolean;
  pendingSessionIds: string[];
  onNew(): void;
  onSelect(id: string): void;
  className?: string;
};

export function SessionSidebar({ sessions, activeId, connected, pendingSessionIds, onNew, onSelect, className = "" }: SessionSidebarProps) {
  return (
    <aside className={`sidebar left-sidebar ${className}`}>
      <header className="wordmark">
        <img className="wordmark-mark" src={`${import.meta.env.BASE_URL}piexis-icon.svg`} width="28" height="28" alt="" />
        <span>PIXIS</span>
        <small>LOCAL</small>
      </header>
      <Button onClick={onNew} disabled={!connected}>+ New session</Button>
      <div className="sessions-list">
        <PanelTitle>SESSIONS</PanelTitle>
        <nav className="session-nav">
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => onSelect(session.id)}
              disabled={!connected}
              aria-current={session.id === activeId ? "page" : undefined}
              className={`session-item ${session.id === activeId ? "is-active" : ""}`}
            >
              <span className="min-w-0 truncate">{session.name}</span>
              {pendingSessionIds.includes(session.id) && <small className="needs-input">Needs input</small>}
              <i aria-hidden="true" className={`status ${session.status}`} />
              <span className="sr-only">{session.status}</span>
            </button>
          ))}
        </nav>
      </div>
      <footer className="runtime-status">
        <span className={`connection-dot ${connected ? "connected" : "disconnected"}`} aria-hidden="true" /> {connected ? "Local runtime" : "Disconnected"}
      </footer>
    </aside>
  );
}

type ContextSidebarProps = { view: SessionView; canRefresh: boolean; onRefresh(): void; className?: string };

export function ContextSidebar({ view, canRefresh, onRefresh, className = "" }: ContextSidebarProps) {
  const activity = view.tools.slice(-8).reverse();
  return (
    <aside className={`sidebar context-sidebar ${className}`}>
      <Tabs defaultValue="git">
        <TabsList>
          <TabsTrigger value="git">GIT</TabsTrigger>
          <TabsTrigger value="activity">ACTIVITY</TabsTrigger>
        </TabsList>
        <TabsContent value="git">
          <div className="sidebar-section-header">
            <PanelTitle>WORKSPACE</PanelTitle>
            <button className="text-action" disabled={!canRefresh} onClick={onRefresh}>Refresh</button>
          </div>
          <p className="branch-name"><BranchIcon className="branch-icon" />{view.git?.branch || "Refresh to inspect Git"}</p>
          <div className="changed-files">
            <PanelTitle>CHANGED FILES</PanelTitle>
            {view.git?.files.length ? (
              <ul className="changed-file-list">
                {view.git.files.map((file) => <li key={file.path}><b>{file.status}</b><span>{file.path}</span></li>)}
              </ul>
            ) : <p className="sidebar-empty">{view.git ? "Working tree is clean." : "Refresh to load changed files."}</p>}
          </div>
        </TabsContent>
        <TabsContent value="activity">
          <PanelTitle>AGENT ACTIVITY</PanelTitle>
          {activity.length ? (
            <div className="activity-list">
              {activity.map((tool) => (
                <details key={tool.id} open={tool.running}>
                  <summary><i className={`status ${tool.error ? "failed" : tool.running ? "running" : "done"}`} />{tool.name}<small>{tool.running ? "Running" : tool.error ? "Failed" : "Done"}</small></summary>
                  <pre>{JSON.stringify(tool.result ?? tool.args, null, 2)}</pre>
                </details>
              ))}
            </div>
          ) : <p className="sidebar-empty">Tool calls appear here as Pi executes them.</p>}
        </TabsContent>
      </Tabs>
    </aside>
  );
}
