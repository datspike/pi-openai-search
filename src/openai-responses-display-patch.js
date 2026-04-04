import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  AssistantMessageEventStream,
  getEnvApiKey,
  registerApiProvider,
  supportsXhigh,
} from "@gsd/pi-ai";

import {
  appendStructuredCitations,
  buildWebSearchResultContent,
  dedupeSources,
  extractActionSources,
  extractAnnotationSources,
  summarizeSearchInput,
} from "./openai-search-display.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const PATCH_FLAG = Symbol.for("pi-openai-search/openai-responses-display-patch");

/**
 * Локальный buildBaseOptions без внутреннего импорта pi-ai.
 *
 * @param {any} model Модель.
 * @param {any} options Исходные опции.
 * @param {string | undefined} apiKey Ключ API.
 * @returns {Record<string, unknown>} Нормализованные опции.
 */
function buildBaseOptions(model, options, apiKey) {
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
function clampReasoning(effort) {
  return effort === "xhigh" ? "high" : effort;
}

/**
 * Определение корня установленного gsd-pi.
 *
 * @returns {string} Абсолютный путь к корню пакета.
 */
function resolveGsdPiRoot() {
  const binPath = process.env.GSD_BIN_PATH;
  if (!binPath) {
    throw new Error("GSD_BIN_PATH is not set; cannot load internal pi-ai modules.");
  }

  return path.resolve(path.dirname(binPath), "..", "lib", "node_modules", "gsd-pi");
}

let internalsPromise;

/**
 * Загрузка внутренних helper-модулей pi-ai.
 *
 * @returns {Promise<Record<string, any>>} Набор внутренних модулей.
 */
async function loadPiAiInternals() {
  if (!internalsPromise) {
    const root = resolveGsdPiRoot();
    const sharedPath = path.join(root, "packages", "pi-ai", "dist", "providers", "openai-responses-shared.js");
    const openaiSharedPath = path.join(root, "packages", "pi-ai", "dist", "providers", "openai-shared.js");

    internalsPromise = Promise.all([
      import(pathToFileURL(sharedPath).href),
      import(pathToFileURL(openaiSharedPath).href),
    ]).then(([responsesShared, openaiShared]) => ({
      convertResponsesMessages: responsesShared.convertResponsesMessages,
      convertResponsesTools: responsesShared.convertResponsesTools,
      createOpenAIClient: openaiShared.createOpenAIClient,
      buildInitialOutput: openaiShared.buildInitialOutput,
      assertStreamSuccess: openaiShared.assertStreamSuccess,
      finalizeStream: openaiShared.finalizeStream,
      handleStreamError: openaiShared.handleStreamError,
      clampReasoningForModel: openaiShared.clampReasoningForModel,
    }));
  }

  return internalsPromise;
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
function buildPatchedParams(model, context, options, internals) {
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

  if (context.tools) {
    params.tools = internals.convertResponsesTools(context.tools);
  }

  if (model.reasoning) {
    params.include = ["reasoning.encrypted_content"];
    if (options?.reasoningEffort || options?.reasoningSummary) {
      const effort = internals.clampReasoningForModel(model.name, options?.reasoningEffort || "medium");
      params.reasoning = {
        effort: effort || "medium",
        summary: options?.reasoningSummary || "auto",
      };
    } else if (model.name.startsWith("gpt-5")) {
      messages.push({
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "# Juice: 0 !important",
          },
        ],
      });
    }
  }

  return params;
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
function applyServiceTierPricing(usage, serviceTier) {
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
 * Кодирование text signature в формате pi-ai.
 *
 * @param {string} id ID сообщения.
 * @param {string | undefined} phase Фаза OpenAI message item.
 * @returns {string} Строка signature.
 */
function encodeTextSignatureV1(id, phase) {
  const payload = { v: 1, id };
  if (phase) {
    payload.phase = phase;
  }
  return JSON.stringify(payload);
}

/**
 * Карта stop reason из статуса Responses API.
 *
 * @param {string | undefined} status Статус ответа.
 * @returns {"stop" | "length" | "error"} Stop reason.
 */
function mapStopReason(status) {
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

/**
 * Обновление assistant message по полному response.completed.
 *
 * @param {any} output Partial/final assistant message.
 * @param {any} response Полный response.completed.response.
 * @param {{messageBlockByItemId: Map<string, number>, searchCallIds: Set<string>, searchToolBlockById: Map<string, number>, searchResultBlockById: Map<string, number>}} state Служебное состояние.
 * @param {any} stream Stream assistant events.
 * @returns {void}
 */
function enrichOutputFromCompletedResponse(output, response, state, stream) {
  const responseOutput = Array.isArray(response?.output) ? response.output : [];
  const allSources = dedupeSources(
    responseOutput
      .filter((item) => item?.type === "web_search_call")
      .flatMap((item) => extractActionSources(item.action)),
  );

  for (const item of responseOutput) {
    if (item?.type === "web_search_call") {
      const toolBlockIndex = state.searchToolBlockById.get(item.id);
      if (toolBlockIndex == null) {
        output.content.push({
          type: "serverToolUse",
          id: item.id,
          name: "web_search",
          input: summarizeSearchInput(item.action),
        });
        state.searchCallIds.add(item.id);
        state.searchToolBlockById.set(item.id, output.content.length - 1);
        stream.push({
          type: "server_tool_use",
          contentIndex: output.content.length - 1,
          partial: output,
        });
      } else {
        const existingToolBlock = output.content[toolBlockIndex];
        if (existingToolBlock?.type === "serverToolUse") {
          existingToolBlock.input = summarizeSearchInput(item.action);
        }
      }

      const resultContent = buildWebSearchResultContent(extractActionSources(item.action));
      const resultBlockIndex = state.searchResultBlockById.get(item.id);
      if (resultBlockIndex == null) {
        output.content.push({
          type: "webSearchResult",
          toolUseId: item.id,
          content: resultContent,
        });
        state.searchResultBlockById.set(item.id, output.content.length - 1);
        stream.push({
          type: "web_search_result",
          contentIndex: output.content.length - 1,
          partial: output,
        });
      } else {
        const existingResultBlock = output.content[resultBlockIndex];
        if (existingResultBlock?.type === "webSearchResult") {
          existingResultBlock.content = resultContent;
        }
      }
      continue;
    }

    if (item?.type !== "message") {
      continue;
    }

    const messageBlockIndex = state.messageBlockByItemId.get(item.id);
    if (messageBlockIndex == null) {
      continue;
    }

    const block = output.content[messageBlockIndex];
    if (!block || block.type !== "text") {
      continue;
    }

    const annotationSources = extractAnnotationSources(item);
    const mergedSources = annotationSources.length > 0 ? annotationSources : allSources;
    block.text = appendStructuredCitations(block.text, mergedSources);
  }
}

/**
 * Расширенный parser OpenAI Responses stream.
 *
 * @param {AsyncIterable<any>} openaiStream Поток SDK.
 * @param {any} output Partial assistant message.
 * @param {any} stream Stream assistant events.
 * @param {any} model Модель.
 * @param {{serviceTier?: string}} options Дополнительные опции.
 * @returns {Promise<void>} Promise завершения.
 */
async function processResponsesStreamWithSearchDisplay(openaiStream, output, stream, model, options) {
  let currentItem = null;
  let currentBlock = null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;
  const state = {
    messageBlockByItemId: new Map(),
    searchCallIds: new Set(),
    searchToolBlockById: new Map(),
    searchResultBlockById: new Map(),
  };

  for await (const event of openaiStream) {
    if (event.type === "response.output_item.added") {
      const item = event.item;
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        state.messageBlockByItemId.set(item.id, blockIndex());
        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "function_call") {
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: {},
          partialJson: item.arguments || "",
        };
        output.content.push(currentBlock);
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "web_search_call") {
        output.content.push({
          type: "serverToolUse",
          id: item.id,
          name: "web_search",
          input: summarizeSearchInput(item.action),
        });
        state.searchCallIds.add(item.id);
        state.searchToolBlockById.set(item.id, blockIndex());
        stream.push({ type: "server_tool_use", contentIndex: blockIndex(), partial: output });
      }
    } else if (event.type === "response.reasoning_summary_part.added") {
      if (currentItem && currentItem.type === "reasoning") {
        currentItem.summary = currentItem.summary || [];
        currentItem.summary.push(event.part);
      }
    } else if (event.type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.reasoning_summary_part.done") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += "\n\n";
          lastPart.text += "\n\n";
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: "\n\n",
            partial: output,
          });
        }
      }
    } else if (event.type === "response.content_part.added") {
      if (currentItem?.type === "message") {
        currentItem.content = currentItem.content || [];
        if (event.part.type === "output_text" || event.part.type === "refusal") {
          currentItem.content.push(event.part);
        }
      }
    } else if (event.type === "response.output_text.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        if (!currentItem.content || currentItem.content.length === 0) {
          continue;
        }
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "output_text") {
          currentBlock.text += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        if (!currentItem.content || currentItem.content.length === 0) {
          continue;
        }
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "refusal") {
          currentBlock.text += event.delta;
          lastPart.refusal += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson += event.delta;
        try {
          currentBlock.arguments = JSON.parse(currentBlock.partialJson);
        } catch {
          // частичный json во время stream
        }
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output,
        });
      }
    } else if (event.type === "response.function_call_arguments.done") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson = event.arguments;
        try {
          currentBlock.arguments = JSON.parse(currentBlock.partialJson || "{}");
        } catch {
          currentBlock.arguments = {};
        }
      }
    } else if (event.type === "response.output_item.done") {
      const item = event.item;
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = item.summary?.map((summary) => summary.text).join("\n\n") || "";
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: currentBlock.thinking,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = item.content.map((content) => (content.type === "output_text" ? content.text : content.refusal)).join("");
        currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
        stream.push({
          type: "text_end",
          contentIndex: blockIndex(),
          content: currentBlock.text,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        let args = {};
        if (currentBlock?.type === "toolCall" && currentBlock.partialJson) {
          try {
            args = JSON.parse(currentBlock.partialJson);
          } catch {
            args = {};
          }
        } else {
          try {
            args = JSON.parse(item.arguments || "{}");
          } catch {
            args = {};
          }
        }
        const toolCall = {
          type: "toolCall",
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: args,
        };
        currentBlock = null;
        stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
      } else if (item.type === "web_search_call") {
        const resultBlockIndex = state.searchResultBlockById.get(item.id);
        if (resultBlockIndex == null) {
          output.content.push({
            type: "webSearchResult",
            toolUseId: item.id,
            content: buildWebSearchResultContent(extractActionSources(item.action)),
          });
          state.searchResultBlockById.set(item.id, blockIndex());
          stream.push({ type: "web_search_result", contentIndex: blockIndex(), partial: output });
        }
      }
    } else if (event.type === "response.completed") {
      const response = event.response;
      enrichOutputFromCompletedResponse(output, response, state, stream);
      if (response?.usage) {
        const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
        output.usage = {
          input: (response.usage.input_tokens || 0) - cachedTokens,
          output: response.usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          totalTokens: response.usage.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
      if (typeof model?.cost === "object") {
        output.usage.cost.input = (output.usage.input / 1_000_000) * (model.cost.input || 0);
        output.usage.cost.output = (output.usage.output / 1_000_000) * (model.cost.output || 0);
        output.usage.cost.cacheRead = (output.usage.cacheRead / 1_000_000) * (model.cost.cacheRead || 0);
        output.usage.cost.cacheWrite = (output.usage.cacheWrite / 1_000_000) * (model.cost.cacheWrite || 0);
        output.usage.cost.total =
          output.usage.cost.input +
          output.usage.cost.output +
          output.usage.cost.cacheRead +
          output.usage.cost.cacheWrite;
      }
      const serviceTier = response?.service_tier ?? options?.serviceTier;
      applyServiceTierPricing(output.usage, serviceTier);
      output.stopReason = mapStopReason(response?.status);
      if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }
    } else if (event.type === "error") {
      throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
    } else if (event.type === "response.failed") {
      throw new Error("Unknown error");
    }
  }
}

