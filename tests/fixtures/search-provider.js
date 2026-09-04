import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Локальный провайдер для проверки настоящего CLI без сети и учётных данных.
export default function (pi) {
  pi.registerProvider("openai", {
    api: "openai-responses",
    apiKey: "fixture-only",
    baseUrl: "http://127.0.0.1:1",
    models: [{
      id: "search-fixture", name: "Search fixture", reasoning: false, input: ["text"],
      contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const negative = JSON.stringify(context.messages).includes("NO_SEARCH");
      const output = {
        role: "assistant", provider: model.provider, api: model.api, model: model.id,
        content: [], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "start", partial: output });
      if (!negative) {
        output.content.push({ type: "serverToolUse", id: "ws_fixture", name: "web_search", input: { query: "observed fixture query" } });
        stream.push({ type: "server_tool_use", contentIndex: 0, partial: output });
        output.content.push({ type: "webSearchResult", toolUseId: "ws_fixture", content: [
          { type: "web_search_result", title: "Fixture source", url: "https://example.com/fixture" },
        ] });
        stream.push({ type: "web_search_result", contentIndex: 1, partial: output });
      }
      output.content.push({ type: "text", text: "Fixture finished." });
      stream.push({ type: "text_end", contentIndex: output.content.length - 1, content: "Fixture finished.", partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
      return stream;
    },
  });
}
