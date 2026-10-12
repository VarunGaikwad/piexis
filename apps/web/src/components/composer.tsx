import { Button } from "./ui.tsx";

type ComposerProps = {
  connected: boolean;
  canSend: boolean;
  running: boolean;
  cancelling: boolean;
  model?: string;
  draft: string;
  onDraftChange(value: string): void;
  onSend(message: string): boolean;
  onStop(): void;
};

export function Composer({ connected, canSend, running, cancelling, model, draft, onDraftChange, onSend, onStop }: ComposerProps) {
  const submit = () => {
    if (draft.trim() && canSend && onSend(draft)) onDraftChange("");
  };
  const stopDisabled = !connected || cancelling;

  return (
    <div className="composer">
      <textarea
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={connected ? "Message PIXIS…" : "Waiting for local runtime…"}
        aria-label="Message PIXIS"
        className="composer-input"
      />
      <div className="composer-footer">
        <span>{model || "No model selected"}<i /> Enter to send, Shift+Enter for a new line</span>
        {running ? (
          <Button className="button-stop" disabled={stopDisabled} onClick={onStop}>
            {cancelling ? "Stopping…" : "Stop"}
          </Button>
        ) : (
          <Button disabled={!connected || !canSend || !draft.trim()} onClick={submit}>Send ↵</Button>
        )}
      </div>
    </div>
  );
}
