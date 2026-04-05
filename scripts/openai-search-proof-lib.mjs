import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  dedupeSources,
  extractActionSources,
  extractAnnotationSources,
  extractInlineSourcesFromText,
  extractResultSources,
} from "../src/core/truthful/search-results.js";
import {
  importPiRuntimeModule,
  resolvePiBinPath,
  resolvePiRuntimeDescriptor,
} from "../src/compat/runtime/pi-runtime.js";

export const DEFAULT_PROOF_MODEL = "openai/gpt-5.4";
export const DEFAULT_PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
export const JSONL_VERIFIER_MAX_BUFFER = 1024 * 1024;
export const JSONL_VERIFIER_TIMEOUT_MS = 240_000;
export const SEARCH_PROOF_INCLUDE_FIELDS = [
  "web_search_call.action.sources",
];

export const SEARCH_PROOF_SCENARIOS = {
  A: {
    prompt:
      "Search the web for the latest OpenAI news today. Return exactly two bullet points with two distinct source links.",
    description: "search prompt с ожидаемыми factual search blocks и structured source verdict",
  },
  B: {
    prompt: "Reply with exactly two words: calm acknowledgement.",
    description: "negative path без search artifacts и мусорных URL",
  },
};

/**
 * Ошибка proof harness с машинным кодом.
 *
 * @extends Error
 */
export class SearchProofError extends Error {
  /**
   * Инициализация ошибки proof harness.
   *
   * @param {string} code Машинный код ошибки.
   * @param {string} message Сообщение для оператора.
   * @param {Record<string, unknown>} [details] Дополнительные детали.
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "SearchProofError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Сборка shell-safe литерала для `sh -lc`.
 *
 * @param {string} value Исходная строка.
 * @returns {string} Экранированная строка.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/**
 * Формирование ISO timestamp для proof-артефактов.
 *
 * @param {Date | string | number | undefined} [value] Дата или timestamp.
 * @returns {string} ISO-строка.
 */
export function formatProofTimestamp(value = undefined) {
  return new Date(value ?? Date.now()).toISOString();
}

/**
 * Добавление timestamp к результату сценария.
 *
 * @template T
 * @param {T} result Результат сценария.
 * @param {string} [observedAt] Время фиксации результата.
 * @returns {T & {observedAt: string}} Результат с timestamp.
 */
export function stampScenarioResult(result, observedAt = formatProofTimestamp()) {
  return {
    ...result,
    observedAt,
  };
}

/**
 * Нормализация списка сценариев из CLI args.
 *
 * @param {string[] | undefined} rawScenarios Сырые значения `--scenario`.
 * @returns {Array<"A" | "B">} Валидированный список.
 */
export function normalizeScenarioSelection(rawScenarios) {
  const selected = rawScenarios && rawScenarios.length > 0 ? rawScenarios : ["A", "B"];
  const result = [];
  const seen = new Set();

  for (const scenario of selected) {
    const normalized = String(scenario || "").trim().toUpperCase();
    if (!Object.hasOwn(SEARCH_PROOF_SCENARIOS, normalized)) {
      throw new SearchProofError(
        "invalid_scenario",
        `Неизвестный сценарий '${scenario}'. Ожидались ${Object.keys(SEARCH_PROOF_SCENARIOS).join(", ")}.`,
        { scenario },
      );
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(/** @type {"A" | "B"} */ (normalized));
  }

  return result;
}

/**
 * Разбор аргументов proof script.
 *
 * @param {string[]} argv Аргументы без `node` и script path.
 * @returns {{extensionPath?: string, modelRef: string, scenarios: Array<"A" | "B">, help: boolean}} Нормализованные параметры.
 */
export function parseProofCliArgs(argv) {
  let extensionPath;
  let modelRef = DEFAULT_PROOF_MODEL;
  /** @type {string[]} */
  const scenarios = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--extension") {
      extensionPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--model") {
      modelRef = argv[index + 1] || DEFAULT_PROOF_MODEL;
      index += 1;
      continue;
    }
    if (token === "--scenario") {
      scenarios.push(argv[index + 1]);
      index += 1;
      continue;
    }

    throw new SearchProofError(
      "unknown_argument",
      `Неизвестный аргумент '${token}'. Используй --help для списка параметров.`,
      { token },
    );
  }

