import { z } from "zod";

export const codeHealthSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["observe", "safe", "autonomous"]).optional(),
  analyzeChangedFiles: z.boolean().optional(),
  reviewAtTaskCompletion: z.boolean().optional(),
  largeFileThresholdLines: z.number().int().min(50).max(20_000).optional(),
  enableComplexityChecks: z.boolean().optional(),
  enableDuplicationChecks: z.boolean().optional(),
  enableArchitectureChecks: z.boolean().optional(),
  enableAiReview: z.boolean().optional(),
  enableRuff: z.boolean().optional(),
  exclude: z.array(z.string().min(1).max(300)).max(100).optional(),
  maxFilesPerReview: z.number().int().min(1).max(100).optional(),
  maxAutomaticFixesPerTask: z.number().int().min(0).max(20).optional(),
  requireValidation: z.boolean().optional(),
  cooldownMs: z.number().int().min(1000).max(3_600_000).optional(),
  maxReviewMs: z.number().int().min(1000).max(120_000).optional(),
  maxAiOutputTokens: z.number().int().min(128).max(4096).optional(),
}).strict();

export type CodeHealthSettings = z.infer<typeof codeHealthSchema>;
export const codeHealthDefaults = {
  enabled: true,
  mode: "safe",
  analyzeChangedFiles: true,
  reviewAtTaskCompletion: true,
  largeFileThresholdLines: 800,
  enableComplexityChecks: true,
  enableDuplicationChecks: true,
  enableArchitectureChecks: true,
  enableAiReview: true,
  enableRuff: false,
  exclude: ["node_modules/**", "dist/**", "build/**", "target/**", ".venv/**", "**/generated/**"],
  maxFilesPerReview: 30,
  maxAutomaticFixesPerTask: 5,
  requireValidation: true,
  cooldownMs: 15_000,
  maxReviewMs: 30_000,
  maxAiOutputTokens: 1024,
} satisfies Required<CodeHealthSettings>;
export type CodeHealthConfig = Required<CodeHealthSettings>;
export function resolveCodeHealth(settings?: CodeHealthSettings): CodeHealthConfig {
  return { ...codeHealthDefaults, ...codeHealthSchema.parse(settings ?? {}) };
}
