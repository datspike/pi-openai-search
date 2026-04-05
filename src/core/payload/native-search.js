import { isOpenAIResponsesModel } from "../config/native-search-config.js";

export const CUSTOM_SEARCH_TOOL_NAMES = new Set([
  "search-the-web",
  "search_and_read",
  "google_search",
]);

export const OPENAI_NATIVE_SEARCH_INCLUDE_FIELDS = new Set([
  "web_search_call.action.sources",
]);

/**
 * Эвристика для распознавания payload OpenAI Responses без model metadata.
 *
 * @param {Record<string, any> | undefined} payload Provider payload.
 * @returns {boolean} true, если payload похож на Responses API.
 */
export function looksLikeOpenAIResponsesPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  if (Array.isArray(payload.input)) {
    return true;
  }

  if ("max_output_tokens" in payload) {
    return true;
  }

  if (Array.isArray(payload.include) && payload.include.some((field) => typeof field === "string")) {
    return true;
  }

  return false;
}

/**
 * Сборка OpenAI web_search tool payload.
 *
 * @param {{mode: "live" | "cached" | "off", contextSize?: "low" | "medium" | "high", allowedDomains?: string[], userLocation?: {type: "approximate", country?: string, region?: string, city?: string, timezone?: string}}} config Конфиг native search.
 * @returns {Record<string, unknown> | undefined} Tool-объект или undefined.
 */
export function buildWebSearchTool(config) {
  if (!config || config.mode === "off") {
    return undefined;
  }

  /** @type {Record<string, unknown>} */
  const tool = {
    type: "web_search",
    external_web_access: config.mode === "live",
  };

  if (config.contextSize) {
    tool.search_context_size = config.contextSize;
  }

  if (config.allowedDomains && config.allowedDomains.length > 0) {
    tool.filters = {
      allowed_domains: config.allowedDomains,
    };
  }

  if (config.userLocation) {
    tool.user_location = config.userLocation;
  }

  return tool;
}

/**
 * Добавление include-полей для native web_search.
 *
 * @param {Record<string, any>} payload Provider payload.
 * @returns {void}
 */
export function ensureNativeSearchIncludes(payload) {
  const includes = [];
  const present = new Set();

  if (Array.isArray(payload.include)) {
    for (const field of payload.include) {
      if (typeof field !== "string" || present.has(field)) {
        continue;
      }
      present.add(field);
      includes.push(field);
    }
  }

  for (const field of OPENAI_NATIVE_SEARCH_INCLUDE_FIELDS) {
    if (!present.has(field)) {
      present.add(field);
      includes.push(field);
    }
  }

  if (includes.length > 0) {
    payload.include = includes;
  }
}

/**
 * Добавление include-поля без потери существующих значений.
 *
 * @param {Record<string, any>} payload Provider payload.
 * @param {string} field Include-поле.
 * @returns {void}
 */
export function appendUniqueIncludeField(payload, field) {
  const existing = Array.isArray(payload?.include) ? payload.include : [];
  if (existing.includes(field)) {
    return;
  }

  payload.include = [...existing, field];
}

/**
 * Инъекция native web_search в provider payload.
 *
 * @param {Record<string, any>} payload Provider payload.
 * @param {{api?: string, provider?: string} | undefined} model Текущая модель.
 * @param {{enabled: boolean, mode: "live" | "cached" | "off", contextSize?: "low" | "medium" | "high", allowedDomains?: string[], userLocation?: {type: "approximate", country?: string, region?: string, city?: string, timezone?: string}}} config Конфиг native search.
 * @returns {Record<string, any>} Изменённый payload.
 */
export function injectNativeWebSearch(payload, model, config) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  if (!config.enabled || config.mode === "off") {
    return payload;
  }

  if (!isOpenAIResponsesModel(model) && !looksLikeOpenAIResponsesPayload(payload)) {
    return payload;
  }

  const tools = Array.isArray(payload.tools) ? [...payload.tools] : [];
  const hasNativeWebSearch = tools.some((tool) => tool?.type === "web_search");
  const filteredTools = tools.filter((tool) => {
    if (tool?.name && CUSTOM_SEARCH_TOOL_NAMES.has(tool.name)) {
      return false;
    }
    return true;
  });

  const webSearchTool = buildWebSearchTool(config);
  if (!webSearchTool) {
    payload.tools = filteredTools;
    return payload;
  }

  if (!hasNativeWebSearch) {
    filteredTools.push(webSearchTool);
  }

  payload.tools = filteredTools;
  ensureNativeSearchIncludes(payload);

  if (payload.tool_choice == null) {
    payload.tool_choice = "auto";
  }

  if (payload.parallel_tool_calls == null) {
    payload.parallel_tool_calls = true;
  }

  return payload;
}
