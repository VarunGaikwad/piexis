import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PermissionConfig = {
  version: 1;
  initialized: true;
  classifier?: { provider: string; model: string; timeoutMs: number };
  /** Models permitted for isolated background tasks. An empty list disables them. */
  background?: { models: string[] };
};

function validString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateConfig(value: unknown): PermissionConfig {
  if (!value || typeof value !== "object") throw new Error("permission-modes.json must contain an object.");
  const config = value as any;
  if (config.version !== 1 || config.initialized !== true)
    throw new Error("permission-modes.json must have version 1 and initialized: true.");
  if (config.classifier !== undefined) {
    const classifier = config.classifier;
    if (!classifier || !validString(classifier.provider) || !validString(classifier.model) ||
      !Number.isFinite(classifier.timeoutMs) || classifier.timeoutMs < 1000)
      throw new Error("permission-modes.json has an invalid classifier configuration.");
  }
  if (config.background !== undefined) {
    if (!config.background || !Array.isArray(config.background.models) ||
      !config.background.models.every((model: unknown) => validString(model) && /^[^/]+\/.+$/.test(model)))
      throw new Error("permission-modes.json has an invalid background.models list.");
  }
  return config as PermissionConfig;
}

function classifierModel(registry: any, current: any) {
  const candidates = [current, ...registry.getAvailable()]
    .filter(Boolean)
    .filter((model, index, values) => values.findIndex((item) => item.provider === model.provider && item.id === model.id) === index)
    .find((model) => model.input?.includes("text") && registry.hasConfiguredAuth(model));
  return candidates;
}

export async function initializeProjectPermissionConfig(cwd: string, registry: any, currentModel: any): Promise<PermissionConfig> {
  const configDir = join(cwd, CONFIG_DIR_NAME);
  const configPath = join(configDir, "permission-modes.json");
  const settingsPath = join(configDir, "settings.json");
  await mkdir(configDir, { recursive: true });
  try {
    await readFile(settingsPath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw new Error(`Cannot read ${settingsPath}: ${error.message}`);
    await writeFile(settingsPath, '{"quietStartup":true}\n', { flag: "wx" });
  }

  try {
    return validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw new Error(`Cannot read ${configPath}: ${error.message}`);
  }

  const model = classifierModel(registry, currentModel);
  const config: PermissionConfig = {
    version: 1,
    initialized: true,
    ...(model ? {
      classifier: { provider: model.provider, model: model.id, timeoutMs: 15000 },
      background: { models: [`${model.provider}/${model.id}`] }
    } : {}),
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  return config;
}

export function defaultPermissionConfig(): PermissionConfig {
  return { version: 1, initialized: true };
}

/** Read project configuration without making startup mutate the project. */
export async function readProjectPermissionConfig(cwd: string): Promise<PermissionConfig> {
  const path = join(cwd, CONFIG_DIR_NAME, "permission-modes.json");
  try {
    return validateConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error: any) {
    if (error?.code === "ENOENT") return defaultPermissionConfig();
    throw error;
  }
}

/** @deprecated Use initializeProjectPermissionConfig for explicit initialization only. */
export const ensureProjectPermissionConfig = initializeProjectPermissionConfig;