  return {
    extensionPath,
    modelRef,
    scenarios: normalizeScenarioSelection(scenarios),
    help,
  };
}

/**
 * Проверка extension path для proof-команд.
 *
 * @param {string | undefined} extensionPath Путь из CLI args.
 * @returns {string} Абсолютный путь к extension entrypoint.
 */
export function resolveAbsoluteExtensionPath(extensionPath) {
  if (!extensionPath) {
    throw new SearchProofError(
      "missing_extension_path",
      "Нужен абсолютный путь к extension через --extension <path-to-index.js>.",
    );
  }

  const resolved = path.resolve(extensionPath);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch (error) {
    throw new SearchProofError(
      "extension_not_found",
      `Extension path не найден: ${resolved}`,
      { extensionPath: resolved, cause: error instanceof Error ? error.message : String(error) },
    );
  }

  if (!stats.isFile()) {
    throw new SearchProofError(
      "extension_not_file",
      `Extension path должен указывать на файл index.js: ${resolved}`,
      { extensionPath: resolved },
    );
  }

  return resolved;
}

/**
 * Разбор model ref формата `provider/modelId`.
 *
 * @param {string} modelRef Model ref.
 * @returns {{provider: string, modelId: string, modelRef: string}} Разобранный model ref.
 */
export function parseModelRef(modelRef) {
  const normalized = String(modelRef || DEFAULT_PROOF_MODEL).trim();
  const [provider, ...rest] = normalized.split("/");
  if (!provider || rest.length === 0 || !rest.join("/").trim()) {
    throw new SearchProofError(
      "invalid_model_ref",
      `Некорректный model ref '${modelRef}'. Ожидался формат provider/modelId.`,
      { modelRef },
    );
  }

  return {
    provider,
    modelId: rest.join("/"),
    modelRef: normalized,
  };
}

/**
 * Получение системных путей для доступа к установленному runtime.
 *
 * @returns {{agentDir: string, authPath: string, modelsPath: string, runtimeRoot: string, runtimeKind: "pi", binPath: string}} Набор путей.
 */
export function resolveRuntimePaths() {
  let runtimeDescriptor;
  try {
    runtimeDescriptor = resolvePiRuntimeDescriptor();
  } catch (error) {
    throw new SearchProofError(
      "missing_runtime_bin_path",
      "Не удалось определить путь к pi binary; raw probe не может загрузить runtime.",
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  if (!fs.existsSync(runtimeDescriptor.root)) {
    throw new SearchProofError(
      "missing_runtime_root",
      `Корень установленного runtime не найден: ${runtimeDescriptor.root}`,
      { runtimeRoot: runtimeDescriptor.root, runtimeKind: runtimeDescriptor.kind },
    );
  }

  const agentDir =
    process.env.PI_AGENT_DIR != null
      ? path.resolve(process.env.PI_AGENT_DIR)
      : DEFAULT_PI_AGENT_DIR;

  return {
    agentDir,
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    runtimeRoot: runtimeDescriptor.root,
    runtimeKind: runtimeDescriptor.kind,
    binPath: runtimeDescriptor.binPath,
  };
}

/**
 * Загрузка модели и OpenAI client через тот же runtime, что использует standalone pi.
 *
 * @param {string} modelRef Model ref формата `provider/modelId`.
 * @returns {Promise<{model: any, client: any, agentDir: string}>} Модель, client и путь к agent dir.
 */
export async function loadModelClient(modelRef) {
  const { agentDir, authPath, modelsPath } = resolveRuntimePaths();
  const { provider, modelId } = parseModelRef(modelRef);

  const [{ AuthStorage }, { ModelRegistry }, piAi] = await Promise.all([
    importPiRuntimeModule("dist/core/auth-storage.js"),
    importPiRuntimeModule("dist/core/model-registry.js"),
    importPiRuntimeModule("node_modules/@mariozechner/pi-ai/dist/index.js"),
  ]);

  const authStorage = AuthStorage.create(authPath);
  const modelRegistry = new ModelRegistry(authStorage, modelsPath);
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new SearchProofError(
      "model_not_found",
      `Модель '${modelRef}' не найдена в registry ${modelsPath}.`,
      { modelRef, modelsPath },
    );
  }

  const apiKey =
    await resolveProviderApiKey(authStorage, provider) ||
    piAi.getEnvApiKey(provider) ||
    process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new SearchProofError(
      "missing_api_key",
      `Не найден API key для провайдера '${provider}'.`,
      { provider },
    );
  }

  let client;
  try {
    const { createOpenAIClient } = await importPiRuntimeModule("node_modules/@mariozechner/pi-ai/dist/providers/openai-shared.js");
    client = await createOpenAIClient(model, {}, apiKey, {});
  } catch {
    const openAiModule = await importPiRuntimeModule("node_modules/openai/index.mjs");
    client = new openAiModule.default({
      apiKey,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      defaultHeaders: model.headers || {},
    });
  }

  return { model, client, agentDir };
}

