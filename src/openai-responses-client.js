import { importPiRuntimeModule } from "./pi-runtime.js";

let internalsPromise;

/**
 * Загрузка runtime-local зависимостей для OpenAI Responses provider.
 *
 * @returns {Promise<Record<string, any>>} Набор внутренних модулей.
 */
export async function loadOpenAIResponsesInternals() {
  if (!internalsPromise) {
    internalsPromise = Promise.all([
      importPiRuntimeModule("node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js"),
      importPiRuntimeModule("node_modules/openai/index.mjs"),
    ]).then(([responsesShared, openAiModule]) => ({
      convertResponsesMessages: responsesShared.convertResponsesMessages,
      convertResponsesTools: responsesShared.convertResponsesTools,
      OpenAI: openAiModule.default,
    }));
  }

  return internalsPromise;
}

/**
 * Базовый assistant output до старта stream.
 *
 * @param {any} model Модель.
 * @returns {any} Начальное сообщение.
 */
export function buildInitialOutput(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Создание OpenAI client через runtime-local dependency.
 *
 * @param {any} model Модель.
 * @param {string | undefined} apiKey Ключ API.
 * @param {{OpenAI: any}} internals Runtime internals.
 * @param {Record<string, string> | undefined} optionsHeaders Дополнительные заголовки.
 * @returns {any} OpenAI client.
 */
export function createOpenAIClient(model, apiKey, internals, optionsHeaders) {
  const resolvedApiKey = apiKey || process.env.OPENAI_API_KEY;
  if (!resolvedApiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const defaultHeaders = {
    ...(model.headers || {}),
    ...(optionsHeaders || {}),
  };

  return new internals.OpenAI({
    apiKey: resolvedApiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
  });
}

/**
 * Получение мультипликатора цены service tier.
 *
 * @param {string | undefined} serviceTier Tier из ответа.
 * @returns {number} Мультипликатор.
 */
function getServiceTierCostMultiplier(serviceTier) {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return 2;
    default:
      return 1;
  }
}

/**
 * Применение service-tier цены к usage.
 *
 * @param {any} usage Usage объекта ответа.
 * @param {string | undefined} serviceTier Tier.
 * @returns {void}
 */
export function applyServiceTierPricing(usage, serviceTier) {
  const multiplier = getServiceTierCostMultiplier(serviceTier);
  if (multiplier === 1 || !usage?.cost) {
    return;
  }

  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

/**
 * Карта stop reason из статуса Responses API.
 *
 * @param {string | undefined} status Статус ответа.
 * @returns {"stop" | "length" | "error"} Stop reason.
 */
export function mapStopReason(status) {
  if (!status) {
    return "stop";
  }

  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default:
      return "stop";
  }
}
