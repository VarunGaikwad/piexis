import { spawn } from "node:child_process";
import { devNull } from "node:os";

/** Internal Git operations never run hooks, external diff/textconv, or inherited
 * GIT_* overrides. Snapshot code hashes bytes directly, bypassing clean filters.
 */
export function taskGitBytes(args: string[], cwd: string, options: {
  env?: Record<string, string>; input?: Buffer | string; allowedCodes?: number[]; maxBytes?: number;
} = {}): Promise<Buffer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, options.env);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`,
      "-c", "core.untrackedCache=false", ...args], { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    let bytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) { overflow = true; child.kill("SIGTERM"); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", reject);
    child.stdin.on("error", () => { /* Process termination may close stdin early. */ });
    child.stdin.end(options.input);
    child.on("close", (code) => {
      if (overflow) reject(new Error("Git output exceeded the task inspection limit."));
      else if ((options.allowedCodes ?? [0]).includes(code ?? -1)) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr.trim() || `Git exited ${code}`));
    });
  });
}

export async function taskGit(args: string[], cwd: string, options: Parameters<typeof taskGitBytes>[2] = {}): Promise<string> {
  return (await taskGitBytes(args, cwd, options)).toString("utf8");
}

export async function disabledTaskFilters(cwd: string): Promise<string[]> {
  const keys = await taskGit(["config", "--null", "--name-only", "--get-regexp", "^filter\\."], cwd, { allowedCodes: [0, 1] });
  const names = new Set(keys.split("\0").map((key) => key.match(/^filter\.(.+)\.(clean|smudge|process|required)$/s)?.[1]).filter(Boolean));
  return [...names].flatMap((name) => ["-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`]);
}
