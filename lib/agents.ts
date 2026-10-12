import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { agentNames, createInitialAgentConfig, effortLevels, type AgentConfig, type AgentName, type Effort } from "./agent-config.ts";

export { agentNames, type AgentConfig, type AgentName, effortLevels, type Effort } from "./agent-config.ts";

export const profiles: Record<AgentName, string> = {
  plan: "Explore the request and relevant code, clarify important unknowns, and return an actionable plan with acceptance checks. Do not implement or delegate implementation. Stop after the plan.",
  orchestrator: "Break work into focused tasks and delegate to plan, debug, ask, or code using subagent. Include all necessary context in each task; children do not inherit the conversation. Declare mode: read for read-only work and mode: write with precise repository-relative paths for edits. Divide parallel work by non-overlapping ownership; at most two jobs can run concurrently. Leave uncertain, overlapping, or shared-configuration writes sequential. Do not edit the workspace yourself while write children are running. Inspect results, reconcile integration issues, and run final verification after all children settle. Do not delegate the same orchestration task recursively.",
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
    if (!["$schema", "model", "small_model", "subagent_model", "delegate_exploration", "auto_profile", "subagent_variant_overrides"].includes(key)) {
      throw new Error(`Unknown agent configuration key: ${key}`);
    }
  }
  if (source.$schema !== undefined) {
    if (typeof source.$schema !== "string") throw new Error("$schema must be a string");
    result.$schema = source.$schema;
  }
  for (const key of ["model", "small_model", "subagent_model"] as const) {
    if (source[key] !== undefined) result[key] = model(source[key], key);
  }
  if (source.delegate_exploration !== undefined) {
    if (typeof source.delegate_exploration !== "boolean") throw new Error("delegate_exploration must be a boolean");
    result.delegate_exploration = source.delegate_exploration;
  }
  if (source.auto_profile !== undefined) {
    if (typeof source.auto_profile !== "boolean") throw new Error("auto_profile must be a boolean");
    result.auto_profile = source.auto_profile;
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
    const config = createInitialAgentConfig(selected, inherited);
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

export async function completeProjectAgentConfig(cwd: string, agentDir: string, defaultModel: string | undefined, signal?: AbortSignal): Promise<"created" | "updated" | "complete"> {
  const directory = join(cwd, ".pi");
  let path: string | undefined;
  for (const name of ["agent.json", "agents.json"]) {
    const candidate = join(directory, name);
    try { await lstat(candidate); path = candidate; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!path) {
    if (!await initializeAgentConfig(cwd, agentDir, defaultModel, signal)) return "complete";
    return "created";
  }
  return withFileMutationQueue(path, async () => {
    signal?.throwIfAborted();
    if (!(await lstat(path!)).isFile()) throw new Error(`${path} must be a regular file`);
    const source = parseAgentConfig(JSON.parse(await readFile(path!, "utf8")));
    const inherited = await loadAgentConfig(cwd, agentDir, false);
    const selected = source.model ?? inherited.model ?? (defaultModel ? model(defaultModel, "Default model") : undefined);
    if (!selected) throw new Error("No active model; select a model and configure .pi/agent.json manually.");
    const defaults = createInitialAgentConfig(selected, inherited);
    const overrides: NonNullable<AgentConfig["subagent_variant_overrides"]> = {};
    let changed = Object.keys(defaults).some((key) => source[key as keyof AgentConfig] === undefined);
    for (const name of agentNames) {
      const expected = defaults.subagent_variant_overrides![name]!;
      const actual = source.subagent_variant_overrides?.[name];
      if (!actual?.model || actual.effort === undefined) changed = true;
      overrides[name] = { ...expected, ...actual };
    }
    if (!changed) return "complete";
    const config: AgentConfig = { ...defaults, ...source, subagent_variant_overrides: overrides };
    const temporary = join(directory, `.${basename(path!)}.piexis-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      signal?.throwIfAborted();
      await rename(temporary, path!);
      return "updated";
    } finally { await rm(temporary, { force: true }); }
  });
}

const profileIntentRules: [AgentName, RegExp][] = [
  ["plan", /^(?:let'?s\s+plan|(?:make|create)\s+(?:me\s+)?(?:a\s+)?plan|help\s+me\s+plan|plan)\b/i],
  ["debug", /^(?:help\s+me\s+)?(?:debug|investigate|fix\s+(?:a\s+|the\s+|this\s+)?(?:bug|error|crash|failure))\b/i],
  ["orchestrator", /^(?:orchestrate|coordinate|delegate)\b/i],
  ["code", /^(?:implement|build|write|execute)\b/i],
  ["ask", /^(?:explain|answer(?:\s+(?:this\s+)?question)?|what|how|why|where|when|who)\b/i],
];
const politePrefix = /^(?:(?:please|kindly|hey)[,\s]+|(?:could|would|can)\s+you\s+)+/i;

export function detectProfileIntent(text: string): AgentName | undefined {
  const input = text.trim().replace(/\u2019/g, "'").replace(politePrefix, "");
  if (!input || /^[/`>~"'\u201c\u2018]/.test(input)) return undefined;
  const match = profileIntentRules.find(([, expression]) => expression.test(input));
  if (!match) return undefined;
  const [profile, expression] = match;
  const rest = input.slice(input.match(expression)![0].length);
  if (profile !== "ask" && /^\s+(?:is|means|refers\s+to)\b/i.test(rest)) return undefined;
  // shortcut: bounded English outer-action rules; expand only with evaluated intent examples.
  const nested = /^(?:\s+(?:how|why|what|when|where)\b)|\bto\s+(?:debug|investigate|implement|build|write|execute)\b/i.test(rest);
  if (!nested) {
    const ownText = rest.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`|"[^"]*"|“[^”]*”|'[^']*'|‘[^’]*’/g, "");
    for (const clause of ownText.split(/\b(?:and(?:\s+then)?|then|but|also)\s+|[.!?]\s+|\n+/i).slice(1)) {
      const other = profileIntentRules.find(([, rule]) => rule.test(clause.trim().replace(politePrefix, "")));
      if (other && other[0] !== profile) return undefined;
    }
  }
  return profile;
}

export function isSmallTask(agent: AgentName, task: string): boolean {
  // shortcut: conservative text heuristic, replace with evaluated routing if real tasks outgrow it.
  if (task.length > 400 || task.split(/\s+/).length > 65) return false;
  if (/\b(architect\w*|design|implement|investigate|debug|refactor|migrat\w*|security|race|performance|across|multiple|entire|comprehensive)\b/i.test(task)) return false;
  if (agent === "ask") return /^\s*(find|locate|list|what (is|does|file)|where (is|are)|explain|summari[sz]e)\b/i.test(task);
  if (agent === "code") return /^\s*(fix (a |the )?typo|correct (a |the )?typo|rename (a |the )?(variable|symbol)|update (a |the )?(comment|label))\b/i.test(task);
  return false;
}

export function routeSubagent(config: AgentConfig, agent: AgentName, task: string, currentModel: string, currentEffort: Effort, exploration = false) {
  if (exploration) {
    if (!config.small_model) throw new Error("Exploration delegation requires small_model in agent.json");
    return { model: config.small_model, effort: "low" as Effort, reason: "configured exploration small model" };
  }
  const override = config.subagent_variant_overrides?.[agent];
  const small = Boolean(config.small_model && isSmallTask(agent, task) && !override?.model);
  return {
    model: override?.model ?? (small ? config.small_model! : config.subagent_model ?? currentModel),
    effort: override?.effort ?? (small ? "low" : currentEffort),
    reason: override?.model ? "variant override" : small ? "automatic small task" : "default subagent",
  };
}

export function subagentTools(agent: AgentName, active: string[], depth: number, allowExplorationDelegation = false): string[] {
  if (agent === "plan" || agent === "ask") {
    return active.filter((name) => ["read", "grep", "find", "ls"].includes(name) || (allowExplorationDelegation && depth < 2 && name === "subagent"));
  }
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
