import {
  injectNativeWebSearch,
  isOpenAIResponsesModel,
} from "../payload/native-search.js";
import { loadNativeSearchConfig } from "../config/native-search-config.js";
import { getFactualSearchLifecycleUpdate } from "../lifecycle/search-status.js";
import { writeDebugSnapshot, writeMessageDebugSnapshot } from "./debug-snapshots.js";

export const NATIVE_SEARCH_STATUS_KEY = "openai-native-web-search";

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
 * Регистрация core-first extension pipeline.
 *
 * @param {any} pi Экземпляр pi runtime.
 * @param {{getCompatRuntime?: () => Promise<{warnings?: string[]}>}} options Опции композиции.
 * @returns {void}
 */
export function registerCoreOpenAISearchExtension(pi, options = {}) {
  const getCompatRuntime = options.getCompatRuntime || (async () => ({ warnings: [] }));

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
      const compat = await getCompatRuntime();
      for (const warning of compat?.warnings || []) {
        ctx.ui.notify(warning, "warning");
      }

      const parts = [
        "Native OpenAI web search active",
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
    const model = event?.model;
    const nextPayload = injectNativeWebSearch(payload, model, config);

    const debugPath = process.env.PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE;
    if (debugPath) {
      void writeDebugSnapshot(debugPath, model, nextPayload).catch(() => {
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
