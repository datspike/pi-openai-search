/**
 * Дедупликация массива источников по URL.
 *
 * @param {Array<{title: string, url: string}>} sources Источники.
 * @returns {Array<{title: string, url: string}>} Дедуплированный список.
 */
export function dedupeSources(sources) {
  const seen = new Set();
  const result = [];

  for (const source of sources || []) {
    const url = String(source?.url || "").trim();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    result.push({
      title: String(source?.title || url).trim() || url,
      url,
    });
  }

  return result;
}

/**
 * Нормализация одного источника из OpenAI annotations/sources.
 *
 * @param {any} source Сырой объект.
 * @returns {{title: string, url: string} | null} Нормализованный источник.
 */
export function normalizeSource(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const candidate = source.url_citation && typeof source.url_citation === "object"
    ? source.url_citation
    : source.source && typeof source.source === "object"
      ? source.source
      : source;

  const url = String(
    candidate.url ||
      candidate.href ||
      candidate.link ||
      candidate.source_url ||
      candidate.uri ||
      "",
  ).trim();

  if (!url) {
    return null;
  }

  const title = String(
    candidate.title ||
      candidate.name ||
      candidate.display_name ||
      candidate.hostname ||
      url,
  ).trim() || url;

  return { title, url };
}

/**
 * Извлечение источников из action.sources.
 *
 * @param {any} action Action web_search_call.
 * @returns {Array<{title: string, url: string}>} Источники.
 */
export function extractActionSources(action) {
  const rawSources = Array.isArray(action?.sources) ? action.sources : [];
  return dedupeSources(rawSources.map(normalizeSource).filter(Boolean));
}

/**
 * Извлечение источников из annotations message item.
 *
 * @param {any} item Message item Responses API.
 * @returns {Array<{title: string, url: string}>} Источники.
 */
export function extractAnnotationSources(item) {
  const result = [];
  const content = Array.isArray(item?.content) ? item.content : [];

  for (const part of content) {
    if (part?.type !== "output_text" || !Array.isArray(part.annotations)) {
      continue;
    }

    for (const annotation of part.annotations) {
      const normalized = normalizeSource(annotation);
      if (normalized) {
        result.push(normalized);
      }
    }
  }

  return dedupeSources(result);
}

/**
 * Извлечение URL из текста для защиты от дублирования citations.
 *
 * @param {string} text Текст ответа.
 * @returns {Set<string>} Множество URL.
 */
export function extractUrlsFromText(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s)\]>]+/g) || [];
  return new Set(matches.map((url) => url.replace(/[.,;:!?]+$/u, "")));
}

/**
 * Извлечение markdown/plain-text источников из текста assistant.
 *
 * @param {string} text Текст ответа.
 * @returns {Array<{title: string, url: string}>} Источники из текста.
 */
export function extractInlineSourcesFromText(text) {
  const normalizedText = String(text || "");
  const result = [];
  const seen = new Set();

  const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu;
  for (const match of normalizedText.matchAll(markdownLinkPattern)) {
    const title = String(match[1] || "").trim();
    const url = String(match[2] || "").trim();
    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    result.push({
      title: title || url,
      url,
    });
  }

  for (const url of extractUrlsFromText(normalizedText)) {
    if (seen.has(url)) {
      continue;
    }

    seen.add(url);
    result.push({ title: url, url });
  }

  return result;
}

/**
 * Добавление блока citations в конец текста, если URL ещё не видны в сообщении.
 *
 * @param {string} text Исходный текст.
 * @param {Array<{title: string, url: string}>} sources Источники.
 * @returns {string} Текст с citations.
 */
export function appendStructuredCitations(text, sources) {
  const normalizedText = String(text || "");
  const deduped = dedupeSources(sources || []);
  if (deduped.length === 0) {
    return normalizedText;
  }

  const urlsInText = extractUrlsFromText(normalizedText);
  const unseen = deduped.filter((source) => !urlsInText.has(source.url));
  if (unseen.length === 0) {
    return normalizedText;
  }

  const lines = unseen.map((source) => `- ${source.title}: ${source.url}`);
  return `${normalizedText}\n\nИсточники:\n${lines.join("\n")}`;
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

  if (action.query) {
    summary.query = action.query;
  }
  if (Array.isArray(action.queries) && action.queries.length > 0) {
    summary.queries = action.queries;
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
 * Выбор источников для результата web_search в tool-use блоке.
 *
 * Приоритет:
 * 1. `web_search_call.action.sources`
 * 2. annotations из assistant message
 * 3. агрегированный fallback по всему response
 *
 * @param {Array<{title: string, url: string}> | undefined} actionSources Источники из action.sources.
 * @param {Array<{title: string, url: string}> | undefined} annotationSources Источники из annotations.
 * @param {Array<{title: string, url: string}> | undefined} fallbackSources Общий fallback-список.
 * @returns {Array<{title: string, url: string}>} Источники для webSearchResult.
 */
export function resolveWebSearchResultSources(actionSources, annotationSources, fallbackSources) {
  const directSources = dedupeSources(actionSources || []);
  if (directSources.length > 0) {
    return directSources;
  }

  const messageSources = dedupeSources(annotationSources || []);
  if (messageSources.length > 0) {
    return messageSources;
  }

  return dedupeSources(fallbackSources || []);
}

/**
 * Формирование content для webSearchResult-блока.
 *
 * @param {Array<{title: string, url: string}>} sources Источники.
 * @returns {unknown} Контент webSearchResult.
 */
export function buildWebSearchResultContent(sources) {
  if (!sources || sources.length === 0) {
    return { type: "web_search_tool_result_complete" };
  }

  return sources.map((source) => ({
    type: "web_search_result",
    title: source.title,
    url: source.url,
  }));
}

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
      workingMessage: `Searching the web: ${descriptor}`,
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
