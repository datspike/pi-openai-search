import {
  AssistantMessageEventStream,
  getEnvApiKey,
  supportsXhigh,
} from "../runtime/pi-ai-compat.js";
import { loadNativeSearchConfig } from "../../core/config/native-search-config.js";
import { injectNativeWebSearch } from "../../core/payload/native-search.js";
import {
  applyServiceTierPricing,
  buildInitialOutput,
  createOpenAIClient,
  loadOpenAIResponsesInternals,
  mapStopReason,
} from "./openai-responses-client.js";
import {
  buildBaseOptions,
  buildPatchedParams,
  clampReasoning,
} from "./openai-responses-params.js";
import {
  encodeReasoningSignature,
  enrichOutputFromCompletedResponse,
  isCompactNoSessionOutput,
  processResponsesStreamWithSearchDisplay,
  upsertSearchToolUseBlock,
} from "./openai-responses-search-mapper.js";

/**
 * Проверка успешного завершения patched stream.
 *
 * @param {any} output Финальное сообщение.
 * @param {AbortSignal | undefined} signal Abort signal.
 * @returns {void}
 */
function assertStreamSuccess(output, signal) {
  if (signal?.aborted) {
    throw new Error("Request was aborted");
  }

  if (output.stopReason === "aborted") {
    throw new Error("Request was aborted");
  }

  if (output.stopReason === "error") {
    throw new Error(output.errorMessage || "An unknown error occurred");
  }
}

/**
 * Успешное завершение event stream.
 *
 * @param {any} stream Event stream.
 * @param {any} output Финальное сообщение.
 * @returns {void}
 */
function finalizeStream(stream, output) {
  stream.push({ type: "done", reason: output.stopReason, message: output });
  stream.end();
}

/**
 * Унифицированная обработка ошибок patched provider.
 *
 * @param {any} stream Event stream.
 * @param {any} output Финальное сообщение.
 * @param {unknown} error Ошибка.
 * @param {AbortSignal | undefined} signal Abort signal.
 * @returns {void}
 */
function handleStreamError(stream, output, error, signal) {
  for (const block of output.content) {
    delete block.index;
  }

  output.stopReason = signal?.aborted ? "aborted" : "error";
  output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
  stream.push({ type: "error", reason: output.stopReason, error: output });
  stream.end();
}

// Bootstrap installs a promise here rather than making the public extension hook
// infer a model. A rejected overlay is intentionally ignored by this boundary:
// the request still uses the documented provider path without private patches.
let providerCompatReadiness;

/**
 * Установка readiness promise для authoritative provider boundary.
 *
 * @param {Promise<unknown> | undefined} readiness Bootstrap-owned readiness promise.
 * @returns {void}
 */
export function setProviderCompatReadiness(readiness) {
  providerCompatReadiness = readiness;
}

async function awaitProviderCompatReadiness(readiness) {
  if (!readiness) {
    return;
  }

  try {
    await readiness;
  } catch {
    // Feature-level fail-open: do not turn an optional compat failure into a
    // failed OpenAI Responses request.
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
    const internals = await loadOpenAIResponsesInternals();
    const output = buildInitialOutput(model);

    try {
      await awaitProviderCompatReadiness(options?.providerCompatReadiness || providerCompatReadiness);
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const client = createOpenAIClient(model, apiKey, internals, options?.headers);
      let params = buildPatchedParams(model, context, options, internals);
      // This is the sole model-aware request boundary: unlike the public hook,
      // `model` is authoritative here and cannot be reconstructed from payload.
      params = injectNativeWebSearch(params, model, options?.nativeSearchConfig || loadNativeSearchConfig());
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams;
      }
      // Emit start before waiting for the provider response. This keeps the
      // success sequence observable as start -> provider events -> done -> end;
      // failures may still be start? -> error -> end.
      stream.push({ type: "start", partial: output });
      const openaiStream = await client.responses.create(params, options?.signal ? { signal: options.signal } : undefined);
      await processResponsesStreamWithSearchDisplay(openaiStream, output, stream, model, {
        serviceTier: options?.serviceTier,
      }, {
        applyServiceTierPricing,
        mapStopReason,
      });
      assertStreamSuccess(output, options?.signal);
      finalizeStream(stream, output);
    } catch (error) {
      handleStreamError(stream, output, error, options?.signal);
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
  const base = buildBaseOptions(model, options, apiKey);
  const reasoningEffort = supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning);
  return streamPatchedOpenAIResponses(model, context, {
    ...base,
    reasoningEffort,
  });
};

export {
  buildPatchedParams,
  encodeReasoningSignature,
  enrichOutputFromCompletedResponse,
  isCompactNoSessionOutput,
  upsertSearchToolUseBlock,
};
