import { createHash } from "node:crypto";

export type DenialLimits = { repeated: number; total: number };
export const DEFAULT_DENIAL_LIMITS: DenialLimits = { repeated: 3, total: 6 };

export function denialLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === false) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 50)
    throw new Error("Permission denial limits must be integers from 1 to 50.");
  return Number(value);
}

/** Per user request, not per tool/turn. Successful calls do not erase denials. */
export class DenialTracker {
  private actions = new Map<string, number>();
  total = 0;
  stopped = false;
  revision = 0;
  limits: DenialLimits;
  constructor(limits: DenialLimits = DEFAULT_DENIAL_LIMITS) { this.limits = { ...limits }; }
  reset(): void { this.actions.clear(); this.total = 0; this.stopped = false; this.revision++; }
  deny(tool: string, input: unknown): { repeated: number; total: number; stopped: boolean } {
    const key = createHash("sha256").update(tool).update(JSON.stringify(input) ?? "null").digest("hex");
    const repeated = (this.actions.get(key) ?? 0) + 1;
    if (!this.stopped) {
      this.actions.set(key, repeated);
      this.total++;
      this.stopped = repeated >= this.limits.repeated || this.total >= this.limits.total;
    }
    return { repeated, total: this.total, stopped: this.stopped };
  }
}
