export const OPENAI_NATIVE_SEARCH_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

export const CUSTOM_SEARCH_TOOL_NAMES = new Set([
  "search-the-web",
  "search_and_read",
  "google_search",
]);

export const OPENAI_NATIVE_SEARCH_INCLUDE_FIELDS = new Set([
  "web_search_call.action.sources",
]);

/**
 * Нормализация булева env-флага.
 *
 * @param {string | undefined} value Сырой env.
 * @param {boolean} fallback Значение по умолчанию.
 * @returns {boolean} Нормализованное значение.
 */
export function parseBooleanEnv(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

/**
 * Парсинг списка доменов из env.
 *
 * @param {string | undefined} value CSV-строка.
 * @returns {string[] | undefined} Список доменов или undefined.
 */
export function parseCsvEnv(value) {
  if (!value) {
    return undefined;
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

/**
 * Чтение runtime-конфига extension из env.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env Источник env.
 * @returns {{enabled: boolean, mode: "live" | "cached" | "off", contextSize?: "low" | "medium" | "high", allowedDomains?: string[], userLocation?: {type: "approximate", country?: string, region?: string, city?: string, timezone?: string}}} Конфиг native search.
 */
export function loadNativeSearchConfig(env = process.env) {
  const enabled = parseBooleanEnv(env.PI_OPENAI_NATIVE_SEARCH, true);
  const rawMode = String(env.PI_OPENAI_NATIVE_SEARCH_MODE || "live")
    .trim()
    .toLowerCase();
  const mode = rawMode === "cached" || rawMode === "off" ? rawMode : "live";

  const rawContextSize = String(env.PI_OPENAI_NATIVE_SEARCH_CONTEXT_SIZE || "")
    .trim()
    .toLowerCase();
  const contextSize = ["low", "medium", "high"].includes(rawContextSize)
    ? /** @type {"low" | "medium" | "high"} */ (rawContextSize)
    : undefined;

  const allowedDomains = parseCsvEnv(env.PI_OPENAI_NATIVE_SEARCH_ALLOWED_DOMAINS);

  const userLocation = buildUserLocation(env);

  return {
    enabled,
    mode,
    contextSize,
    allowedDomains,
    userLocation,
  };
}

/**
 * Сборка user_location из env.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env Источник env.
 * @returns {{type: "approximate", country?: string, region?: string, city?: string, timezone?: string} | undefined} Данные геолокации.
 */
export function buildUserLocation(env = process.env) {
  const country = env.PI_OPENAI_NATIVE_SEARCH_COUNTRY?.trim() || undefined;
  const region = env.PI_OPENAI_NATIVE_SEARCH_REGION?.trim() || undefined;
  const city = env.PI_OPENAI_NATIVE_SEARCH_CITY?.trim() || undefined;
  const timezone = env.PI_OPENAI_NATIVE_SEARCH_TIMEZONE?.trim() || undefined;

  if (!country && !region && !city && !timezone) {
    return undefined;
  }

  return {
    type: "approximate",
    country,
    region,
    city,
    timezone,
  };
}

/**
 * Проверка, что модель идёт через OpenAI Responses transport.
 *
 * @param {{api?: string, provider?: string} | undefined} model Модель из provider hook.
 * @returns {boolean} true, если нужно включить native search.
 */
export function isOpenAIResponsesModel(model) {
  if (!model) {
    return false;
  }

  return OPENAI_NATIVE_SEARCH_APIS.has(String(model.api || ""));
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

  if (!isOpenAIResponsesModel(model)) {
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
