export const agentNames = ["plan", "orchestrator", "debug", "ask", "code"] as const;
export type AgentName = typeof agentNames[number];
export const effortLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = typeof effortLevels[number];

export const agentConfigSchemaUrl = "https://raw.githubusercontent.com/VarunGaikwad/piexis/main/schemas/agent.schema.json";

export interface AgentConfig {
  "$schema"?: string;
  model?: string;
  small_model?: string;
  subagent_model?: string;
  delegate_exploration?: boolean;
  subagent_variant_overrides?: Partial<Record<AgentName, { model?: string; effort?: Effort }>>;
}

/**
 * Static values written to a newly created .pi/agent.json.
 * Add new static AgentConfig properties here so project setup includes them.
 */
export const initialAgentConfigDefaults = {
  "$schema": agentConfigSchemaUrl,
  delegate_exploration: false,
} satisfies Pick<AgentConfig, "$schema" | "delegate_exploration">;

/** Header copy for incomplete project agent configuration. */
export type AgentConfigSetting = Exclude<keyof AgentConfig, "$schema">;

export const agentConfigCapabilities = {
  model: "choose the default main model",
  small_model: "use a cheaper model for eligible small tasks",
  subagent_model: "choose the normal model for delegated work",
  delegate_exploration: "opt in to cheap, read-only codebase exploration",
  subagent_variant_overrides: "customize model and effort for each agent profile",
} satisfies Record<AgentConfigSetting, string>;

export function createInitialAgentConfig(selected: string, inherited: AgentConfig): AgentConfig {
  const efforts: Record<AgentName, Effort> = { plan: "high", orchestrator: "high", debug: "high", ask: "low", code: "medium" };
  const overrides: NonNullable<AgentConfig["subagent_variant_overrides"]> = {};
  for (const name of agentNames) {
    overrides[name] = {
      model: inherited.subagent_model ?? selected,
      effort: efforts[name],
      ...inherited.subagent_variant_overrides?.[name],
    };
  }
  return {
    "$schema": initialAgentConfigDefaults.$schema,
    model: selected,
    small_model: inherited.small_model ?? selected,
    subagent_model: inherited.subagent_model ?? selected,
    delegate_exploration: inherited.delegate_exploration ?? initialAgentConfigDefaults.delegate_exploration,
    subagent_variant_overrides: overrides,
  };
}
