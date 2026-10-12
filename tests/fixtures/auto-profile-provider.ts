// Deterministic offline provider for automatic profile runtime integration tests.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi: any) {
  pi.registerProvider("piexis-auto", {
    api: "piexis-auto-api",
    apiKey: "disposable-offline-key",
    baseUrl: "http://unused.invalid",
    models: ["main", "plan", "orchestrator", "debug", "ask", "code"].map((id) => ({
      id, name: id, reasoning: true, input: ["text"], contextWindow: 32_000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const prompt = context.systemPrompt ?? context.messages.filter((message: any) => message.role === "system")
          .map((message: any) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
        const profile = /Piexis agent profile: (plan|orchestrator|debug|ask|code)/.exec(prompt)?.[1] ?? "missing";
        const report = JSON.stringify({ profile, model: `${model.provider}/${model.id}`, effort: options?.reasoning ?? "off" });
        const message: any = {
          role: "assistant", api: "piexis-auto-api", provider: model.provider, model: model.id,
          timestamp: Date.now(), content: [], stopReason: "pending",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        const block = { type: "text" as const, text: report };
        message.content = [block];
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: report, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: report, partial: message });
        message.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
}
