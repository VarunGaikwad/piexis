import { evaluatePathPolicy, isProjectPath, type PathPolicyResult } from "./path-policy.ts";
import { analyzeBash, type BashAnalysis } from "./bash-policy.ts";
import { bashApprovalFingerprint } from "./bash-approvals.ts";
import { realpath } from "node:fs/promises";
import { TASK_TOOLS, WORKER_TOOLS, inTaskScope, type TaskScope } from "./task-permissions.ts";

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
/** Tools that are pre-approved only after the path policy accepts their target. */
export const READ_TOOLS = new Set(["read", "grep", "find", "glob", "ls", "AskQuestion"]);
export const EDIT_TOOLS = new Set(["edit", "write"]);
export const AUTO_KNOWN_TOOLS = new Set([...READ_TOOLS, ...EDIT_TOOLS, "bash", ...TASK_TOOLS]);

export type DeterministicPermissionDecision =
  | { decision: "allow"; source: "policy"; reason: string; pathPolicy?: PathPolicyResult }
  | { decision: "review"; source: "policy"; reason: string; pathPolicy?: PathPolicyResult }
  | { decision: "deny"; source: "policy"; reason: string; pathPolicy?: PathPolicyResult };

export type SessionApproval = (
  | { tool: string; scope: "tool" }
  | { tool: string; scope: "file"; path: string }
  | { tool: string; scope: "directory"; path: string }
  | { tool: string; scope: "project" }
  | { tool: "bash"; scope: "command"; command: string; cwd: string; fingerprint: string }
  | { tool: "bash"; scope: "subcommand"; family: "git-status"; cwd: string; fingerprint: string }
  | { tool: "bash"; scope: "executable"; executable: string }
) & { id?: string };

export type PermissionRequest = {
  mode: Mode;
  tool: string;
  input: unknown;
  cwd: string;
  workspaceRoot: string;
  authorization?: { approvals: readonly SessionApproval[] };
  actor?: { kind: "foreground" | "worker"; id?: string; scope?: TaskScope };
};
export type PermissionDecision = {
  decision: "allow" | "deny" | "require-approval" | "require-model-review";
  source: "policy";
  reason: string;
  pathPolicy?: PathPolicyResult;
  bash?: BashAnalysis;
  bashFingerprint?: string;
  canonicalCwd?: string;
};

function matchesApproval(request: PermissionRequest, pathPolicy?: PathPolicyResult, bash?: BashAnalysis, fingerprint?: string, cwd?: string): boolean {
  if (request.actor?.kind === "worker") return false;
  const { tool, input } = request;
  const approvals = request.authorization?.approvals ?? [];
  // Broad grants must not authorize credential access, policy edits, or an
  // uninspected recursive subtree. Recursive calls require fresh approval.
  if (pathPolicy?.decision === "review" && pathPolicy.scope === "sensitive") {
    if (pathPolicy.reason === "recursive-boundary") return false;
    return approvals.some((a) => a.tool === tool && a.scope === "file" && a.path === pathPolicy.path);
  }
  if (request.mode !== "auto" && approvals.some((a) => a.tool === tool && a.scope === "tool")) return true;
  if (tool === "bash") {
    const command = (input as { command: string }).command.trim();
    if (!fingerprint || !cwd || !bash?.grantFamily) return false;
    return approvals.some((a) => a.tool === tool && (
      (a.scope === "command" && a.command === command && a.cwd === cwd && a.fingerprint === fingerprint) ||
      (a.scope === "subcommand" && a.family === bash.grantFamily && a.cwd === cwd && a.fingerprint === fingerprint)
    ));
  }
  if (!pathPolicy || pathPolicy.decision === "deny") return false;
  return approvals.some((a) => a.tool === tool && (
    (a.scope === "file" && a.path === pathPolicy.path) ||
    (a.scope === "directory" && isProjectPath(pathPolicy.path, a.path)) ||
    (request.mode !== "auto" && a.scope === "project" && pathPolicy.scope === "project")
  ));
}

/** UI-independent policy. Actor identity does not itself grant authority.
 * Order: bypass/questions → validation → path checks → Plan/Auto → scoped
 * approvals → mode defaults → approval (or Don't Ask denial).
 */