/**
 * Разрешение API key для провайдера через доступные auth API runtime.
 *
 * @param {any} authStorage Экземпляр auth storage runtime.
 * @param {string} provider Идентификатор провайдера.
 * @returns {Promise<string | undefined>} Найденный API key.
 */
export async function resolveProviderApiKey(authStorage, provider) {
  if (authStorage && typeof authStorage.getApiKey === "function") {
    return authStorage.getApiKey(provider);
  }

  const credentials =
    authStorage && typeof authStorage.getCredentialsForProvider === "function"
      ? authStorage.getCredentialsForProvider(provider)
      : undefined;
  const preferredCredential = Array.isArray(credentials) ? credentials.find(Boolean) : undefined;

  if (preferredCredential && typeof authStorage.resolveCredentialApiKey === "function") {
    return authStorage.resolveCredentialApiKey(provider, preferredCredential);
  }

  return undefined;
}

/**
 * Сборка компактного stderr tail.
 *
 * @param {string | undefined} stderr Stderr дочернего процесса.
 * @returns {string | undefined} Последние строки stderr.
 */
export function summarizeStderr(stderr) {
  const lines = String(stderr || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }
  return lines.slice(-6).join(" | ");
}

/**
 * Разбор stdout JSONL verifier harness.
 *
 * @param {string} stdout Сырые JSONL-данные.
 * @returns {any[]} Массив событий.
 */
export function parseJsonlEvents(stdout) {
  const text = String(stdout || "");
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new SearchProofError("empty_jsonl", "Verifier не вернул ни одной JSONL-строки.");
  }

  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new SearchProofError(
        "malformed_jsonl",
        `Не удалось распарсить JSONL строку ${index + 1}.`,
        {
          lineNumber: index + 1,
          linePreview: line.slice(0, 200),
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  });
}

/**
 * Поиск финального assistant `message_end`.
 *
 * @param {any[]} events JSONL-события.
 * @returns {any} Финальное assistant сообщение.
 */
export function findAssistantMessageEnd(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      return event.message;
    }
  }

  throw new SearchProofError(
    "missing_message_end",
    "В JSONL отсутствует финальный assistant message_end с полем message.content.",
  );
}

/**
 * Извлечение block из assistantMessageEvent partial.
 *
 * @param {any} assistantMessageEvent Event из `message_update`.
 * @returns {any | undefined} Извлечённый block.
 */
export function extractAssistantEventBlock(assistantMessageEvent) {
  const contentIndex = assistantMessageEvent?.contentIndex;
  const content = assistantMessageEvent?.partial?.content;
  if (!Array.isArray(content) || typeof contentIndex !== "number") {
    return undefined;
  }
  return content[contentIndex];
}

/**
 * Сводка финального assistant message для verifier proof.
 *
 * @param {any} message Финальное assistant message.
 * @returns {{contentTypes: string[], inlineSourceCount: number, finalText: string, serverToolUseIds: string[], webSearchResultIds: string[], resultBlocks: Array<{toolUseId: string, kind: string, urlCount: number, urls: string[]}>}} Нормализованная сводка.
 */
