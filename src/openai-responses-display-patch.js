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
  extractAnnotationSources,
  extractStructuredSearchCallSources,
  resolveWebSearchResultSources,
  summarizeSearchInput,
} from "./openai-search-display.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

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

  const requestedReasoningEffort = options?.reasoningEffort;
  const requestedReasoningSummary = options?.reasoningSummary;

  if (model.reasoning) {
    params.include = ["reasoning.encrypted_content"];
    if (requestedReasoningEffort || requestedReasoningSummary) {
      const effort = internals.clampReasoningForModel(model.name, requestedReasoningEffort || "medium");
      params.reasoning = {
        effort: effort || "medium",
        summary: requestedReasoningSummary || "auto",
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
 * Компактное представление reasoning item для последующих turn-ов.
 *
 * OpenAI Responses требует вернуть parseable reasoning item, но для session history
 * здесь достаточно identity + encrypted content. Полный summary раздувает каждый
 * JSONL `message_update`, потому что `partial` повторяет весь накопленный output.
 *
 * @param {any} item OpenAI reasoning item.
 * @returns {string | undefined} Компактная JSON-signature или undefined.
 */
function encodeReasoningSignature(item) {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  /** @type {{type: "reasoning", id?: string, encrypted_content?: string, status?: string}} */
  const payload = {
    type: "reasoning",
  };

  if (typeof item.id === "string" && item.id.length > 0) {
    payload.id = item.id;
  }
  if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
    payload.encrypted_content = item.encrypted_content;
  }
  if (typeof item.status === "string" && item.status.length > 0) {
    payload.status = item.status;
  }

  if (!payload.id && !payload.encrypted_content) {
    return undefined;
  }

  return JSON.stringify(payload);
}

/**
 * Определение компактного no-session stdout режима.
 *
 * @param {{sessionId?: string} | undefined} options Stream options.
 * @returns {boolean} true, если это no-session print/piped run без TTY.
 */
export function isCompactNoSessionOutput(options) {
  void options;
  return process.stdout?.isTTY !== true;
}

/**
 * Компактный partial для streaming assistant events в JSON proof path.
 *
 * Полный growing `partial` нужен интерактивному runtime, но в no-session print/piped
 * режиме downstream proof читает terminal `message_end`, а не восстанавливает UI из
 * всех delta-событий. Поэтому для этого режима достаточно текущего блока.
 *
 * @param {any} output Текущий partial assistant message.
 * @param {number} contentIndex Индекс обновляемого блока в полном output.
 * @param {boolean} compactMode Нужно ли сжимать partial.
 * @param {string | undefined} eventType Тип assistant event.
 * @returns {{contentIndex: number, partial: any}} Нормализованный event context.
 */
function buildAssistantEventContext(output, contentIndex, compactMode = false, eventType = undefined) {
  if (!compactMode || !output || typeof output !== "object" || !Array.isArray(output.content)) {
    return {
      contentIndex,
      partial: output,
    };
  }

  const shouldKeepBlock = eventType === "server_tool_use" || eventType === "web_search_result";
  const content = shouldKeepBlock ? compactAssistantEventBlock(output.content[contentIndex], eventType) : undefined;
  return {
    contentIndex: content ? 0 : contentIndex,
    partial: {
      role: output.role,
      api: output.api,
      provider: output.provider,
      model: output.model,
      stopReason: output.stopReason,
      timestamp: output.timestamp,
      content: content ? [content] : [],
    },
  };
}

/**
 * Сжатие factual block для compact stdout path.
 *
 * @param {any} block Текущий assistant content block.
 * @param {string | undefined} eventType Тип assistant event.
 * @returns {any} Компактный block.
 */
function compactAssistantEventBlock(block, eventType) {
  if (!block || typeof block !== "object") {
    return undefined;
  }

  if (eventType === "server_tool_use" && block.type === "serverToolUse") {
    const input = block.input && typeof block.input === "object"
      ? {
          type: block.input.type,
          query: block.input.query,
          url: block.input.url,
          status: block.input.status,
        }
      : block.input;
    return {
      type: block.type,
      id: block.id,
      name: block.name,
      input,
    };
  }

  if (eventType === "web_search_result" && block.type === "webSearchResult") {
    const content = Array.isArray(block.content)
      ? block.content.map((item) => (item && typeof item === "object" && item.type ? { type: item.type } : {}))
      : block.content && typeof block.content === "object" && block.content.type
        ? { type: block.content.type }
        : block.content;
    return {
      type: block.type,
      toolUseId: block.toolUseId,
      content,
    };
  }

  return block;
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
 * Поиск терминального factual search call в `response.output`.
 *
 * @param {Array<any>} responseOutput Output items из Responses API.
 * @returns {string | undefined} ID последнего `action.type === "search"`.
 */
function findTerminalSearchCallId(responseOutput) {
  let terminalSearchCallId;

  for (const item of responseOutput) {
    if (item?.type === "web_search_call" && item?.action?.type === "search" && item.id) {
      terminalSearchCallId = item.id;
    }
  }

  return terminalSearchCallId;
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
export function enrichOutputFromCompletedResponse(output, response, state, stream, compactMode = false) {
  const responseOutput = Array.isArray(response?.output) ? response.output : [];
  const searchCalls = responseOutput.filter((item) => item?.type === "web_search_call");
  const searchCallSourcesById = new Map(
    searchCalls.map((item) => [item.id, extractStructuredSearchCallSources(item.action, item.results)]),
  );
  const terminalSearchCallId = findTerminalSearchCallId(responseOutput);
  const annotationSources = dedupeSources(
    responseOutput
      .filter((item) => item?.type === "message")
      .flatMap((item) => extractAnnotationSources(item)),
  );
  const allSources = dedupeSources(
    searchCalls.flatMap((item) => searchCallSourcesById.get(item.id) || []),
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
          ...buildAssistantEventContext(output, output.content.length - 1, compactMode, "server_tool_use"),
        });
      } else {
        const existingToolBlock = output.content[toolBlockIndex];
        if (existingToolBlock?.type === "serverToolUse") {
          existingToolBlock.input = summarizeSearchInput(item.action);
        }
      }

      const perCallSources = searchCallSourcesById.get(item.id) || [];
      const resultSources = item.id === terminalSearchCallId
        ? resolveWebSearchResultSources(allSources, annotationSources)
        : resolveWebSearchResultSources(perCallSources, []);
      const resultContent = buildWebSearchResultContent(resultSources);
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
          ...buildAssistantEventContext(output, output.content.length - 1, compactMode, "web_search_result"),
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

    const itemAnnotationSources = extractAnnotationSources(item);
    const mergedSources = itemAnnotationSources.length > 0 ? itemAnnotationSources : allSources;
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
  const compactStreamEvents = isCompactNoSessionOutput(options);
  const eventContext = (eventType, contentIndex) => buildAssistantEventContext(output, contentIndex, compactStreamEvents, eventType);
  const currentEventContext = (eventType) => eventContext(eventType, blockIndex());
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
        stream.push({ type: "thinking_start", ...currentEventContext("thinking_start") });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        state.messageBlockByItemId.set(item.id, blockIndex());
        stream.push({ type: "text_start", ...currentEventContext("text_start") });
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
        stream.push({ type: "toolcall_start", ...currentEventContext("toolcall_start") });
      } else if (item.type === "web_search_call") {
        output.content.push({
          type: "serverToolUse",
          id: item.id,
          name: "web_search",
          input: summarizeSearchInput(item.action),
        });
        state.searchCallIds.add(item.id);
        state.searchToolBlockById.set(item.id, blockIndex());
        stream.push({ type: "server_tool_use", ...currentEventContext("server_tool_use") });
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
            ...currentEventContext("thinking_delta"),
            delta: event.delta,
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
            ...currentEventContext("thinking_delta"),
            delta: "\n\n",
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
            ...currentEventContext("text_delta"),
            delta: event.delta,
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
            ...currentEventContext("text_delta"),
            delta: event.delta,
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
          ...currentEventContext("toolcall_delta"),
          delta: event.delta,
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
        currentBlock.thinkingSignature = compactStreamEvents ? undefined : encodeReasoningSignature(item);
        stream.push({
          type: "thinking_end",
          ...currentEventContext("thinking_end"),
          content: currentBlock.thinking,
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = item.content.map((content) => (content.type === "output_text" ? content.text : content.refusal)).join("");
        currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
        stream.push({
          type: "text_end",
          ...currentEventContext("text_end"),
          content: currentBlock.text,
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
        stream.push({ type: "toolcall_end", ...currentEventContext("toolcall_end"), toolCall });
      } else if (item.type === "web_search_call") {
        const resultBlockIndex = state.searchResultBlockById.get(item.id);
        if (resultBlockIndex == null) {
          output.content.push({
            type: "webSearchResult",
            toolUseId: item.id,
            content: buildWebSearchResultContent(
              resolveWebSearchResultSources(extractStructuredSearchCallSources(item.action, item.results), []),
            ),
          });
          state.searchResultBlockById.set(item.id, blockIndex());
          stream.push({ type: "web_search_result", ...currentEventContext("web_search_result") });
        }
      }
    } else if (event.type === "response.completed") {
      const response = event.response;
      enrichOutputFromCompletedResponse(output, response, state, stream, compactStreamEvents);
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
      if (compactStreamEvents) {
        output.content = output.content.filter((block) => block?.type !== "thinking");
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
 * Конфиг provider registration для session-safe extension pipeline.
 *
 * `pi.registerProvider()` умеет подменять handler только для моделей
 * конкретного provider name и не ломает остальные `openai-responses`-потребители.
 * Это важно для interactive mode, где direct global override может расходиться
 * с тем provider path, который использует текущая session.
 *
 * @returns {{api: string, streamSimple: Function}} Конфиг для `pi.registerProvider()`.
 */
export function buildPatchedOpenAIResponsesProviderConfig() {
  return {
    api: "openai-responses",
    streamSimple: streamSimplePatchedOpenAIResponses,
  };
}

/**
 * Регистрация patched provider поверх встроенного openai-responses.
 *
 * @returns {void}
 */
export function registerOpenAIResponsesDisplayPatch() {
  registerApiProvider(
    {
      api: "openai-responses",
      stream: streamPatchedOpenAIResponses,
      streamSimple: streamSimplePatchedOpenAIResponses,
    },
    "pi-openai-search",
  );
}
