import { registerCoreOpenAISearchExtension } from "./src/core/extension/register-openai-search-extension.js";
import { bootstrapCompatRuntime } from "./src/compat/bootstrap.js";

/**
 * Core-first extension для native OpenAI web_search.
 *
 * Supported paths: OpenAI Responses и OpenAI Codex Responses в standalone `pi`.
 * Compat bootstrap выполняется один раз и затем переиспользуется в lifecycle core-слоя.
 *
 * @param {any} pi Экземпляр pi runtime.
 */
export default function registerOpenAISearchExtension(pi) {
  const compatRuntimePromise = bootstrapCompatRuntime(pi);

  registerCoreOpenAISearchExtension(pi, {
    getCompatRuntime: () => compatRuntimePromise,
  });
}
