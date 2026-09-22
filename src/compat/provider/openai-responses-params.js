import { appendUniqueIncludeField } from "../../core/payload/native-search.js";
import { resolveTranscriptTools, supportsXhigh } from "../runtime/pi-ai-compat.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

/**
 * Локальный buildBaseOptions без внутреннего импорта pi-ai.
 *
 * @param {any} model Модель.
 * @param {any} options Исходные опции.
 * @param {string | undefined} apiKey Ключ API.
 * @returns {Record<string, unknown>} Нормализованные опции.
 */
export function buildBaseOptions(model, options, apiKey) {
  return {
    temperature: options?.temperature,
    maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
    signal: options?.signal,
    apiKey: apiKey || options?.apiKey,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
  };
}

/**
 * Нормализация reasoning effort.
 *
 * @param {string | undefined} effort Значение из simple options.
 * @returns {string | undefined} Нормализованное значение.
 */
export function clampReasoning(effort) {
  return effort === "xhigh" ? "high" : effort;
}

/**
 * Разрешение cache retention.
 *
 * @param {string | undefined} cacheRetention Настройка.
 * @returns {string} Нормализованное значение.
 */
function resolveCacheRetention(cacheRetention) {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}

/**
 * Prompt cache retention только для прямого api.openai.com.
 *
 * @param {string | undefined} baseUrl Base URL модели.
 * @param {string} cacheRetention Политика.
 * @returns {string | undefined} Значение для запроса.
 */
function getPromptCacheRetention(baseUrl, cacheRetention) {
  if (cacheRetention !== "long") {
    return undefined;
  }
  if (String(baseUrl || "").includes("api.openai.com")) {
    return "24h";
  }
  return undefined;
}

/**
 * Построение payload для OpenAI Responses.
 *
 * @param {any} model Модель.
 * @param {any} context Контекст.
 * @param {any} options Опции stream.
 * @param {Record<string, any>} internals Внутренние helper-функции.
 * @returns {Record<string, any>} Payload запроса.
 */
export function buildPatchedParams(model, context, options, internals) {
  const messages = internals.convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS);
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const params = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
    prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
    store: false,
  };

  if (options?.maxTokens) {
    params.max_output_tokens = options.maxTokens;
  }

  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }

  if (options?.serviceTier !== undefined) {
    params.service_tier = options.serviceTier;
  }

  // Pi 0.86 stores the currently requested tools in system-message snapshots,
  // not in the legacy context.tools field. Keep the latter as a fallback for
  // older runtimes where resolveTranscriptTools is unavailable.
  const transcriptTools = resolveTranscriptTools?.(context?.messages || [])?.requestTools;
  const tools = Array.isArray(transcriptTools) && transcriptTools.length > 0
    ? transcriptTools
    : context?.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    params.tools = internals.convertResponsesTools(tools);
  }

  const requestedReasoningEffort = options?.reasoningEffort;
  const requestedReasoningSummary = options?.reasoningSummary;

  if (model.reasoning) {
    appendUniqueIncludeField(params, "reasoning.encrypted_content");
    if (requestedReasoningEffort || requestedReasoningSummary) {
      const effort = supportsXhigh(model)
        ? requestedReasoningEffort || "medium"
        : clampReasoning(requestedReasoningEffort || "medium");
      params.reasoning = {
        effort: effort || "medium",
        summary: requestedReasoningSummary || "auto",
      };
    }
  }

  return params;
}
