import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ClientCommand } from "../../../../packages/shared/src/index.ts";
import { initialWorkspaceState, reduceWorkspace } from "../lib/workspace-state.ts";
import { BrowserSoundPlayer, WebSoundNotifications } from "../lib/sound.ts";

export function usePixis() {
  const [state, dispatch] = useReducer(reduceWorkspace, initialWorkspaceState);
  const [connected, setConnected] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundError, setSoundError] = useState("");
  const audio = useRef<BrowserSoundPlayer | null>(null);
  audio.current ??= new BrowserSoundPlayer(() => new URLSearchParams(location.hash.slice(1)).get("token") || import.meta.env.VITE_PIXIS_TOKEN || "");
  const sounds = useRef<WebSoundNotifications | null>(null);
  sounds.current ??= new WebSoundNotifications((event) => {
    void audio.current?.play(event).then(() => setSoundError(audio.current?.lastError ?? ""));
  });
  const toggleSounds = useCallback(async () => {
    if (!audio.current) return;
    if (audio.current.enabled) { audio.current.disable(); setSoundEnabled(false); return; }
    const enabled = await audio.current.enable();
    setSoundEnabled(enabled);
    if (enabled) await audio.current.play("attention");
    setSoundError(audio.current.lastError ?? "");
  }, []);
  const socket = useRef<WebSocket | null>(null);
  const requestedSession = useRef(false);
  const promptLocks = useRef(new Set<string>());
  const unconfirmedPrompts = useRef(new Set<string>());
  const send = useCallback((command: ClientCommand) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    if (command.type === "prompt" && promptLocks.current.has(command.sessionId)) return false;
    try {
      socket.current.send(JSON.stringify(command));
      if (command.type === "extension_ui_response") sounds.current?.respond(command.sessionId);
      if (command.type === "prompt") {
        promptLocks.current.add(command.sessionId);
        unconfirmedPrompts.current.add(command.sessionId);
      }
      return true;
    } catch {
      dispatch({ type: "error", message: "Could not send to the local runtime. Your draft has been kept." });
      return false;
    }
  }, []);

  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get("token") || import.meta.env.VITE_PIXIS_TOKEN || "";
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    socket.current = ws;
    ws.onopen = () => {
      if (socket.current !== ws) return;
      setConnected(true);
      send({ type: "list_sessions" });
    };
    ws.onmessage = ({ data }) => {
      if (socket.current !== ws) return;
      try {
        const item = JSON.parse(String(data));
        sounds.current?.receive(item);
        if (item.type === "pi_event" && item.event?.type === "agent_start") unconfirmedPrompts.current.delete(item.sessionId);
        if (item.type === "pi_event" && ["agent_settled", "runtime_error"].includes(item.event?.type)) {
          promptLocks.current.delete(item.sessionId);
          unconfirmedPrompts.current.delete(item.sessionId);
        }
        if (item.type === "error") {
          // Failed prompt commands have no sessionId in the current server error envelope.
          for (const sessionId of unconfirmedPrompts.current) {
            promptLocks.current.delete(sessionId);
            dispatch({ type: "prompt_rejected", sessionId });
          }
          unconfirmedPrompts.current.clear();
        }
        dispatch(item);
        if (item.type === "snapshot" && !item.sessionId && !requestedSession.current) {
          requestedSession.current = true;
          send({ type: "create_session" });
        }
      } catch {
        dispatch({ type: "error", message: "The local server sent an unreadable response." });
      }
    };
    ws.onerror = () => {
      if (socket.current === ws) dispatch({ type: "error", message: "Could not connect to the PIXIS local server. Confirm that /webui started successfully." });
    };
    ws.onclose = (event) => {
      if (socket.current !== ws) return;
      setConnected(false);
      void audio.current?.play("failure");
      dispatch({ type: "error", message: event.reason || "Connection to the PIXIS local server closed. Run /webui again and open its new URL." });
    };
    return () => {
      if (socket.current === ws) socket.current = null;
      ws.close();
      audio.current?.dispose();
    };
  }, [send]);

  const markPromptSent = useCallback((sessionId: string) => dispatch({ type: "prompt_sent", sessionId }), []);
  const clearError = useCallback(() => dispatch({ type: "error_clear" }), []);
  const clearDialog = useCallback((sessionId: string) => dispatch({ type: "dialog_clear", sessionId }), []);

  return { state, connected, send, markPromptSent, clearError, clearDialog, soundEnabled, soundError, toggleSounds };
}
