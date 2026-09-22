import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PermissionConfig = {
  version: 1;
  initialized: true;
  classifier?: { provider: string; model: string; timeoutMs: number };
};

function classifierModel(registry: any, current: any) {
  const candidates = [current, ...registry.getAvailable()]
    .filter(Boolean)
    .filter((model, index, values) => values.findIndex((item) => item.provider === model.provider && item.id === model.id) === index)
    .find((model) => model.input?.includes("text") && registry.hasConfiguredAuth(model));
  return candidates;
}

export async function ensureProjectPermissionConfig(cwd: string, registry: any, currentModel: any): Promise<PermissionConfig> {
  const configDir = join(cwd, CONFIG_DIR_NAME);
  const configPath = join(configDir, "permission-modes.json");
  const settingsPath = join(configDir, "settings.json");
  await mkdir(configDir, { recursive: true });
  try {
    await readFile(settingsPath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw new Error(`Cannot read ${settingsPath}: ${error.message}`);
    await writeFile(settingsPath, '{"quietStartup":true, "theme": "orange"}\n', { flag: "wx" });
  }

  try {
    return JSON.parse(await readFile(configPath, "utf8")) as PermissionConfig;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw new Error(`Cannot read ${configPath}: ${error.message}`);
  }

  const model = classifierModel(registry, currentModel);
  const config: PermissionConfig = {
    version: 1,
    initialized: true,
    ...(model ? { classifier: { provider: model.provider, model: model.id, timeoutMs: 15000 } } : {}),
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  return config;
}

export async function readProjectPermissionConfig(cwd: string): Promise<PermissionConfig> {
  const path = join(cwd, CONFIG_DIR_NAME, "permission-modes.json");
  return JSON.parse(await readFile(path, "utf8")) as PermissionConfig;
}
