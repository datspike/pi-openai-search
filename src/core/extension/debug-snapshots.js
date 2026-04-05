import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Отладочный снимок payload перед отправкой провайдеру.
 *
 * @param {string | undefined} path Путь к json-файлу.
 * @param {any} model Текущая модель.
 * @param {any} payload Provider payload.
 * @returns {Promise<void>} Promise записи.
 */
export async function writeDebugSnapshot(path, model, payload) {
  if (!path) {
    return;
  }

  const snapshot = {
    timestamp: new Date().toISOString(),
    model,
    toolChoice: payload?.tool_choice,
    parallelToolCalls: payload?.parallel_tool_calls,
    include: Array.isArray(payload?.include) ? payload.include : undefined,
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
export async function writeMessageDebugSnapshot(path, message) {
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
