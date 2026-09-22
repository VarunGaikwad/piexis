export type Mode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";

export const MODE_LABELS: Record<Mode, string> = {
  default: "[⏸ manual mode on]",
  acceptEdits: "[⏵⏵ accept edits on]",
  plan: "[⏸ plan mode on]",
  auto: "[⏵⏵ auto mode on]",
  dontAsk: "[⏵⏵ don't ask on]",
  bypassPermissions: "[⏵⏵ bypass permissions on]",
};

export const ALT_M_CYCLE: Mode[] = ["default", "acceptEdits", "plan", "auto"];
export const FLAG_ONLY_MODES = new Set<Mode>(["dontAsk", "bypassPermissions"]);
export const READ_TOOLS = new Set(["read", "grep", "find", "glob", "ls", "AskQuestion"]);
export const EDIT_TOOLS = new Set(["edit", "write"]);
const FS_COMMANDS = new Set(["mkdir", "touch", "rm", "rmdir", "mv", "cp", "sed"]);
export function isAcceptEditsCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /[|;&`$()<>]/.test(trimmed)) return false;
  const match = trimmed.match(/^([A-Za-z][\w-]*)\b/);
  return !!match && FS_COMMANDS.has(match[1]!.toLowerCase());
}
export function statusFor(mode: Mode): string { return MODE_LABELS[mode]; }
