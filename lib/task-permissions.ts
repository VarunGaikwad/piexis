import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import { isProjectPath } from "./path-policy.ts";
import type { DenialLimits } from "./permission-denials.ts";

export const TASK_PERMISSION_SERVICE = "piexis:task-permission-service";
export const TASK_INVALIDATED = "piexis:task-permissions-invalidated";
export const TASK_TOOLS = new Set(["background_task", "task_status", "task_cancel", "task_diff", "task_apply", "task_clean"]);
export const MANAGED_TASK_TOOLS = new Set(["background_task", "task_apply", "task_clean"]);
export const WORKER_TOOLS = new Set(["read", "grep", "find", "glob", "ls", "edit", "write", "bash"]);

export type TaskScope = { paths: string[]; bash: boolean };
export type TaskSpec = TaskScope & { task: string; model?: string };
export type TaskPermission = { allow: boolean; reason?: string };
export type TaskLease = {
  signal: AbortSignal;
  limits: DenialLimits;
  valid(): boolean;
  close(): void;
  authorize(tool: string, input: unknown, worktree: string, signal?: AbortSignal): Promise<TaskPermission>;
};
export type TaskPermissionService = {
  open(spec: TaskSpec, userCommand: boolean, signal?: AbortSignal): Promise<TaskLease>;
  control(tool: "task_apply" | "task_clean", id: string): Promise<void>;
  declined(tool: "task_apply" | "task_clean", id: string, reason?: string): string;
};

/** Synchronous discovery on Pi's in-process event bus. Absence fails closed.
 * This is a trusted-extension API, not authentication against malicious plugins.
 */
export function taskPermissionService(pi: ExtensionAPI): TaskPermissionService {
  let service: TaskPermissionService | undefined;
  pi.events.emit(TASK_PERMISSION_SERVICE, { provide(value: TaskPermissionService) { service = value; } });
  if (!service) throw new Error("Background tasks require the active Piexis permission extension.");
  return service;
}

export function validateTaskScope(paths: unknown, bash: boolean): TaskScope {
  const values = paths === undefined ? ["."] : paths;
  if (!Array.isArray(values) || !values.length || values.length > 32 || values.some((path) =>
    typeof path !== "string" || !path || path.length > 500 || path.includes("\0") || path.includes("\\") ||
    isAbsolute(path) || path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")))
    throw new Error("Task paths must be a nonempty list of relative files/directories without traversal or .git.");
  const normalized = [...new Set(values.map((path: string) => path.replace(/^\.\//, "").replace(/\/$/, "") || "."))];
  if (bash && !normalized.includes(".")) throw new Error("Worker Bash requires whole-worktree scope; it cannot enforce a narrower path list.");
  return { paths: normalized, bash };
}

export function inTaskScope(path: string, root: string, scope: TaskScope): boolean {
  return isProjectPath(path, root) && scope.paths.some((entry) => isProjectPath(path, resolve(root, entry)));
}
