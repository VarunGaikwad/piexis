import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSoundPreferences, validateSoundPreferences, type SoundEvent, type SoundPreferences } from "../packages/shared/src/sound.ts";

export const soundFiles: Record<SoundEvent, string> = {
  attention: "mixkit-dry-pop-up-notification-alert-2356.wav",
  finished: "mixkit-bubble-pop-up-alert-notification-2357.wav",
  failure: "mixkit-gaming-lock-2848.wav"
};
const localAudio = fileURLToPath(new URL("../audio/", import.meta.url));
export type SoundSettings = { preferences: SoundPreferences; text: string | undefined; mode: number };

export async function readSoundSettings(agentDir: string): Promise<SoundSettings> {
  const path = join(agentDir, "piexis-sound.json");
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error("Sound preferences must be a regular file");
    const text = await readFile(path, "utf8");
    return { preferences: validateSoundPreferences(JSON.parse(text)), text, mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { preferences: defaultSoundPreferences(), text: undefined, mode: 0o600 };
  }
}

export async function saveSoundSettings(agentDir: string, previous: SoundSettings, preferences: SoundPreferences, signal?: AbortSignal): Promise<SoundSettings> {
  const validated = validateSoundPreferences(preferences);
  const path = join(agentDir, "piexis-sound.json");
  signal?.throwIfAborted();
  await mkdir(agentDir, { recursive: true });
  const lock = `${path}.lock`;
  await mkdir(lock);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const current = await readSoundSettings(agentDir);
    if (current.text !== previous.text) throw new Error("Sound preferences changed; reopen /sound and try again.");
    const existing = current.text === undefined ? {} : JSON.parse(current.text);
    const text = `${JSON.stringify({ ...existing, ...validated }, null, 2)}\n`;
    await writeFile(temporary, text, { flag: "wx", mode: current.mode });
    signal?.throwIfAborted();
    await rename(temporary, path);
    return { preferences: validated, text, mode: current.mode };
  } finally {
    try { await rm(temporary, { force: true }); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
}

/** Local assets are not published: the supplied Mixkit license excludes tool/source redistribution. */
export async function resolveSoundFile(agentDir: string, event: SoundEvent): Promise<string> {
  for (const path of [join(agentDir, "sounds", `${event}.wav`), join(localAudio, soundFiles[event])]) {
    try { await access(path, constants.R_OK); return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error(`Missing ${event} audio. Put a WAV file at ${join(agentDir, "sounds", `${event}.wav`)}.`);
}

export type AudioCommand = { command: string; args: string[] };
export function audioCommands(platform: string, wsl: boolean, file: string): AudioCommand[] {
  if (platform === "darwin") return [{ command: "afplay", args: [file] }];
  if (platform === "win32" || wsl) {
    // Only a quoted literal enters PowerShell; never interpolate a path as executable code.
    const script = `$ErrorActionPreference='Stop'; $player = New-Object System.Media.SoundPlayer; $player.SoundLocation = '${file.replaceAll("'", "''")}'; $player.Load(); $player.PlaySync(); $player.Dispose()`;
    return [{ command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] }];
  }
  if (platform === "linux") return ["pw-play", "paplay", "aplay"].map((command) => ({ command, args: [file] }));
  return [];
}

export type RunAudio = (command: string, args: string[], signal: AbortSignal) => Promise<string>;
const runAudio: RunAudio = (command, args, signal) => new Promise((resolve, reject) => {
  execFile(command, args, { signal, timeout: 10_000, maxBuffer: 32_768, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
});

type SoundPlayerOptions = {
  platform?: string; wsl?: boolean; run?: RunAudio; resolveFile?: (event: SoundEvent) => Promise<string>; now?: () => number;
};

export class SoundPlayer {
  private controller: AbortController | undefined;
  private lastPlayed = -Infinity;
  lastError: string | undefined;
  backend: string | undefined;

  private readonly agentDir: string;
  private readonly options: SoundPlayerOptions;
  constructor(agentDir: string, options: SoundPlayerOptions = {}) {
    this.agentDir = agentDir;
    this.options = options;
  }

  async play(event: SoundEvent, preview = false): Promise<boolean> {
    const now = (this.options.now ?? Date.now)();
    if (this.controller || (!preview && now - this.lastPlayed < 750)) return false;
    const controller = new AbortController();
    this.controller = controller;
    this.lastError = undefined;
    const run = this.options.run ?? runAudio;
    try {
      const platform = this.options.platform ?? process.platform;
      const wsl = this.options.wsl ?? (platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP));
      let file = await (this.options.resolveFile?.(event) ?? resolveSoundFile(this.agentDir, event));
      if (wsl) file = await run("wslpath", ["-w", file], controller.signal);
      controller.signal.throwIfAborted();
      const commands = audioCommands(platform, wsl, file);
      if (!commands.length) throw new Error(`Sound playback is unsupported on ${platform}`);
      let failure: unknown;
      for (const { command, args } of commands) {
        try {
          await run(command, args, controller.signal);
          this.backend = command;
          this.lastPlayed = (this.options.now ?? Date.now)();
          return true;
        } catch (error) {
          failure = error;
          if (controller.signal.aborted) throw error;
        }
      }
      throw new Error(`No working audio player (${commands.map((entry) => entry.command).join(", ")}): ${failure instanceof Error ? failure.message : String(failure)}`);
    } catch (error) {
      if (!controller.signal.aborted) this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  async status(): Promise<string> {
    const platform = this.options.platform ?? process.platform;
    const wsl = this.options.wsl ?? Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
    const candidates = audioCommands(platform, wsl, "").map((entry) => entry.command);
    const available: string[] = [];
    for (const command of candidates) {
      for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        try {
          await access(join(directory, command), platform === "win32" ? constants.F_OK : constants.X_OK);
          available.push(command);
          break;
        } catch { /* Try the next PATH directory. */ }
      }
    }
    const missing: string[] = [];
    for (const event of ["attention", "finished", "failure"] as const) {
      try { await resolveSoundFile(this.agentDir, event); } catch { missing.push(event); }
    }
    return `${platform}${wsl ? " (WSL, Windows-host audio)" : ""}; players: ${available.join(", ") || "none found"}; missing audio: ${missing.join(", ") || "none"}${this.lastError ? `; last error: ${this.lastError}` : ""}. Use /sound test to verify playback.`;
  }

  stop(): void { this.controller?.abort(); }
}
