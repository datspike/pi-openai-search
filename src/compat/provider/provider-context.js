/** Keep a bounded factual trace without passing display blocks to Pi's estimator. */
export function sanitizeSearchProviderMessages(messages) {
  let changed = false;
  const sanitized = messages.map((message) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
    const resultsById = new Map(message.content.filter((block) =>
      block?.type === "webSearchResult" && typeof block.toolUseId === "string",
    ).map((block) => [block.toolUseId, block.content]));
    const content = message.content.flatMap((block) => {
      if (block?.type === "serverToolUse" && block.name === "web_search") {
        changed = true;
        if (!resultsById.has(block.id)) return [];
        const result = resultsById.get(block.id);
        if (result?.type === "web_search_tool_result_error") {
          return [{ type: "text", text: "Web search call failed." }];
        }
        const sourceCount = Array.isArray(result)
          ? result.filter((item) => item?.type === "web_search_result" && item.url).length
          : 0;
        if (sourceCount > 0) {
          return [{ type: "text", text: `Web search returned ${sourceCount} structured source${sourceCount === 1 ? "" : "s"}.` }];
        }
        const url = block.input?.url;
        return [{ type: "text", text: typeof url === "string" && /^https?:\/\//.test(url)
          ? `Web search open request for ${url.slice(0, 2048)} finished; no per-call sources available.`
          : "Web search call finished; no per-call sources available." }];
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
