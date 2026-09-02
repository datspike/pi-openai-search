export const OPENAI_NATIVE_SEARCH_MODELS = Object.freeze([
  Object.freeze({ provider: "openai", api: "openai-responses" }),
  Object.freeze({ provider: "openai-codex", api: "openai-codex-responses" }),
  Object.freeze({ provider: "cliproxyapi", api: "cliproxyapi-codex-responses" }),
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
 * Проверка поддерживаемого native search маршрута OpenAI.
 *
 * @param {{api?: string, provider?: string} | undefined} model Модель из provider hook.
 * @returns {boolean} true для OpenAI Responses и OpenAI Codex Responses.
 */
export function isOpenAIResponsesModel(model) {
  if (!model) {
    return false;
  }

  return OPENAI_NATIVE_SEARCH_MODELS.some(
    (candidate) => candidate.provider === model.provider && candidate.api === model.api,
  );
}