export async function evaluatePermission(request: PermissionRequest): Promise<PermissionDecision> {
  const { mode, tool, input, workspaceRoot, cwd } = request;
  let pathPolicy: PathPolicyResult | undefined;
  let bash: BashAnalysis | undefined;
  let bashFingerprint: string | undefined;
  let canonicalCwd: string | undefined;
  const result = (decision: PermissionDecision["decision"], reason: string): PermissionDecision =>
    ({ decision, source: "policy", reason, ...(pathPolicy ? { pathPolicy } : {}),
      ...(bash ? { bash, bashFingerprint, canonicalCwd } : {}) });
  if (tool === "AskQuestion") return result("allow", "pre-approved");
  if (request.actor?.kind === "worker") {
    const scope = request.actor.scope;
    if (!scope || !WORKER_TOOLS.has(tool) || tool === "bash" && !scope.bash) return result("deny", "outside-worker-capabilities");
    pathPolicy = await evaluatePathPolicy(tool, input, workspaceRoot, cwd);
    if (pathPolicy?.decision === "deny") return result("deny", pathPolicy.reason);
    if (pathPolicy && (pathPolicy.decision !== "allow" || !inTaskScope(pathPolicy.path, workspaceRoot, scope)))
      return result("deny", "outside-worker-path-scope");
    if (tool === "bash") {
      if (!input || typeof input !== "object" || typeof (input as { command?: unknown }).command !== "string") return result("deny", "malformed-input");
      bash = await analyzeBash((input as { command: string }).command, cwd, workspaceRoot);
      if (bash.blockedReason || bash.findings.includes("external-filesystem-target")) return result("deny", "outside-worker-command-scope");
    }
  }
  if (mode === "bypassPermissions") return result("allow", "pre-approved");
  if (!input || typeof input !== "object" || Array.isArray(input)) return result("deny", "malformed-input");
  if (tool === "bash" && (typeof (input as { command?: unknown }).command !== "string" ||
    !(input as { command: string }).command.trim())) return result("deny", "malformed-input");
  if (request.actor?.kind === "worker" && mode === "auto" && EDIT_TOOLS.has(tool))
    return result("require-model-review", "delegated-mutation-review");
  if (TASK_TOOLS.has(tool)) {
    if (["task_status", "task_cancel", "task_diff"].includes(tool)) return result("allow", "task-inspection-or-cancellation");
    if (mode === "plan" || mode === "dontAsk") return result("deny", "task-mutation-not-permitted");
    if (tool === "task_apply" || tool === "task_clean") return result("allow", "task-handler-must-confirm");
    const task = (input as { task?: unknown }).task;
    if (typeof task !== "string" || !task.trim() || task.length > 20000) return result("deny", "malformed-task");
    return result(mode === "auto" ? "require-model-review" : "require-approval", "delegation-requires-authorization");
  }
  pathPolicy ??= await evaluatePathPolicy(tool, input, workspaceRoot, cwd);
  if (pathPolicy?.decision === "deny") return result("deny", pathPolicy.reason);
  if (mode === "plan") {
    return READ_TOOLS.has(tool) && pathPolicy?.decision === "allow"
      ? result("allow", "project-local-pre-approved-read") : result("deny", "plan-read-only");
  }
  if (tool === "bash") {
    bash ??= await analyzeBash((input as { command: string }).command, cwd, workspaceRoot);
    if (mode === "auto" && bash.blockedReason) return result("deny", bash.blockedReason);
    if (bash.safe) return result("allow", "pre-approved-shell-builtin");
    if (bash.grantFamily) {
      bashFingerprint = await bashApprovalFingerprint((input as { command: string }).command, cwd, workspaceRoot);
      if (bashFingerprint) canonicalCwd = await realpath(cwd);
      else bash.findings.push("reusable-grant-unavailable");
    }
  }
  if (mode === "auto") {
    if (!AUTO_KNOWN_TOOLS.has(tool)) return result("deny", "unsupported-tool");
    if (pathPolicy?.decision === "review") {
      if (pathPolicy.scope === "sensitive") return result("deny", pathPolicy.reason);
      if (matchesApproval(request, pathPolicy)) return result("allow", "session-approval");
      return result("require-model-review", pathPolicy.reason);
    }
    if (READ_TOOLS.has(tool)) return result("allow", "project-local-pre-approved-read");
    if (EDIT_TOOLS.has(tool) && pathPolicy?.decision === "allow")
      return result("allow", "project-local-pre-approved-edit");
    if (matchesApproval(request, pathPolicy, bash, bashFingerprint, canonicalCwd)) return result("allow", "session-approval");
    return result("require-model-review", "requires-model-review");
  }
  if (matchesApproval(request, pathPolicy, bash, bashFingerprint, canonicalCwd)) return result("allow", "session-approval");
  if (pathPolicy?.decision === "allow" && (READ_TOOLS.has(tool) || mode === "acceptEdits" && EDIT_TOOLS.has(tool)))
    return result("allow", "mode-pre-approved");
  if (mode === "dontAsk") return result("deny", "not-pre-approved");
  return result("require-approval", pathPolicy?.decision === "review" ? pathPolicy.reason : "approval-required");
}

/** Compatibility API; all decisions now come from the shared evaluator. */
export async function evaluateAutoPolicy(
  tool: string,
  input: unknown,
  workspaceRoot: string,
  cwd: string = workspaceRoot
): Promise<DeterministicPermissionDecision> {
  const result = await evaluatePermission({ mode: "auto", tool, input, workspaceRoot, cwd });
  return { ...result, decision: result.decision === "require-model-review" || result.decision === "require-approval" ? "review" : result.decision };
}

export function statusFor(mode: Mode): string { return MODE_LABELS[mode]; }
