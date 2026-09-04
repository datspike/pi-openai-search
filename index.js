import { Box, Text, VStack } from "@earendil-works/pi-tui";
import { registerCoreOpenAISearchExtension } from "./src/core/extension/register-openai-search-extension.js";
import { bootstrapCompatRuntime } from "./src/compat/bootstrap.js";
import { registerNativeSearchEntries } from "./src/core/extension/search-entries.js";
import { registerCliproxySearchEvents } from "./src/compat/provider/cliproxy-search-events.js";

/**
 * Core-first extension для native OpenAI web_search.
 *
 * Supported paths: OpenAI Responses и OpenAI Codex Responses в standalone `pi`.
 * Compat bootstrap выполняется один раз и затем переиспользуется в lifecycle core-слоя.
 *
 * @param {any} pi Экземпляр pi runtime.
 */
export default async function registerOpenAISearchExtension(pi) {
  const compatRuntimePromise = bootstrapCompatRuntime(pi).catch((error) => ({
    warnings: [`Native search compat недоступен: ${error instanceof Error ? error.message : String(error)}`],
    activation: { appliedFeatures: [] },
  }));

  registerCoreOpenAISearchExtension(pi, {
    getCompatRuntime: () => compatRuntimePromise,
  });

  const compat = await compatRuntimePromise;
  registerCliproxySearchEvents(pi);
  // Публичные записи заменяют UI-патчи, но не дублируют явно включённый inline-режим.
  if (!compat.activation.appliedFeatures.includes("interactive-inline")
      && typeof pi.registerEntryRenderer === "function" && typeof pi.appendEntry === "function") {
    registerNativeSearchEntries(pi, { Box, Text, VStack });
  }
}
