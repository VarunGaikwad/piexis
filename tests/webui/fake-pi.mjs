let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n"); buffer = lines.pop();
  for (const line of lines) {
    const command = JSON.parse(line);
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { accepted: true } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" } }) + "\n", () => process.exit(0));
  }
});
