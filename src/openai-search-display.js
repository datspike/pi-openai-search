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
