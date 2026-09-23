const FACTUAL_SEARCH_LABEL_MAX_LENGTH = 80;

/**
 * Нормализация короткого текста для factual search label.
 *
 * @param {unknown} value Кандидат на label.
 * @returns {string | undefined} Нормализованная строка.
 */
function normalizeFactualSearchLabel(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= FACTUAL_SEARCH_LABEL_MAX_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, FACTUAL_SEARCH_LABEL_MAX_LENGTH - 3).trimEnd()}...`;
}

/**
 * Извлечение правдивого descriptor search action из tool input.
 *
 * @param {unknown} input Input serverToolUse.
 * @returns {string | undefined} Query/url descriptor без prompt-derived fallback.
 */
export function formatFactualSearchDescriptor(input) {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const query = normalizeFactualSearchLabel(input.query);
  if (query) {
    return query;
  }

  if (Array.isArray(input.queries)) {
    const queries = input.queries.map(normalizeFactualSearchLabel).filter(Boolean);
    if (queries.length === 1) {
      return queries[0];
    }
    if (queries.length > 1) {
      return `${queries[0]} (+${queries.length - 1})`;
    }
  }

  const url = normalizeFactualSearchLabel(input.url || input.page_url);
  if (url) {
    return url;
  }

  const pattern = normalizeFactualSearchLabel(input.pattern);
  if (pattern) {
    return `find ${pattern}`;
  }

  return undefined;
}

/**
 * Truthful pending label для interactive web_search блока.
 *
 * @param {unknown} input Input server-side web_search.
 * @returns {string} Pending label без synthetic prompt fallback.
 */
export function formatTruthfulWebSearchPendingLabel(input) {
  const descriptor = formatFactualSearchDescriptor(input);
  if (!descriptor) {
    return "Searching the web";
  }

  return `Searching the web: ${descriptor}`;
}

/**
 * Truthful done label для interactive web_search блока.
 *
 * @param {unknown} input Input server-side web_search.
 * @returns {string} Done label без synthetic prompt fallback.
 */
export function formatTruthfulWebSearchDoneLabel(input) {
  const descriptor = formatFactualSearchDescriptor(input);
  if (!descriptor) {
    return "Searched the web";
  }

  return `Searched ${descriptor}`;
}

/**
 * Формирование footer/status для factual search result.
 *
 * @param {unknown} content Content webSearchResult.
 * @returns {string} Короткий status label.
 */
export function formatWebSearchResultStatus(content) {
  if (Array.isArray(content)) {
    const resultCount = content.filter((item) => item?.type === "web_search_result").length || content.length;
    if (resultCount > 0) {
      return `web: ${resultCount} source${resultCount === 1 ? "" : "s"}`;
    }
  }

  if (content && typeof content === "object" && "type" in content) {
    if (content.type === "web_search_tool_result_error") {
      return "web: error";
    }
    if (content.type === "web_search_tool_result_complete") {
      return "web: finished";
    }
  }

  return "web: finished";
}

/**
 * Форматирование content webSearchResult для inline tool output.
 *
 * @param {unknown} content Content webSearchResult.
 * @returns {string} Текстовый вывод для TUI.
 */
export function formatWebSearchResult(content) {
  if (Array.isArray(content)) {
    const lines = content
      .filter((item) => item?.type === "web_search_result")
      .map((item) => {
        const title = String(item?.title || item?.url || "").trim();
        const url = String(item?.url || "").trim();
        if (!url) {
          return "";
        }
        return title && title !== url ? `${title}: ${url}` : url;
      })
      .filter(Boolean);

    return lines.join("\n");
  }

  if (content && typeof content === "object" && "type" in content) {
    if (content.type === "web_search_tool_result_error") {
      return String(content.message || content.error || "Web search failed").trim();
    }
    if (content.type === "web_search_tool_result_complete") {
      return "No structured search sources available";
    }
  }

  return "";
}

/**
 * Нормализация payload server-side search tool для TUI.
 *
 * @param {any} action Action web_search_call.
 * @returns {Record<string, unknown>} Компактный input-объект.
 */
export function summarizeSearchInput(action) {
  if (!action || typeof action !== "object") {
    return { type: "search" };
  }

  const summary = { type: action.type || "search" };

  const nestedInput = action.input && typeof action.input === "object" ? action.input : undefined;
  const directQuery = typeof action.query === "string" ? action.query : undefined;
  const searchQuery = typeof action.search_query === "string" ? action.search_query : undefined;
  const queryText = typeof action.query_text === "string" ? action.query_text : undefined;
  const nestedQuery = typeof nestedInput?.query === "string" ? nestedInput.query : undefined;
  const nestedSearchQuery = typeof nestedInput?.search_query === "string" ? nestedInput.search_query : undefined;
  const nestedQueryText = typeof nestedInput?.query_text === "string" ? nestedInput.query_text : undefined;
  const inputText = typeof action.input === "string" ? action.input : undefined;
  const promptText = typeof action.prompt === "string" ? action.prompt : undefined;

  if (directQuery || searchQuery || queryText || nestedQuery || nestedSearchQuery || nestedQueryText || inputText || promptText) {
    summary.query =
      directQuery ||
      searchQuery ||
      queryText ||
      nestedQuery ||
      nestedSearchQuery ||
      nestedQueryText ||
      inputText ||
      promptText;
  }
  if (Array.isArray(action.queries) && action.queries.length > 0) {
    summary.queries = action.queries;
  } else if (Array.isArray(action.search_queries) && action.search_queries.length > 0) {
    summary.queries = action.search_queries;
  } else if (Array.isArray(nestedInput?.queries) && nestedInput.queries.length > 0) {
    summary.queries = nestedInput.queries;
  } else if (Array.isArray(nestedInput?.search_queries) && nestedInput.search_queries.length > 0) {
    summary.queries = nestedInput.search_queries;
  }
  if (action.url) {
    summary.url = action.url;
  }
  if (action.page_url) {
    summary.page_url = action.page_url;
  }
  if (action.pattern) {
    summary.pattern = action.pattern;
  }

  return summary;
}

/**
 * Извлечение lifecycle update только из реальных search stream events.
 *
 * @param {any} assistantMessageEvent Event из `message_update`.
 * @returns {{phase: "searching", toolUseId: string, statusText: string, workingMessage: string} | {phase: "complete", toolUseId: string, statusText: string, workingMessage: undefined} | null} Lifecycle update или null.
 */
export function getFactualSearchLifecycleUpdate(assistantMessageEvent) {
  if (!assistantMessageEvent || typeof assistantMessageEvent !== "object") {
    return null;
  }

  if (assistantMessageEvent.type !== "server_tool_use" && assistantMessageEvent.type !== "web_search_result") {
    return null;
  }

  if (!Array.isArray(assistantMessageEvent.partial?.content) || typeof assistantMessageEvent.contentIndex !== "number") {
    return null;
  }

  const content = assistantMessageEvent.partial.content[assistantMessageEvent.contentIndex];
  if (!content || typeof content !== "object") {
    return null;
  }

  if (assistantMessageEvent.type === "server_tool_use") {
    if (content.type !== "serverToolUse" || content.name !== "web_search" || !content.id) {
      return null;
    }

    const descriptor = formatFactualSearchDescriptor(content.input);
    if (!descriptor) {
      return null;
    }

    return {
      phase: "searching",
      toolUseId: content.id,
      statusText: `web: ${descriptor}`,
      workingMessage: formatTruthfulWebSearchPendingLabel(content.input),
    };
  }

  if (content.type !== "webSearchResult" || !content.toolUseId) {
    return null;
  }

  return {
    phase: "complete",
    toolUseId: content.toolUseId,
    statusText: formatWebSearchResultStatus(content.content),
    workingMessage: undefined,
  };
}
