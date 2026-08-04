import {
  appendStructuredCitations,
  buildWebSearchResultContent,
  dedupeSources,
  extractAnnotationSources,
  extractStructuredSearchCallSources,
  resolveWebSearchResultSources,
} from "../../core/truthful/search-results.js";
import { summarizeSearchInput } from "../../core/lifecycle/search-status.js";

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
 * @param {any} item OpenAI reasoning item.
 * @returns {string | undefined} Компактная JSON-signature или undefined.
 */
export function encodeReasoningSignature(item) {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  /** @type {{type: "reasoning", id?: string, encrypted_content?: string, status?: string, summary: Array<any>}} */
  const payload = {
    type: "reasoning",
    summary: Array.isArray(item.summary) ? item.summary : [],
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
          queries: block.input.queries,
          url: block.input.url,
          page_url: block.input.page_url,
          pattern: block.input.pattern,
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
 * Компактный partial для streaming assistant events в JSON proof path.
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
 * Обновление assistant message по полному response.completed.
 *
 * @param {any} output Partial/final assistant message.
 * @param {any} response Полный response.completed.response.
 * @param {{messageBlockByItemId: Map<string, number>, searchCallIds: Set<string>, searchToolBlockById: Map<string, number>, searchResultBlockById: Map<string, number>}} state Служебное состояние.
 * @param {any} stream Stream assistant events.
 * @param {boolean} compactMode Флаг compact stdout path.
 * @returns {void}
 */
export function enrichOutputFromCompletedResponse(output, response, state, stream, compactMode = false) {
  const responseOutput = Array.isArray(response?.output) ? response.output : [];
  const searchCalls = responseOutput.filter(
    (item) => item?.type === "web_search_call" && typeof item.id === "string" && item.id.length > 0,
  );
  const searchCallSourcesById = new Map(
    searchCalls.map((item) => [item.id, extractStructuredSearchCallSources(item.action, item.results)]),
  );
  const annotationSources = dedupeSources(
    responseOutput
      .filter((item) => item?.type === "message")
      .flatMap((item) => extractAnnotationSources(item)),
  );
  const allSources = dedupeSources(
    searchCalls.flatMap((item) => searchCallSourcesById.get(item.id) || []),
  );

  for (const item of responseOutput) {
    if (item?.type === "web_search_call" && typeof item.id === "string" && item.id.length > 0) {
      upsertSearchToolUseBlock(output, state, item, stream, compactMode);

      const perCallSources = searchCallSourcesById.get(item.id) || [];
      // A completed response can contain several search calls. Sources observed
      // for one call must never be reassigned to another call merely because it
      // happens to be the terminal item; annotations remain a separate textual
      // citation seam and are not correlated to a search call.
      const resultSources = resolveWebSearchResultSources(perCallSources, []);
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
          const hasObservedSources = Array.isArray(existingResultBlock.content) && existingResultBlock.content.length > 0;
          // A late completed payload may omit sources already observed in the
          // stream. Empty data is not authoritative and must not erase them.
          if (resultSources.length > 0 || !hasObservedSources) {
            existingResultBlock.content = resultContent;
          }
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
 * Upsert factual serverToolUse block для native web_search.
 *
 * @param {any} output Partial assistant message.
 * @param {{searchCallIds: Set<string>, searchToolBlockById: Map<string, number>}} state Служебное состояние.
 * @param {any} item Один web_search_call item.
 * @param {any} stream Stream assistant events.
 * @param {boolean} compactMode Флаг compact stdout path.
 * @returns {number} Индекс serverToolUse блока.
 */
export function upsertSearchToolUseBlock(output, state, item, stream, compactMode = false) {
  if (typeof item?.id !== "string" || item.id.length === 0) {
    return -1;
  }

  const nextInput = summarizeSearchInput(item.action);
  const toolBlockIndex = state.searchToolBlockById.get(item.id);

  if (toolBlockIndex == null) {
    output.content.push({
      type: "serverToolUse",
      id: item.id,
      name: "web_search",
      input: nextInput,
    });
    state.searchCallIds.add(item.id);
    state.searchToolBlockById.set(item.id, output.content.length - 1);
    stream.push({
      type: "server_tool_use",
      ...buildAssistantEventContext(output, output.content.length - 1, compactMode, "server_tool_use"),
    });
    return output.content.length - 1;
  }

  const existingToolBlock = output.content[toolBlockIndex];
  if (existingToolBlock?.type === "serverToolUse") {
    const previousInput = JSON.stringify(existingToolBlock.input ?? {});
    // `output_item.added` frequently has no action yet. Do not let a later
    // empty duplicate remove a query observed at an authoritative seam.
    const existingInput = existingToolBlock.input ?? {};
    const nextHasDetail = ["query", "queries", "url", "page_url", "pattern"]
      .some((key) => nextInput[key] != null);
    const existingHasDetail = ["query", "queries", "url", "page_url", "pattern"]
      .some((key) => existingInput[key] != null);
    if (nextHasDetail || !existingHasDetail) {
      existingToolBlock.input = nextInput;
    }
    if (previousInput !== JSON.stringify(existingToolBlock.input ?? {})) {
      stream.push({
        type: "server_tool_use",
        ...buildAssistantEventContext(output, toolBlockIndex, compactMode, "server_tool_use"),
      });
    }
  }

  return toolBlockIndex;
}

/**
 * Расширенный parser OpenAI Responses stream.
 *
 * @param {AsyncIterable<any>} openaiStream Поток SDK.
 * @param {any} output Partial assistant message.
 * @param {any} stream Stream assistant events.
 * @param {any} model Модель.
 * @param {{serviceTier?: string}} options Дополнительные опции.
 * @param {{applyServiceTierPricing: Function, mapStopReason: Function}} helpers Вспомогательные функции stream layer.
 * @returns {Promise<void>} Promise завершения.
 */
export async function processResponsesStreamWithSearchDisplay(
  openaiStream,
  output,
  stream,
  model,
  options,
  helpers,
) {
  let currentItem = null;
  let currentBlock = null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;
  const compactStreamEvents = isCompactNoSessionOutput(options);
  const eventContext = (eventType, contentIndex) =>
    buildAssistantEventContext(output, contentIndex, compactStreamEvents, eventType);
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
        upsertSearchToolUseBlock(output, state, item, stream, compactStreamEvents);
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
      } else if (item.type === "web_search_call" && typeof item.id === "string" && item.id.length > 0) {
        upsertSearchToolUseBlock(output, state, item, stream, compactStreamEvents);
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
      helpers.applyServiceTierPricing(output.usage, serviceTier);
      output.stopReason = helpers.mapStopReason(response?.status);
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