export function summarizeAssistantMessage(message) {
  if (!Array.isArray(message?.content)) {
    throw new SearchProofError(
      "incomplete_message_content",
      "Финальный assistant message не содержит массива content.",
    );
  }

  const content = message.content;
  const textBlocks = content.filter((block) => block?.type === "text");
  const finalText = textBlocks.map((block) => String(block.text || "")).join("\n\n");
  const inlineSourceCount = extractInlineSourcesFromText(finalText).length;

  const serverToolUseIds = content
    .filter((block) => block?.type === "serverToolUse" && typeof block.id === "string")
    .map((block) => block.id);

  const resultBlocks = content
    .filter((block) => block?.type === "webSearchResult")
    .map((block) => {
      const urls = Array.isArray(block.content)
        ? block.content
            .map((item) => (typeof item?.url === "string" ? item.url : undefined))
            .filter(Boolean)
        : [];
      let kind = "unknown";
      if (Array.isArray(block.content)) {
        kind = urls.length > 0 ? "urls" : "array_without_urls";
      } else if (block.content?.type === "web_search_tool_result_complete") {
        kind = "sentinel_complete";
      } else if (block.content?.type === "web_search_tool_result_error") {
        kind = "error";
      }

      return {
        toolUseId: String(block.toolUseId || ""),
        kind,
        urlCount: urls.length,
        urls,
      };
    });

  return {
    contentTypes: content.map((block) => String(block?.type || "unknown")),
    inlineSourceCount,
    finalText,
    serverToolUseIds,
    webSearchResultIds: resultBlocks.map((block) => block.toolUseId),
    resultBlocks,
  };
}

/**
 * Проверка standalone placeholder URL без домена верхнего уровня.
 *
 * Валидные `www.<domain>` ссылки не считаются мусором. Матчится только
 * усечённый placeholder вида `https://www`, за которым сразу идёт конец строки
 * или разделитель URL/token.
 *
 * @param {unknown} value Проверяемое значение.
 * @returns {boolean} true, если найден standalone `https://www`.
 */
