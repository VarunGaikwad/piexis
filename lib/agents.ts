import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const agentNames = ["plan", "orchestrator", "debug", "ask", "code"] as const;
export type AgentName = typeof agentNames[number];
export const effortLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = typeof effortLevels[number];
export interface AgentConfig {
  model?: string;
  small_model?: string;
  subagent_model?: string;
  subagent_variant_overrides?: Partial<Record<AgentName, { model?: string; effort?: Effort }>>;
}

export const profiles: Record<AgentName, string> = {
  plan: "Explore the request and relevant code, clarify important unknowns, and return an actionable plan with acceptance checks. Do not implement or delegate implementation. Stop after the plan.",
  orchestrator: "Break work into focused tasks and delegate to plan, debug, ask, or code using subagent. Include all necessary context in each task; children do not inherit the conversation. Keep overlapping file changes sequential. Inspect results, resolve disagreements, and report verification evidence. Do not delegate the same orchestration task recursively.",
  debug: "Reproduce or establish evidence for the failure, trace its cause before editing, and make the smallest justified fix. Verify with a regression check. Separate confirmed facts from hypotheses and report any unexecuted checks.",
  ask: "Answer the user's question using relevant code or documentation as evidence. Do not change files or delegate changes. When context is missing, ask rather than invent facts. Stop when the question is answered.",
  code: "Implement the requested scope using existing repository patterns. Preserve unrelated changes, add focused coverage for behavior changes, run relevant checks, and report results. Stop when acceptance conditions are met.",
};

export function isAgentName(value: unknown): value is AgentName {
  return typeof value === "string" && agentNames.includes(value as AgentName);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function model(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[^\s/]+\/\S+$/.test(value)) {
    throw new Error(`${label} must be an exact provider/model ID`);
  }
  return value;
}

export function parseAgentConfig(value: unknown): AgentConfig {
  const source = object(value, "Agent configuration");
  const result: AgentConfig = {};
  for (const key of Object.keys(source)) {
    if (!["model", "small_model", "subagent_model", "subagent_variant_overrides"].includes(key)) {
      throw new Error(`Unknown agent configuration key: ${key}`);
    }
  }
  for (const key of ["model", "small_model", "subagent_model"] as const) {
    if (source[key] !== undefined) result[key] = model(source[key], key);
  }
  if (source.subagent_variant_overrides !== undefined) {
    result.subagent_variant_overrides = {};
    for (const [name, value] of Object.entries(object(source.subagent_variant_overrides, "subagent_variant_overrides"))) {
      if (!isAgentName(name)) throw new Error(`Unknown agent variant: ${name}`);
      const override = object(value, `Override ${name}`);
      for (const key of Object.keys(override)) {
        if (key !== "model" && key !== "effort") throw new Error(`Unknown override key: ${name}.${key}`);
      }
      const parsed: { model?: string; effort?: Effort } = {};
      if (override.model !== undefined) parsed.model = model(override.model, `${name}.model`);
      if (override.effort !== undefined) {
        if (!effortLevels.includes(override.effort as Effort)) throw new Error(`Invalid effort for ${name}`);
        parsed.effort = override.effort as Effort;
      }
      result.subagent_variant_overrides[name] = parsed;
    }
  }
  return result;
}

