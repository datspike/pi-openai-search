/** Keep a bounded factual trace of completed searches without passing display blocks to Pi's estimator. */
export function sanitizeSearchProviderMessages(messages) {
  let changed = false;
  const sanitized = messages.map((message) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
    const completed = new Set(message.content.filter((block) =>
      block?.type === "webSearchResult" && block.content?.type === "web_search_tool_result_complete",
    ).map((block) => block.toolUseId));
    const content = message.content.flatMap((block) => {
      if (block?.type === "serverToolUse" && block.name === "web_search") {
        changed = true;
        if (!completed.has(block.id)) return [];
        const url = block.input?.url;
        return [{ type: "text", text: typeof url === "string" && /^https?:\/\//.test(url)
          ? `Web search opened ${url.slice(0, 2048)} successfully.`
          : "Web search completed successfully." }];
      }
      if (block?.type === "webSearchResult") { changed = true; return []; }
      return [block];
    });
    return content.some((block, index) => block !== message.content[index]) || content.length !== message.content.length
      ? { ...message, content } : message;
  });
  return { messages: sanitized, changed };
}

/** Keep search projections in the transcript while excluding them from LLM requests. */
export function registerSearchProviderContextSanitizer(pi) {
  pi.on("context", (event) => {
    const result = sanitizeSearchProviderMessages(event.messages);
    return result.changed ? { messages: result.messages } : undefined;
  });
}