export function hasGarbageUrl(value) {
  return /https:\/\/www(?:(?=$)|(?=[\\/"'\s)\]}>,;:!?])|(?=[/?#]))/u.test(JSON.stringify(value));
}

/**
 * Классификация verifier JSONL для search-сценария.
 *
 * @param {any[]} events JSONL-события.
 * @param {"A" | "B"} scenario Имя сценария.
 * @returns {{scenario: "A" | "B", verdict: "pass" | "blocker" | "fail", reason: string, summary: Record<string, unknown>}} Итоговая классификация.
 */
export function classifyVerifierJsonl(events, scenario) {
  const assistantMessage = findAssistantMessageEnd(events);
  const assistantEvents = events
    .filter((event) => event?.type === "message_update" && event.assistantMessageEvent)
    .map((event) => event.assistantMessageEvent);
  const assistantEventTypes = assistantEvents.map((event) => event.type).filter(Boolean);
  const serverToolEventIds = assistantEvents
    .filter((event) => event?.type === "server_tool_use")
    .map(extractAssistantEventBlock)
    .map((block) => block?.id)
    .filter(Boolean);
  const webSearchResultEventIds = assistantEvents
    .filter((event) => event?.type === "web_search_result")
    .map(extractAssistantEventBlock)
    .map((block) => block?.toolUseId)
    .filter(Boolean);
  const messageSummary = summarizeAssistantMessage(assistantMessage);
  const resultBlocksWithUrls = messageSummary.resultBlocks.filter((block) => block.urlCount > 0);
  const sentinelCount = messageSummary.resultBlocks.filter((block) => block.kind === "sentinel_complete").length;
  const garbageUrlDetected = hasGarbageUrl(assistantMessage);

  const streamSearchEventMode =
    serverToolEventIds.length > 0 || webSearchResultEventIds.length > 0
      ? "stream_events"
      : messageSummary.serverToolUseIds.length > 0 || messageSummary.webSearchResultIds.length > 0
        ? "final_message_only"
        : "absent";

  const summary = {
    assistantEventTypes,
    serverToolEventIds,
    serverToolEventCount: serverToolEventIds.length,
    webSearchResultEventIds,
    webSearchResultEventCount: webSearchResultEventIds.length,
    streamSearchEventMode,
    contentTypes: messageSummary.contentTypes,
    finalServerToolUseIds: messageSummary.serverToolUseIds,
    finalServerToolUseCount: messageSummary.serverToolUseIds.length,
    finalWebSearchResultIds: messageSummary.webSearchResultIds,
    finalWebSearchResultCount: messageSummary.webSearchResultIds.length,
    resultBlocks: messageSummary.resultBlocks,
    resultBlockCount: messageSummary.resultBlocks.length,
    inlineSourceCount: messageSummary.inlineSourceCount,
    sentinelCount,
    garbageUrlDetected,
  };

  if (scenario === "B") {
    if (serverToolEventIds.length > 0 || webSearchResultEventIds.length > 0) {
      return {
        scenario,
        verdict: "fail",
        reason: "Negative-path scenario B неожиданно сгенерировал search events.",
        summary,
      };
    }
    if (messageSummary.serverToolUseIds.length > 0 || messageSummary.webSearchResultIds.length > 0) {
      return {
        scenario,
        verdict: "fail",
        reason: "Negative-path scenario B содержит финальные search blocks.",
        summary,
      };
    }
    if (garbageUrlDetected) {
      return {
        scenario,
        verdict: "fail",
        reason: "Negative-path scenario B содержит мусорный URL placeholder.",
        summary,
      };
    }

    return {
      scenario,
      verdict: "pass",
      reason: "Scenario B остался чистым negative proof без search artifacts и garbage URLs.",
      summary,
    };
  }

  if (messageSummary.serverToolUseIds.length === 0 || messageSummary.webSearchResultIds.length === 0) {
    return {
      scenario,
      verdict: "fail",
      reason: "Scenario A не содержит финальные serverToolUse/webSearchResult blocks в message_end.",
      summary,
    };
  }

  const uniqueToolUseIds = new Set(messageSummary.serverToolUseIds);
  const uniqueResultIds = new Set(messageSummary.webSearchResultIds);
  const missingResultLinks = [...uniqueResultIds].filter((toolUseId) => !uniqueToolUseIds.has(toolUseId));
  if (missingResultLinks.length > 0 || uniqueToolUseIds.size !== uniqueResultIds.size) {
    return {
      scenario,
      verdict: "fail",
      reason: "Scenario A потерял toolUseId separation между serverToolUse и webSearchResult blocks.",
      summary: {
        ...summary,
        missingResultLinks,
      },
    };
  }

  if (garbageUrlDetected) {
    return {
      scenario,
      verdict: "fail",
      reason: "Scenario A содержит мусорный URL placeholder, proof нельзя считать truthful.",
      summary,
    };
  }

  if (resultBlocksWithUrls.length === 0 && messageSummary.inlineSourceCount === 0) {
    return {
      scenario,
      verdict: "blocker",
      reason: "Scenario A завершился sentinel web_search_tool_result_complete без structured или inline source URLs.",
      summary,
    };
  }

  return {
    scenario,
    verdict: "pass",
    reason:
      resultBlocksWithUrls.length > 0
        ? "Scenario A сохранил factual search blocks и structured URLs в финальном message_end."
        : "Scenario A сохранил factual search blocks, а source URLs остались inline в финальном message_end.",
    summary,
  };
}

/**
 * Сводка raw Responses payload.
 *
 * @param {any} response Полный raw Responses response.
 * @returns {{outputTypes: string[], searchCalls: Array<{id: string, actionType: string, actionSourceCount: number, resultSourceCount: number, rawResultCount: number}>, annotationSourceCount: number, inlineSourceCount: number, totalStructuredSourceCount: number, documentedStructuredSourceCount: number, documentedStructuredSeams: string[], opportunisticStructuredSeams: string[]}} Нормализованная сводка.
 */
export function summarizeRawResponse(response) {
  if (!Array.isArray(response?.output)) {
    throw new SearchProofError(
      "malformed_raw_output",
      "Raw Responses payload не содержит массива output.",
    );
  }

  const output = response.output;
  const searchCalls = output.filter((item) => item?.type === "web_search_call");
  const messageItems = output.filter((item) => item?.type === "message");
  if (messageItems.length === 0) {
    throw new SearchProofError(
      "missing_raw_message_item",
      "Raw Responses payload не содержит финального message item.",
    );
  }

  const perCall = searchCalls.map((item) => ({
    id: String(item.id || ""),
    actionType: String(item?.action?.type || "unknown"),
    actionSourceCount: extractActionSources(item.action).length,
    resultSourceCount: extractResultSources(item.results).length,
    rawResultCount: Array.isArray(item.results) ? item.results.length : 0,
  }));
  const annotationSources = dedupeSources(messageItems.flatMap((item) => extractAnnotationSources(item)));
  const inlineSources = dedupeSources(
    messageItems.flatMap((item) =>
      (Array.isArray(item.content) ? item.content : [])
        .filter((part) => part?.type === "output_text")
        .flatMap((part) => extractInlineSourcesFromText(part.text)),
    ),
  );
  const totalActionSourceCount = perCall.reduce((sum, item) => sum + item.actionSourceCount, 0);
  const totalResultSourceCount = perCall.reduce((sum, item) => sum + item.resultSourceCount, 0);
  const documentedStructuredSeams = [];
  const opportunisticStructuredSeams = [];
  if (totalActionSourceCount > 0) {
    documentedStructuredSeams.push("action.sources");
  }
  if (annotationSources.length > 0) {
    documentedStructuredSeams.push("annotations");
  }
  if (totalResultSourceCount > 0) {
    opportunisticStructuredSeams.push("results");
  }

  return {
    outputTypes: output.map((item) => String(item?.type || "unknown")),
    searchCallCount: searchCalls.length,
    searchCalls: perCall,
    structuredSourceCounts: {
      actionSources: totalActionSourceCount,
      resultSources: totalResultSourceCount,
      annotationSources: annotationSources.length,
      inlineSources: inlineSources.length,
    },
    annotationSourceCount: annotationSources.length,
    inlineSourceCount: inlineSources.length,
    totalStructuredSourceCount: totalActionSourceCount + totalResultSourceCount + annotationSources.length,
    documentedStructuredSourceCount: totalActionSourceCount + annotationSources.length,
    documentedStructuredSeams,
    opportunisticStructuredSeams,
  };
}

/**
 * Классификация raw Responses payload по scenario contract.
 *
 * @param {any} response Полный raw Responses response.
 * @param {"A" | "B"} scenario Имя сценария.
 * @returns {{scenario: "A" | "B", verdict: "pass" | "blocker" | "fail", reason: string, summary: Record<string, unknown>}} Итоговая классификация.
 */
export function classifyRawResponse(response, scenario) {
  const summary = summarizeRawResponse(response);

  if (scenario === "B") {
    if (summary.searchCalls.length > 0 || summary.totalStructuredSourceCount > 0) {
      return {
        scenario,
        verdict: "fail",
        reason: "Raw negative-path scenario B неожиданно использовал web_search или structured sources.",
        summary,
      };
    }

    return {
      scenario,
      verdict: "pass",
      reason: "Raw scenario B не содержит search calls и structured source seams.",
      summary,
    };
  }

  if (summary.searchCalls.length === 0) {
    return {
      scenario,
      verdict: "fail",
      reason: "Raw scenario A не содержит ни одного web_search_call.",
      summary,
    };
  }

  if (summary.documentedStructuredSourceCount === 0 && summary.inlineSourceCount === 0 && summary.structuredSourceCounts.resultSources === 0) {
    return {
      scenario,
      verdict: "blocker",
      reason: "Raw scenario A не содержит ни structured source seams, ни inline source URLs.",
      summary,
    };
  }

  return {
    scenario,
    verdict: "pass",
    reason:
      summary.documentedStructuredSourceCount > 0
        ? `Raw scenario A содержит structured seams: ${summary.documentedStructuredSeams.join(", ")}.`
        : summary.inlineSourceCount > 0
          ? "Raw scenario A содержит web_search_call и inline source URLs в output_text."
          : "Raw scenario A содержит web_search_call и opportunistic result sources.",
    summary,
  };
}

/**
 * Сборка CLI-команды для no-session verifier harness.
 *
 * @param {{extensionPath: string, modelRef: string, scenario: "A" | "B"}} params Параметры запуска.
 * @returns {string} Shell-команда для `sh -lc`.
 */
export function buildVerifierCommand({ extensionPath, modelRef, scenario }) {
  const prompt = SEARCH_PROOF_SCENARIOS[scenario].prompt;
  const binPath = resolvePiBinPath();
  return [
    `PI_OPENAI_NATIVE_SEARCH=1`,
    `PI_OPENAI_NATIVE_SEARCH_MODE=live`,
    `${shellQuote(binPath)} --extension ${shellQuote(extensionPath)} --mode json --print --no-session --model ${shellQuote(modelRef)} ${shellQuote(prompt)}`,
  ].join(" ");
}

/**
 * Исполнение exact verifier harness через `spawnSync`.
 *
 * @param {{command: string, cwd?: string}} params Параметры запуска.
 * @returns {{status: number | null, stdout: string, stderr: string, stdoutBytes: number, durationMs: number}} Результат дочернего процесса.
 */
export function runSpawnVerifierHarness({ command, cwd = process.cwd() }) {
  const startedAt = Date.now();
  const child = spawnSync("sh", ["-lc", command], {
    cwd,
    encoding: "utf8",
    timeout: JSONL_VERIFIER_TIMEOUT_MS,
    maxBuffer: JSONL_VERIFIER_MAX_BUFFER,
  });
  const durationMs = Date.now() - startedAt;
  const stdout = String(child.stdout || "");
  const stderr = String(child.stderr || "");

  if (child.error) {
    const code = child.error.code === "ENOBUFS" ? "verifier_enobufs" : child.error.code === "ETIMEDOUT" ? "verifier_timeout" : "verifier_spawn_error";
    throw new SearchProofError(
      code,
      `Verifier harness завершился с ошибкой ${child.error.code || child.error.name}.`,
      {
        command,
        stdoutBytes: stdout.length,
        stderrTail: summarizeStderr(stderr),
        durationMs,
      },
    );
  }

  if (child.status !== 0) {
    throw new SearchProofError(
      "verifier_nonzero_exit",
      `Verifier harness вернул ненулевой exit code ${child.status}.`,
      {
        command,
        status: child.status,
        stdoutBytes: stdout.length,
        stderrTail: summarizeStderr(stderr),
        durationMs,
      },
    );
  }

  return {
    status: child.status,
    stdout,
    stderr,
    stdoutBytes: stdout.length,
    durationMs,
  };
}

/**
 * Агрегация verdict по нескольким сценариям.
 *
 * @param {Array<{verdict: "pass" | "blocker" | "fail"}>} results Результаты сценариев.
 * @returns {"pass" | "blocker" | "fail"} Итоговый verdict.
 */
export function aggregateVerdict(results) {
  if (results.some((result) => result.verdict === "fail")) {
    return "fail";
  }
  if (results.some((result) => result.verdict === "blocker")) {
    return "blocker";
  }
  return "pass";
}

/**
 * Формирование human-readable help для proof scripts.
 *
 * @param {string} scriptName Имя script entrypoint.
 * @returns {string} Текст help.
 */
export function formatProofHelp(scriptName) {
  return [
    `Usage: node ${scriptName} --extension <abs-path-to-index.js> [--model provider/model] [--scenario A] [--scenario B]`,
    "",
    "Scenarios:",
    ...Object.entries(SEARCH_PROOF_SCENARIOS).map(
      ([name, scenario]) => `  ${name} - ${scenario.description}`,
    ),
  ].join("\n");
}

/**
 * Нормализация пути модуля с учётом symlink worktree.
 *
 * @param {string | undefined} value Исходный путь.
 * @returns {string | undefined} Нормализованный путь.
 */
function normalizeModulePath(value) {
  if (!value) {
    return undefined;
  }

  const resolved = path.resolve(value);
  try {
    return typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Проверка, что модуль запущен как entrypoint.
 *
 * @param {string | undefined} argvEntry Значение `process.argv[1]`.
 * @param {string} importMetaUrl Текущий `import.meta.url`.
 * @returns {boolean} true, если модуль запущен напрямую.
 */
export function isMainModule(argvEntry, importMetaUrl) {
  return normalizeModulePath(argvEntry) === normalizeModulePath(fileURLToPath(importMetaUrl));
}
