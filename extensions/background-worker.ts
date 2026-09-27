import { createReadTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool, createBashTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requestWorkerPermission } from "../lib/task-broker.ts";
import { WORKER_TOOLS } from "../lib/task-permissions.ts";
import { DenialTracker, denialLimit, DEFAULT_DENIAL_LIMITS } from "../lib/permission-denials.ts";
import { redactIntentSecrets } from "../lib/permission-intent.ts";

export default function (pi: ExtensionAPI) {
  // Explicitly loaded only by the task launcher; never guard a foreground process.
  const broker = process.env.PIEXIS_TASK_BROKER;
  if (!broker) return;
  const token = process.env.PIEXIS_TASK_TOKEN ?? "";
  const allowBash = process.env.PIEXIS_TASK_BASH === "1";
  const tools = [createReadTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool,
    ...(allowBash ? [createBashTool] : [])].map((create) => create(process.cwd()));
  const names = new Map(tools.map((tool) => [`worker_${tool.name}`, tool.name]));
  let validLimits = true;
  let limits = DEFAULT_DENIAL_LIMITS;
  try {
    limits = { repeated: denialLimit(process.env.PIEXIS_TASK_REPEAT_LIMIT, limits.repeated), total: denialLimit(process.env.PIEXIS_TASK_DENIAL_LIMIT, limits.total) };
  } catch { validLimits = false; }
  const denials = new DenialTracker(limits);
  // tool_execution_start is also emitted for blocked calls. tool_result runs
  // only after actual tool execution, so record verification here instead.
  pi.on("tool_result", (event) => {
    if (names.get(event.toolName) !== "bash") return;
    const command = redactIntentSecrets(String(event.input.command ?? ""));
    pi.appendEntry("piexis-worker-execution", {
      id: event.toolCallId, command: command.slice(0, 2000), isError: event.isError,
      ...(command.length > 2000 ? { truncated: true } : {})
    });
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "AskQuestion") return;
    if (denials.stopped) { ctx.abort(); return { block: true, reason: "Worker permission denial limit reached." }; }
    let answer;
    const tool = names.get(event.toolName);
    if (!validLimits || !token || !tool || !WORKER_TOOLS.has(tool) || tool === "bash" && !allowBash) {
      answer = { outcome: "denied", reason: "Tool is outside the delegated worker capability set; recursive delegation is unavailable." };
    } else {
      answer = await requestWorkerPermission(broker, token, tool!, event.input, ctx.signal);
    }
    if (answer.outcome === "allowed" && !ctx.signal?.aborted) return;
    const state = denials.deny(event.toolName, event.input);
    if (!validLimits || state.stopped || ["cancelled", "expired", "unavailable"].includes(answer.outcome)) ctx.abort();
    return { block: true, reason: `${answer.reason ?? `Worker permission ${answer.outcome}.`} Do not use another tool to perform the denied action.` };
  });
  // Only these aliases are selected by the launcher. If this extension fails to
  // load, its tools do not exist; Pi cannot fall back to unguarded built-in tools.
  for (const tool of tools) pi.registerTool({ ...tool, name: `worker_${tool.name}` } as ToolDefinition);
}
