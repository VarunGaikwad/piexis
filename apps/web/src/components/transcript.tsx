import React, { type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type Message } from "../lib/workspace-state.ts";

const messageText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((item): item is { text?: string } => !!item && typeof item === "object")
    .map((item) => item.text || "")
    .join("\n");
};

function SafeLink({ href, children, node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  const safeHref = href && /^(https?:|mailto:)/i.test(href) ? href : undefined;
  if (!safeHref) return <span>{children}</span>;

  return <a {...props} href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a>;
}

export function Markdown({ value }: { value: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: SafeLink,
        // Model output must not trigger automatic requests to third-party image hosts.
        img: ({ alt }) => <span className="markdown-image-placeholder">[Image: {alt || "attachment"}]</span>
      }}>
        {value}
      </ReactMarkdown>
    </div>
  );
}

export function Transcript({ messages, stream }: { messages: Message[]; stream: string }) {
  const visibleMessages = messages.filter((message) => (message.role === "user" || message.role === "assistant") && messageText(message.content).trim());
  if (!visibleMessages.length && !stream) {
    return (
      <div className="empty-transcript">
        <span className="empty-mark" aria-hidden="true" />
        <b>Ready when you are.</b>
        <p>Ask PIXIS to understand, change, or review this workspace.</p>
      </div>
    );
  }

  return (
    <>
      {visibleMessages.map((message, index) => (
        <article key={`${message.timestamp || "message"}-${index}`} className={`message ${message.role === "user" ? "message-user" : "message-assistant"}`}>
          <label>{message.role === "user" ? "YOU" : "PIXIS"}</label>
          <div className="message-body">
            <Markdown value={messageText(message.content)} />
          </div>
        </article>
      ))}
      {stream && (
        <article className="message message-assistant">
          <label>PIXIS <span>STREAMING</span></label>
          <div className="message-body"><Markdown value={stream} /></div>
        </article>
      )}
    </>
  );
}
