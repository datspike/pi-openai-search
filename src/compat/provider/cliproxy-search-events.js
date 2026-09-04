import { loadNativeSearchConfig } from "../../core/config/native-search-config.js";
import { enrichOutputFromCompletedResponse, upsertSearchToolUseBlock } from "./openai-responses-search-mapper.js";

export const CLIPROXY_RESPONSE_EVENT = "cliproxyapi:responses-event";

/** Дополняет сообщение только наблюдаемыми поисковыми блоками; обычный ответ разбирает штатный parser. */
export function registerCliproxySearchEvents(pi) {
  if (typeof pi.events?.on !== "function") return;
  const states = new WeakMap();
  const unsubscribe = pi.events.on(CLIPROXY_RESPONSE_EVENT, ({ event, output, stream, model }) => {
    if (model?.provider !== "cliproxyapi" || model.api !== "cliproxyapi-codex-responses") return;
    if (!["response.output_item.added", "response.output_item.done", "response.completed"].includes(event?.type)) return;
    const config = loadNativeSearchConfig();
    if (!config.enabled || config.mode === "off") return;
    const items = event.type === "response.completed"
      ? (Array.isArray(event.response?.output) ? event.response.output : [])
      : [event.item];
    const calls = items.filter((item) => item?.type === "web_search_call" && typeof item.id === "string" && item.id);
    if (!calls.length) return;
    let state = states.get(output);
    if (!state) {
      state = { messageBlockByItemId: new Map(), searchCallIds: new Set(), searchToolBlockById: new Map(), searchResultBlockById: new Map() };
      states.set(output, state);
    }
    for (const item of calls) {
      upsertSearchToolUseBlock(output, state, item, stream);
      if (item.status === "completed") {
        // Только данные этого вызова: annotations и текст ответа не приписываются чужому поиску.
        enrichOutputFromCompletedResponse(output, { output: [item] }, state, stream);
      } else if (item.status === "failed" && !state.searchResultBlockById.has(item.id)) {
        output.content.push({ type: "webSearchResult", toolUseId: item.id,
          content: { type: "web_search_tool_result_error", message: item.error?.message || "Web search failed" } });
        const contentIndex = output.content.length - 1;
        state.searchResultBlockById.set(item.id, contentIndex);
        stream.push({ type: "web_search_result", contentIndex, partial: output });
      }
    }
  });
  pi.on("session_shutdown", () => unsubscribe());
}
