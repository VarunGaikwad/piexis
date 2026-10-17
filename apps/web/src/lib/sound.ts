import { SoundNotifications, type SoundEvent } from "../../../../packages/shared/src/sound.ts";

/** RPC sessions never play host audio; only the opted-in browser plays it. */
export class WebSoundNotifications {
  private sessions = new Map<string, SoundNotifications>();
  private dialogs = new Map<string, string>();
  constructor(private readonly play: (event: SoundEvent) => void, private readonly now = Date.now) {}

  receive(item: Record<string, any>): void {
    if (typeof item.sessionId !== "string" || !item.sessionId) return;
    let session = this.sessions.get(item.sessionId);
    if (!session) { session = new SoundNotifications(); this.sessions.set(item.sessionId, session); }
    let event = item.type === "pi_event" ? item.event : undefined;
    // Dialog requests are authoritative in RPC: do not also sound ui_prompt_start.
    if (event?.type === "ui_prompt_start" || event?.type === "ui_prompt_end") return;
    if (item.type === "extension_ui" && ["select", "confirm", "input", "editor"].includes(item.request?.method)) {
      if (this.dialogs.get(item.sessionId) === item.request.id) return;
      this.dialogs.set(item.sessionId, item.request.id);
      session.accept({ type: "ui_prompt_end" }, 5000, this.now());
      event = { type: "ui_prompt_start" };
    }
    if (!event || typeof event !== "object") return;
    const selected = session.accept(event, 5000, this.now());
    if (event.type === "agent_settled" || event.type === "runtime_error") this.dialogs.delete(item.sessionId);
    if (selected) this.play(selected);
  }

  respond(sessionId: string): void {
    this.sessions.get(sessionId)?.accept({ type: "ui_prompt_end" }, 5000, this.now());
  }
}

export class BrowserSoundPlayer {
  private context: AudioContext | undefined;
  private source: AudioBufferSourceNode | undefined;
  private buffers = new Map<SoundEvent, AudioBuffer>();
  private busy = false;
  private lastPlayed = -Infinity;
  private generation = 0;
  enabled = false;
  lastError: string | undefined;

  constructor(private readonly token: () => string) {}

  async enable(): Promise<boolean> {
    try {
      this.context ??= new AudioContext();
      await this.context.resume();
      if (this.context.state !== "running") throw new Error("Browser audio is suspended. Click Enable sounds again.");
      this.enabled = true;
      this.lastError = undefined;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async play(event: SoundEvent): Promise<void> {
    if (!this.enabled || !this.context || this.busy || Date.now() - this.lastPlayed < 750) return;
    this.busy = true;
    const generation = this.generation;
    try {
      let buffer = this.buffers.get(event);
      if (!buffer) {
        const response = await fetch(`/sounds/${event}.wav?token=${encodeURIComponent(this.token())}`);
        if (!response.ok) throw new Error(`Could not load ${event} sound (${response.status}). Check local WAV files.`);
        buffer = await this.context.decodeAudioData(await response.arrayBuffer());
        this.buffers.set(event, buffer);
      }
      if (!this.enabled || generation !== this.generation) return;
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      this.source = source;
      await new Promise<void>((resolve) => { source.onended = () => { source.disconnect(); resolve(); }; source.start(); });
      this.lastPlayed = Date.now();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally { this.source = undefined; this.busy = false; }
  }

  disable(): void { this.enabled = false; this.generation++; this.source?.stop(); }
  dispose(): void { this.disable(); void this.context?.close().catch(() => {}); this.context = undefined; this.buffers.clear(); }
}