/**
 * Patched OpenAI Responses stream с поддержкой web_search_call и citations.
 *
 * @param {any} model Модель.
 * @param {any} context Контекст.
 * @param {any} options Опции provider stream.
 * @returns {any} AssistantMessageEventStream.
 */
export const streamPatchedOpenAIResponses = (model, context, options) => {
  const stream = new AssistantMessageEventStream();

  (async () => {
    const internals = await loadPiAiInternals();
    const output = internals.buildInitialOutput(model);

    try {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const client = await internals.createOpenAIClient(model, context, apiKey, {
        optionsHeaders: options?.headers,
      });
      let params = buildPatchedParams(model, context, options, internals);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams;
      }
      const openaiStream = await client.responses.create(params, options?.signal ? { signal: options.signal } : undefined);
      stream.push({ type: "start", partial: output });
      await processResponsesStreamWithSearchDisplay(openaiStream, output, stream, model, {
        serviceTier: options?.serviceTier,
      });
      internals.assertStreamSuccess(output, options?.signal);
      internals.finalizeStream(stream, output);
    } catch (error) {
      internals.handleStreamError(stream, output, error, options?.signal);
    }
  })().catch((error) => {
    const fallbackOutput = {
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
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    stream.push({ type: "error", reason: "error", error: fallbackOutput });
    stream.end();
  });

  return stream;
};

/**
 * Simple stream wrapper для patched provider.
 *
 * @param {any} model Модель.
 * @param {any} context Контекст.
 * @param {any} options Simple options.
 * @returns {any} AssistantMessageEventStream.
 */
export const streamSimplePatchedOpenAIResponses = (model, context, options) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  const reasoningEffort = supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning);
  return streamPatchedOpenAIResponses(model, context, {
    ...base,
    reasoningEffort,
  });
};

/**
 * Регистрация patched provider поверх встроенного openai-responses.
 *
 * @returns {void}
 */
export function registerOpenAIResponsesDisplayPatch() {
  if (globalThis[PATCH_FLAG]) {
    return;
  }

  registerApiProvider(
    {
      api: "openai-responses",
      stream: streamPatchedOpenAIResponses,
      streamSimple: streamSimplePatchedOpenAIResponses,
    },
    "pi-openai-search",
  );

  globalThis[PATCH_FLAG] = true;
}
