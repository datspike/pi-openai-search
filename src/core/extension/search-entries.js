import { stripVTControlCharacters } from "node:util";
import { isOpenAIResponsesModel, loadNativeSearchConfig } from "../config/native-search-config.js";
import { formatTruthfulWebSearchDoneLabel, formatWebSearchResult } from "../lifecycle/search-status.js";

export const NATIVE_SEARCH_ENTRY_TYPE = "openai-native-search-results";

/** Собирает только наблюдаемые вызовы поиска и связанные с ними результаты. */
export function collectNativeSearchEntries(message) {
  if (message?.role !== "assistant" || !isOpenAIResponsesModel(message)) return [];
  const content = Array.isArray(message.content) ? message.content : [];
  const searches = new Map();
  for (const block of content) {
    if (block?.type !== "serverToolUse" || block.name !== "web_search" || !block.id) continue;
    const result = content.find((item) => item?.type === "webSearchResult" && item.toolUseId === block.id);
    const failed = result?.content?.type === "web_search_tool_result_error";
    const completed = Array.isArray(result?.content) || result?.content?.type === "web_search_tool_result_complete";
    searches.set(block.id, {
      id: block.id,
      label: completed ? formatTruthfulWebSearchDoneLabel(block.input)
        : failed ? "Web search failed"
        : message.stopReason === "aborted" ? "Web search interrupted" : "Web search: result unavailable",
      output: result ? formatWebSearchResult(result.content) : "",
      isError: failed || (!completed && ["aborted", "error"].includes(message.stopReason)),
    });
  }
  return [...searches.values()];
}

/** Рендерит отдельные карточки поиска, не перечитывая сессию и не меняя контекст модели. */
export function renderNativeSearchEntry(entry, { expanded }, theme, { Box, Text, VStack }) {
  const searches = Array.isArray(entry.data?.searches) ? entry.data.searches : [];
  const clean = (value) => stripVTControlCharacters(String(value ?? "")).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const cards = [];
  for (const search of searches) {
    const card = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
    const title = theme.bold(theme.fg(search.isError ? "error" : "customMessageLabel", "⌕ Web search"));
    const label = theme.fg("customMessageText", clean(search.label));
    const output = clean(search.output);
    const details = expanded && output ? `\n${theme.fg("toolOutput", output)}` : "";
    card.addChild(new Text(`${title}\n${label}${details}`));
    cards.push(card);
  }
  if (cards.length === 0) return new Text("");
  return new VStack(cards, { gap: 1 });
}

/** Сохраняет итог поиска после хода; Pi отвечает за историю, перенос строк и раскрытие. */
export function registerNativeSearchEntries(pi, components) {
  pi.registerEntryRenderer(NATIVE_SEARCH_ENTRY_TYPE,
    (entry, options, theme) => renderNativeSearchEntry(entry, options, theme, components));

  pi.on("turn_end", (event) => {
    const config = loadNativeSearchConfig();
    if (!config.enabled || config.mode === "off") return;
    const searches = collectNativeSearchEntries(event?.message);
    if (searches.length > 0) pi.appendEntry(NATIVE_SEARCH_ENTRY_TYPE, { searches });
  });
}
