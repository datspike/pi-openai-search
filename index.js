import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  injectNativeWebSearch,
  isOpenAIResponsesModel,
  loadNativeSearchConfig,
} from "./src/openai-native-search.js";
import { getFactualSearchLifecycleUpdate } from "./src/openai-search-display.js";
import { registerOpenAIResponsesDisplayPatch } from "./src/openai-responses-display-patch.js";

const NATIVE_SEARCH_STATUS_KEY = "openai-native-web-search";

/**
 * Отладочный снимок payload перед отправкой провайдеру.
 *
 * @param {string | undefined} path Путь к json-файлу.
 * @param {any} model Текущая модель.
 * @param {any} payload Provider payload.
 * @returns {Promise<void>} Promise записи.
 */
async function writeDebugSnapshot(path, model, payload) {
  if (!path) {
    return;
  }

  const snapshot = {
    timestamp: new Date().toISOString(),
    model,
    toolChoice: payload?.tool_choice,
    parallelToolCalls: payload?.parallel_tool_calls,
    toolCount: Array.isArray(payload?.tools) ? payload.tools.length : 0,
    tools: Array.isArray(payload?.tools)
      ? payload.tools.map((tool) => {
          if (tool?.type === "function") {
            return {
              type: tool.type,
              name: tool.name,
            };
          }
          return tool;
        })
      : [],
    hasMessages: Array.isArray(payload?.messages),
    messageCount: Array.isArray(payload?.messages) ? payload.messages.length : undefined,
    hasInput: Array.isArray(payload?.input),
    inputCount: Array.isArray(payload?.input) ? payload.input.length : undefined,
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

/**
 * Отладочный снимок финального assistant message.
 *
 * @param {string | undefined} path Путь к json-файлу.
 * @param {any} message Финальное сообщение.
 * @returns {Promise<void>} Promise записи.
 */
async function writeMessageDebugSnapshot(path, message) {
  if (!path || message?.role !== "assistant") {
    return;
  }

  const snapshot = {
    timestamp: new Date().toISOString(),
    role: message.role,
    api: message.api,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    content: Array.isArray(message.content)
      ? message.content.map((block) => {
          if (block?.type === "text") {
            return {
              type: block.type,
              text: block.text,
            };
          }
          if (block?.type === "serverToolUse") {
            return {
              type: block.type,
              id: block.id,
              name: block.name,
              input: block.input,
            };
          }
          if (block?.type === "webSearchResult") {
            return {
              type: block.type,
              toolUseId: block.toolUseId,
              content: block.content,
            };
          }
          if (block?.type === "toolCall") {
            return {
              type: block.type,
              id: block.id,
              name: block.name,
              arguments: block.arguments,
            };
          }
          return block;
        })
      : [],
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

/**
 * Получение последнего активного factual search.
 *
 * @param {Map<string, {statusText: string, workingMessage: string}>} activeSearches Активные поиски.
 * @returns {{statusText: string, workingMessage: string} | undefined} Последний активный поиск.
 */
function getLastActiveSearch(activeSearches) {
  let lastActiveSearch;

  for (const activeSearch of activeSearches.values()) {
    lastActiveSearch = activeSearch;
  }

  return lastActiveSearch;
}

/**
 * POC extension для native OpenAI web_search.
 *
 * Работает только для провайдеров на базе OpenAI Responses API.
 * Для openai-completions ничего не меняет.
 *
 * @param {any} pi Экземпляр pi runtime.
 */
export default function registerOpenAISearchExtension(pi) {
  registerOpenAIResponsesDisplayPatch();

  let lastStatusKey;
  let nativeReadyStatus;
  const activeSearches = new Map();

  pi.on("model_select", async (event, ctx) => {
    const config = loadNativeSearchConfig();
    const model = event?.model;

    if (!model || !ctx?.hasUI) {
      return;
    }

    const nativeActive = config.enabled && config.mode !== "off" && isOpenAIResponsesModel(model);
    const statusKey = nativeActive
      ? `native:${model.provider}:${model.id}:${config.mode}`
      : `inactive:${model.provider}:${model.id}`;

    if (statusKey === lastStatusKey) {
      return;
    }
    lastStatusKey = statusKey;
    nativeReadyStatus = nativeActive ? "web: ready" : undefined;
    activeSearches.clear();

    ctx.ui.setWorkingMessage();
    ctx.ui.setStatus(NATIVE_SEARCH_STATUS_KEY, nativeReadyStatus);

    if (nativeActive) {
      const parts = [
        `Native OpenAI web search active`,
        `${model.provider}/${model.id}`,
        `mode=${config.mode}`,
      ];
      if (config.contextSize) {
        parts.push(`context=${config.contextSize}`);
      }
      if (config.allowedDomains?.length) {
        parts.push(`domains=${config.allowedDomains.join(",")}`);
      }
      ctx.ui.notify(parts.join(" | "), "info");
    }
  });

  pi.on("before_provider_request", (event) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") {
      return;
    }

    const config = loadNativeSearchConfig();
    const nextPayload = injectNativeWebSearch(payload, event?.model, config);

    const debugPath = process.env.PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE;
    if (debugPath) {
      void writeDebugSnapshot(debugPath, event?.model, nextPayload).catch(() => {
        // best-effort debug snapshot without runtime impact
      });
    }
    return nextPayload;
  });

  pi.on("message_update", (event, ctx) => {
    const lifecycleUpdate = getFactualSearchLifecycleUpdate(event?.assistantMessageEvent);
    if (!lifecycleUpdate) {
      return;
    }

    if (lifecycleUpdate.phase === "searching") {
      activeSearches.set(lifecycleUpdate.toolUseId, {
        statusText: lifecycleUpdate.statusText,
        workingMessage: lifecycleUpdate.workingMessage,
      });
    } else {
      activeSearches.delete(lifecycleUpdate.toolUseId);
    }

    if (!ctx?.hasUI) {
      return;
    }

    if (lifecycleUpdate.phase === "searching") {
      ctx.ui.setWorkingMessage(lifecycleUpdate.workingMessage);
      ctx.ui.setStatus(NATIVE_SEARCH_STATUS_KEY, lifecycleUpdate.statusText);
      return;
    }

    const lastActiveSearch = getLastActiveSearch(activeSearches);
    if (lastActiveSearch) {
      ctx.ui.setWorkingMessage(lastActiveSearch.workingMessage);
      ctx.ui.setStatus(NATIVE_SEARCH_STATUS_KEY, lastActiveSearch.statusText);
      return;
    }

    ctx.ui.setWorkingMessage();
    ctx.ui.setStatus(NATIVE_SEARCH_STATUS_KEY, lifecycleUpdate.statusText || nativeReadyStatus);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event?.message?.role === "assistant" && activeSearches.size > 0) {
      activeSearches.clear();
      if (ctx?.hasUI) {
        ctx.ui.setWorkingMessage();
        ctx.ui.setStatus(NATIVE_SEARCH_STATUS_KEY, nativeReadyStatus);
      }
    }

    const debugPath = process.env.PI_OPENAI_NATIVE_SEARCH_DEBUG_MESSAGE_FILE;
    if (!debugPath) {
      return;
    }

    try {
      await writeMessageDebugSnapshot(debugPath, event?.message);
    } catch {
      // best-effort debug snapshot without runtime impact
    }
  });
}
