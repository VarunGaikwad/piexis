// Offline provider exercising native tools and a nested guardian review in the real Pi runtime.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi: any) {
  pi.registerProvider("health-test", {
    api: "health-test-api", apiKey: "disposable-test-key", baseUrl: "http://unused.invalid",
    models: [{ id: "configured", name: "Guardian fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const review = context.systemPrompt?.includes("You are a read-only code-health reviewer");
        if (review) process.stderr.write(`guardian-review:${model.id}\n`);
        const write = !review && context.messages.at(-1)?.role === "user";
        const content = write ? [{ type: "toolCall", id: "health-edit", name: "write", arguments: {
          path: "main.py", content: `x=1\ndef work(a,b,c,d,e,f,g,h):\n${"    step(a)\n".repeat(65)}`,
        } }] : [{ type: "text", text: review ? "Proposal: review function cohesion; preserve APIs and validate behavior." : "Task complete." }];
        const message: any = { role: "assistant", api: "health-test-api", provider: model.provider, model: model.id, timestamp: Date.now(),
          content: [], stopReason: "pending", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message });
        message.content = content;
        const block = content[0];
        if (write) {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block as any, partial: message });
        } else {
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: block.text!, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: block.text!, partial: message });
        }
        message.stopReason = write ? "toolUse" : "stop";
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
