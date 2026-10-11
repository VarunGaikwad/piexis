// Deterministic, offline provider for the real CLI/subagent integration test.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi: any) {
  pi.registerProvider("piexis-test", {
    api: "piexis-test-api",
    apiKey: "disposable-test-key",
    baseUrl: "http://unused.invalid",
    models: ["main", "small"].map((id) => ({
      id, name: id, reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const last = context.messages.at(-1);
        const depth = Number(process.env.PIEXIS_SUBAGENT_DEPTH ?? 0);
        const delegated = depth > 0;
        const orchestration = !delegated && JSON.stringify(last?.content).includes("orchestrator");
        const exploration = !delegated && JSON.stringify(last?.content).includes("exploration");
        const orchestrator = /Piexis agent profile: orchestrator/.test(context.systemPrompt ?? JSON.stringify(context.messages.filter((message: any) => message.role === "system")));
        const delegate = last?.role === "user" && (!delegated || (depth === 1 && orchestrator));
        const content = delegate
          ? [{ type: "toolCall", id: `delegate-${depth}`, name: "subagent", arguments: {
            agent: orchestration ? "orchestrator" : "ask", ...(exploration ? { purpose: "explore" } : {}),
            task: orchestration ? "Coordinate a configuration lookup" : "Locate the configuration loader",
          } }]
          : [{ type: "text", text: delegated
            ? (orchestrator ? `orchestrated:${JSON.stringify(last?.content)}` : `child:${model.id};depth:${depth}`)
            : "parent completed" }];
        const message = {
          role: "assistant", api: "piexis-test-api", provider: model.provider, model: model.id,
          timestamp: Date.now(), content: [], stopReason: "pending",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "start", partial: message });
        message.content = content as any;
        const block = content[0];
        if (block.type === "toolCall") {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: message });
        } else {
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: message });
        }
        message.stopReason = block.type === "toolCall" ? "toolUse" : "stop";
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
