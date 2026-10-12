// Deterministic offline provider for the real parallel-subagent scheduler acceptance test.
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

type Call = { id: string; name: "subagent"; arguments: Record<string, unknown> };

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function taskFrom(context: any): string {
  return context.messages.map((message: any) => text(message.content)).join("\n");
}

function scenarioFrom(value: string): string {
  return /scenario:([a-z-]+)/.exec(value)?.[1] ?? "independent";
}

function jobFrom(value: string): string {
  return /job:([abc])/.exec(value)?.[1] ?? "unknown";
}

async function events(cwd: string): Promise<Array<{ event: string; job: string; scenario: string }>> {
  try { return (await readFile(join(cwd, ".parallel-subagents-events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch { return []; }
}

async function childResponse(context: any): Promise<string> {
  const task = taskFrom(context);
  const scenario = scenarioFrom(task);
  const job = jobFrom(task);
  const file = join(process.cwd(), ".parallel-subagents-events.jsonl");
  const scope = process.env.PIEXIS_SUBAGENT_SCOPE ?? "missing";
  // appendFile is one record per transition: the test derives concurrency from this total order,
  // rather than from elapsed time.
  await appendFile(file, `${JSON.stringify({ event: "start", job, scenario, scope, timestamp: Date.now() })}\n`);
  const required = scenario === "independent" ? 2 : 1;
  const deadline = Date.now() + 2_000;
  while ((await events(process.cwd())).filter((entry) => entry.event === "start" && entry.scenario === scenario).length < required) {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await appendFile(file, `${JSON.stringify({ event: "end", job, scenario, scope, timestamp: Date.now() })}\n`);
  return `child:${job};scope:${scope}`;
}

function calls(scenario: string): Call[] {
  const scopes: Record<string, Array<{ mode?: "write"; paths?: string[] }>> = {
    independent: [{ mode: "write", paths: ["a.ts"] }, { mode: "write", paths: ["b.ts"] }, { mode: "write", paths: ["c.ts"] }],
    same: [{ mode: "write", paths: ["same.ts"] }, { mode: "write", paths: ["same.ts"] }, { mode: "write", paths: ["same.ts"] }],
    ancestor: [{ mode: "write", paths: ["src"] }, { mode: "write", paths: ["src/a.ts"] }, { mode: "write", paths: ["src/b.ts"] }],
    broad: [{ mode: "write" }, { mode: "write" }, { mode: "write" }],
    shared: [{ mode: "write", paths: ["package.json"] }, { mode: "write", paths: ["tsconfig.json"] }, { mode: "write", paths: [".pi/agent.json"] }],
  };
  return ["a", "b", "c"].map((job, index) => ({
    type: "toolCall" as const, id: `child-${job}`, name: "subagent",
    arguments: { agent: "code", task: `scenario:${scenario};job:${job}`, ...scopes[scenario][index] },
  }));
}

export default function (pi: any) {
  pi.registerProvider("parallel-test", {
    api: "parallel-test-api", apiKey: "disposable-test-key", baseUrl: "http://unused.invalid",
    models: ["main"].map((id) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 32_000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const depth = Number(process.env.PIEXIS_SUBAGENT_DEPTH ?? 0);
        const task = taskFrom(context);
        const content: any[] = depth > 0
          ? [{ type: "text", text: await childResponse(context) }]
          : context.messages.some((message: any) => message.role === "toolResult")
            ? [{ type: "text", text: "parent completed" }]
            : calls(scenarioFrom(task));
        const message: any = { role: "assistant", api: "parallel-test-api", provider: model.provider, model: model.id,
          timestamp: Date.now(), content: [], stopReason: "pending",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "start", partial: message });
        message.content = content;
        for (let index = 0; index < content.length; index++) {
          const block = content[index];
          if (block.type === "toolCall") {
            stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
          } else {
            stream.push({ type: "text_start", contentIndex: index, partial: message });
            stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: message });
            stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
          }
        }
        message.stopReason = content[0]?.type === "toolCall" ? "toolUse" : "stop";
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      })().catch(() => stream.end());
      return stream;
    },
  });
}