export async function loadAgentConfig(cwd: string, agentDir: string, trusted: boolean): Promise<AgentConfig> {
  async function load(directory: string): Promise<AgentConfig> {
    for (const name of ["agent.json", "agents.json"]) {
      const path = join(directory, name);
      try { return parseAgentConfig(JSON.parse(await readFile(path, "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {};
  }
  const global = await load(agentDir);
  const project = trusted ? await load(join(cwd, ".pi")) : {};
  const overrides = { ...global.subagent_variant_overrides };
  for (const name of agentNames) {
    if (project.subagent_variant_overrides?.[name]) {
      overrides[name] = { ...overrides[name], ...project.subagent_variant_overrides[name] };
    }
  }
  return { ...global, ...project, subagent_variant_overrides: overrides };
}

export async function hasProjectAgentConfig(cwd: string): Promise<boolean> {
  for (const name of ["agent.json", "agents.json"]) {
    try { await lstat(join(cwd, ".pi", name)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return false;
}

/** Create an opt-in project scaffold atomically, never replace existing or legacy configuration. */
export async function initializeAgentConfig(cwd: string, agentDir: string, defaultModel: string | undefined, signal?: AbortSignal): Promise<boolean> {
  const directory = join(cwd, ".pi");
  const path = join(directory, "agent.json");
  return withFileMutationQueue(path, async () => {
    signal?.throwIfAborted();
    if (await hasProjectAgentConfig(cwd)) return false;
    if (!defaultModel) throw new Error("No active model; select a model and create .pi/agent.json manually.");
    const inherited = await loadAgentConfig(cwd, agentDir, false);
    const selected = inherited.model ?? model(defaultModel, "Default model");
    const efforts: Record<AgentName, Effort> = { plan: "high", orchestrator: "high", debug: "high", ask: "low", code: "medium" };
    const overrides: NonNullable<AgentConfig["subagent_variant_overrides"]> = {};
    for (const name of agentNames) {
      overrides[name] = {
        model: inherited.subagent_model ?? selected,
        effort: efforts[name],
        ...inherited.subagent_variant_overrides?.[name],
      };
    }
    const config: AgentConfig = {
      model: selected,
      small_model: inherited.small_model ?? selected,
      subagent_model: inherited.subagent_model ?? selected,
      subagent_variant_overrides: overrides,
    };
    signal?.throwIfAborted();
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.agent.json.piexis-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      signal?.throwIfAborted();
      if (await hasProjectAgentConfig(cwd)) return false;
      // Unlike rename, link fails if another writer has already created the destination.
      try { await link(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
      return true;
    } finally { await rm(temporary, { force: true }); }
  });
}

export function isSmallTask(agent: AgentName, task: string): boolean {
  // shortcut: conservative text heuristic, replace with evaluated routing if real tasks outgrow it.
  if (task.length > 400 || task.split(/\s+/).length > 65) return false;
  if (/\b(architect\w*|design|implement|investigate|debug|refactor|migrat\w*|security|race|performance|across|multiple|entire|comprehensive)\b/i.test(task)) return false;
  if (agent === "ask") return /^\s*(find|locate|list|what (is|does|file)|where (is|are)|explain|summari[sz]e)\b/i.test(task);
  if (agent === "code") return /^\s*(fix (a |the )?typo|correct (a |the )?typo|rename (a |the )?(variable|symbol)|update (a |the )?(comment|label))\b/i.test(task);
  return false;
}

export function routeSubagent(config: AgentConfig, agent: AgentName, task: string, currentModel: string, currentEffort: Effort) {
  const override = config.subagent_variant_overrides?.[agent];
  const small = Boolean(config.small_model && isSmallTask(agent, task) && !override?.model);
  return {
    model: override?.model ?? (small ? config.small_model! : config.subagent_model ?? currentModel),
    effort: override?.effort ?? (small ? "low" : currentEffort),
    reason: override?.model ? "variant override" : small ? "automatic small task" : "default subagent",
  };
}

export function subagentTools(agent: AgentName, active: string[], depth: number): string[] {
  if (agent === "plan" || agent === "ask") return active.filter((name) => ["read", "grep", "find", "ls"].includes(name));
  return active.filter((name) => name !== "AskQuestion" && (name !== "subagent" || depth < 2));
}

export function childResourceArgs(argv: string[]): string[] {
  const result: string[] = [];
  const values = ["--extension", "-e", "--skill", "--prompt-template", "--system-prompt", "--append-system-prompt"];
  const flags = ["--no-extensions", "-ne", "--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-context-files", "-nc", "--no-mcp", "--offline"];
  for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
    if (values.includes(argv[i]) && argv[i + 1] !== undefined) result.push(argv[i], argv[++i]);
    else if (flags.includes(argv[i])) result.push(argv[i]);
  }
  return result;
}
