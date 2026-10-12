import { useState } from "react";
import { type UiRequest } from "../lib/workspace-state.ts";
import { XIcon } from "./icons.tsx";
import { Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui.tsx";

type WorkspaceDialogProps = {
  request: UiRequest;
  sessionId: string;
  connected: boolean;
  onDismiss(): void;
  onRespond(value?: string, confirmed?: boolean, cancelled?: boolean): void;
};

export function WorkspaceDialog({ request, sessionId, connected, onDismiss, onRespond }: WorkspaceDialogProps) {
  const [value, setValue] = useState(request.prefill || "");
  const cancel = () => {
    if (connected) onRespond(undefined, undefined, true);
    else onDismiss();
  };
  const disconnected = "Local runtime is disconnected. Reconnect to respond to this request.";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) cancel(); }}>
      <DialogContent aria-describedby="dialog-message" className="workspace-dialog">
        <div className="dialog-heading">
          <DialogTitle>{request.title || "PIXIS request"}</DialogTitle>
          <DialogClose className="icon-button" aria-label="Close request"><XIcon /></DialogClose>
        </div>
        <DialogDescription id="dialog-message" className="dialog-description">{request.message || "PIXIS needs your response to continue."}</DialogDescription>
        {!connected && <p className="dialog-notice" role="status">{disconnected}</p>}
        {request.method === "select" ? (
          <div className="dialog-options">
            {request.options?.map((option) => <Button key={option} className="option-button" disabled={!connected} onClick={() => onRespond(option)}>{option}</Button>)}
            <Button className="button-secondary" onClick={cancel}>Cancel</Button>
          </div>
        ) : request.method === "confirm" ? (
          <div className="dialog-actions">
            <Button className="button-secondary" disabled={!connected} onClick={() => onRespond(undefined, false)}>Cancel</Button>
            <Button disabled={!connected} onClick={() => onRespond(undefined, true)}>Confirm</Button>
          </div>
        ) : (
          <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); if (connected) onRespond(value); }}>
            <label htmlFor={`request-${sessionId}-${request.id}`}>Response</label>
            <textarea id={`request-${sessionId}-${request.id}`} autoFocus value={value} disabled={!connected} onChange={(event) => setValue(event.target.value)} />
            <div className="dialog-actions">
              <Button type="button" className="button-secondary" onClick={cancel}>Cancel</Button>
              <Button type="submit" disabled={!connected}>Submit</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
