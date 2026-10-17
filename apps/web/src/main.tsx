import { StrictMode, type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "./components/composer.tsx";
import { MenuIcon, PanelIcon, XIcon } from "./components/icons.tsx";
import { ContextSidebar, SessionSidebar } from "./components/sidebar.tsx";
import { Transcript } from "./components/transcript.tsx";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./components/ui.tsx";
import { WorkspaceDialog } from "./components/workspace-dialog.tsx";
import { usePixis } from "./hooks/use-pixis.ts";
import { type SessionView } from "./lib/workspace-state.ts";
import "./fonts.css";
import "./styles.css";

const blankView: SessionView = { messages: [], stream: "", tools: [] };
type Panel = "sessions" | "context" | "";

type PanelSheetProps = {
  panel: Exclude<Panel, "">;
  open: boolean;
  onOpenChange(open: boolean): void;
  onCloseFocus(): void;
  children: ReactNode;
};

function PanelSheet({ panel, open, onOpenChange, onCloseFocus, children }: PanelSheetProps) {
  const title = panel === "sessions" ? "Sessions" : "Workspace";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`panel-sheet ${panel}-sheet`} aria-describedby={`${panel}-sheet-description`} onCloseAutoFocus={(event) => { event.preventDefault(); onCloseFocus(); }}>
        <div className="dialog-heading">
          <div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription id={`${panel}-sheet-description`} className="dialog-description">PIXIS {title.toLowerCase()} panel</DialogDescription>
          </div>
          <DialogClose className="icon-button" aria-label={`Close ${title.toLowerCase()}`}><XIcon /></DialogClose>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function App() {
  const { state, connected, send, markPromptSent, clearError, clearDialog, soundEnabled, soundError, toggleSounds } = usePixis();
  const [panel, setPanel] = useState<Panel>("");
  const [hideSessions, setHideSessions] = useState(false);
  const [hideContext, setHideContext] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const transcript = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const sessionsTrigger = useRef<HTMLButtonElement>(null);
  const contextTrigger = useRef<HTMLButtonElement>(null);
  const request = state.dialogs[state.activeId];
  const current = state.sessions.find((session) => session.id === state.activeId);
  const view = state.views[state.activeId] || blankView;
  const running = current?.status === "running" || current?.status === "cancelling";
  const cancelling = current?.status === "cancelling";
  const canSend = connected && current?.status === "ready";

  useEffect(() => {
    followTranscript.current = true;
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [state.activeId]);
  useEffect(() => {
    if (followTranscript.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [view.messages, view.stream]);

  const subscribe = (sessionId: string) => {
    if (send({ type: "subscribe", sessionId })) setPanel("");
  };
  const prompt = (message: string) => {
    if (!state.activeId || !canSend) return false;
    const sent = send({ type: "prompt", sessionId: state.activeId, message });
    if (sent) markPromptSent(state.activeId);
    return sent;
  };
  const refresh = () => {
    if (state.activeId) send({ type: "git_status", sessionId: state.activeId });
  };
  const newSession = () => {
    if (send({ type: "create_session" })) setPanel("");
  };

  return (
    <main className={`shell ${hideSessions ? "hide-sessions" : ""} ${hideContext ? "hide-context" : ""}`}>
      <SessionSidebar sessions={state.sessions} activeId={state.activeId} connected={connected} pendingSessionIds={Object.keys(state.dialogs)} onNew={newSession} onSelect={subscribe} />
      <section className="conversation">
        <header className="topbar">
          <button ref={sessionsTrigger} className="panel-toggle sessions-toggle" onClick={() => setPanel("sessions")} aria-label="Open sessions"><MenuIcon /><span>Sessions</span></button>
          <button className="panel-toggle desktop-sessions-toggle" onClick={() => setHideSessions(!hideSessions)} aria-label={`${hideSessions ? "Show" : "Hide"} sessions`} aria-expanded={!hideSessions}><MenuIcon /></button>
          <div>
            <strong>{current?.name || "Starting PIXIS"}</strong>
            <span>{current?.model || "Pi session"} · {current?.status || "connecting"}</span>
          </div>
          <button className="panel-toggle sound-toggle" aria-pressed={soundEnabled} title={soundError || "Sound notifications (click to enable and preview)"} onClick={() => { void toggleSounds(); }}>{soundEnabled ? "Mute sounds" : "Enable sounds"}</button>
          <button ref={contextTrigger} className="panel-toggle context-toggle" onClick={() => setPanel("context")} aria-label="Open workspace"><PanelIcon /><span>Workspace</span></button>
          <button className="panel-toggle desktop-context-toggle" onClick={() => setHideContext(!hideContext)} aria-label={`${hideContext ? "Show" : "Hide"} workspace`} aria-expanded={!hideContext}><PanelIcon /></button>
        </header>
        <div ref={transcript} className="messages" onScroll={(event) => {
          const element = event.currentTarget;
          followTranscript.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
        }}><Transcript messages={view.messages} stream={view.stream} /></div>
        {soundError && <div className="error" role="status">Sound notifications: {soundError}</div>}
        {state.error && <div className="error" role="alert">{state.error}<button onClick={clearError} aria-label="Dismiss error"><XIcon /></button></div>}
        <Composer
          connected={connected}
          canSend={canSend}
          running={running}
          cancelling={cancelling}
          model={current?.model}
          draft={drafts[state.activeId] || ""}
          onDraftChange={(value) => setDrafts((previous) => ({ ...previous, [state.activeId]: value }))}
          onSend={prompt}
          onStop={() => state.activeId && send({ type: "abort", sessionId: state.activeId })}
        />
      </section>
      <ContextSidebar view={view} canRefresh={connected && !!state.activeId} onRefresh={refresh} />
      <PanelSheet panel="sessions" open={panel === "sessions"} onOpenChange={(open) => setPanel(open ? "sessions" : "")} onCloseFocus={() => sessionsTrigger.current?.focus()}>
        <SessionSidebar className="sheet-sidebar" sessions={state.sessions} activeId={state.activeId} connected={connected} pendingSessionIds={Object.keys(state.dialogs)} onNew={newSession} onSelect={subscribe} />
      </PanelSheet>
      <PanelSheet panel="context" open={panel === "context"} onOpenChange={(open) => setPanel(open ? "context" : "")} onCloseFocus={() => contextTrigger.current?.focus()}>
        <ContextSidebar className="sheet-sidebar" view={view} canRefresh={connected && !!state.activeId} onRefresh={refresh} />
      </PanelSheet>
      {request && (
        <WorkspaceDialog
          key={`${state.activeId}-${request.id}`}
          request={request}
          sessionId={state.activeId}
          connected={connected}
          onDismiss={() => clearDialog(state.activeId)}
          onRespond={(value, confirmed, cancelled) => {
            if (send({ type: "extension_ui_response", sessionId: state.activeId, id: request.id, value, confirmed, cancelled })) clearDialog(state.activeId);
          }}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
