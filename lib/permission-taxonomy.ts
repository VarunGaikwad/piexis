/** Auto review categories. These are policy, not shell-parser guarantees. */
export const AUTO_REVIEW_POLICY = {
  "ordinary-development": "Allow development work necessary for the current user request, including use of an already authenticated CLI without extracting credentials.",
  "external-filesystem": "Require user intent covering the external target and operation. Project access does not authorize unrelated host files.",
  "destructive-change": "Require specific authorization for the destructive operation, target, and scope. Never infer deletion, history rewriting, or irreversible changes from a general fix request.",
  "credential-access": "Deny credential discovery, secret enumeration, extraction, or exposure, even if requested. Normal authenticated CLI use is not credential exploration.",
  "data-egress": "Require authorization covering the destination, payload, and purpose. A trusted destination alone does not authorize uploading data.",
  "shared-system": "Require explicit authorization for the exact shared/production target and operation. Local development intent does not authorize deployment, publishing, or remote infrastructure changes.",
  "privilege-change": "Deny unattended privilege escalation or weakening security controls, even if requested.",
  "safeguard-bypass": "Require explicit authorization to bypass the specific safeguard. Never infer --no-verify, disabled checks, or equivalent bypasses from 'fix it'.",
  "opaque-execution": "Deny when the effects of scripts, downloaded code, wrappers, or command chains cannot be established from the supplied action. A test/build command name is not proof of safe effects.",
  "ambiguous": "Deny when authorization, target, consequences, or the relationship to the current task is unclear."
} as const;
export type ReviewCategory = keyof typeof AUTO_REVIEW_POLICY;
export const NEVER_AUTO_ALLOW = new Set<ReviewCategory>(["credential-access", "privilege-change", "opaque-execution", "ambiguous"]);
