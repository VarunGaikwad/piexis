import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, Transcript } from "../../apps/web/src/components/transcript.tsx";

test("Markdown renders common GFM elements", () => {
  const html = renderToStaticMarkup(createElement(Markdown, {
    value: "# Heading\n\n- one\n- *two*\n\n[docs](https://example.test)\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n`inline`\n\n```ts\nconst value = 1;\n```",
  }));

  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<em>two<\/em>/);
  assert.match(html, /<a href="https:\/\/example.test" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(html, /<table>/);
  assert.match(html, /<code class="language-ts">const value = 1;/);
});

test("Markdown does not execute raw HTML or unsafe link protocols", () => {
  const html = renderToStaticMarkup(createElement(Markdown, {
    value: "<script>alert('x')</script>\n\n[bad](javascript:alert('x'))\n\n![tracker](https://example.test/pixel.png)",
  }));

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /bad/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /\[Image: tracker\]/);
});

test("transcripts show text messages without mislabelling tool-only records", () => {
  const html = renderToStaticMarkup(createElement(Transcript, {
    messages: [
      { role: "toolResult", content: "hidden tool output" },
      { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
      { role: "assistant", content: [{ type: "text", text: "Visible answer" }] },
      { role: "user", content: "Visible prompt" }
    ],
    stream: ""
  }));
  assert.doesNotMatch(html, /hidden tool output/);
  assert.equal((html.match(/<article/g) || []).length, 2);
  assert.match(html, /Visible answer/);
  assert.match(html, /Visible prompt/);
});
