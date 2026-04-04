import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  injectNativeWebSearch,
  isOpenAIResponsesModel,
  loadNativeSearchConfig,
} from "./src/openai-native-search.js";
import { registerOpenAIResponsesDisplayPatch } from "./src/openai-responses-display-patch.js";

const NATIVE_SEARCH_STATUS_KEY = "openai-native-web-search";
const NATIVE_SEARCH_WORKING_MESSAGE = "Native web search in progress...";
const URL_PATTERN = /https?:\/\/[^\s)\]>"']+/g;

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
 * Проверка наличия native web_search в provider payload.
 *
 * @param {any} payload Provider payload.
 * @returns {boolean} Признак наличия native web_search.
 */
function hasNativeWebSearchTool(payload) {
  return Array.isArray(payload?.tools) && payload.tools.some((tool) => tool?.type === "web_search");
}

/**
 * Извлечение текстового ответа assistant message.
 *
 * @param {any} message Финальное сообщение assistant.
 * @returns {string} Склеенный текст ответа.
 */
function getAssistantText(message) {
  if (!Array.isArray(message?.content)) {
    return "";
  }

  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

/**
 * Извлечение уникальных URL из текстового ответа assistant.
 *
 * @param {any} message Финальное сообщение assistant.
 * @returns {string[]} Уникальные URL.
 */
function extractAssistantUrls(message) {
  const matches = getAssistantText(message).match(URL_PATTERN) || [];
  const urls = matches.map((url) => url.replace(/[.,;:!?]+$/u, ""));
  return [...new Set(urls)];
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
  let nativeSearchInFlight = false;

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

    ctx.ui.setWorkingMessage();
    ctx.ui.setStatus(NATIVE_SEARCH_STATUS_KEY, nativeActive ? "web: ready" : undefined);

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

  pi.on("before_provider_request", (event, ctx) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") {
      return;
    }

    const config = loadNativeSearchConfig();
    const nextPayload = injectNativeWebSearch(payload, event?.model, config);

    if (ctx?.hasUI && hasNativeWebSearchTool(nextPayload)) {
      nativeSearchInFlight = true;
      ctx.ui.setWorkingMessage(NATIVE_SEARCH_WORKING_MESSAGE);
      ctx.ui.setStatus(NATIVE_SEARCH_STATUS_KEY, "web: searching");
    }

    const debugPath = process.env.PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE;
    if (debugPath) {
      void writeDebugSnapshot(debugPath, event?.model, nextPayload).catch(() => {
        // best-effort debug snapshot without runtime impact
      });
    }
    return nextPayload;
  });

  pi.on("message_end", async (event, ctx) => {
    if (event?.message?.role === "assistant" && nativeSearchInFlight && ctx?.hasUI) {
      nativeSearchInFlight = false;
      ctx.ui.setWorkingMessage();
      const urls = extractAssistantUrls(event.message);
      const resultLabel = urls.length > 0 ? `web: ${urls.length} source${urls.length === 1 ? "" : "s"}` : "web: finished";
      ctx.ui.setStatus(NATIVE_SEARCH_STATUS_KEY, resultLabel);
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
