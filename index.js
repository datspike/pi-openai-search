import { registerCoreOpenAISearchExtension } from "./src/core/extension/register-openai-search-extension.js";
import { ensureExperimentalCompat, startExperimentalProviderCompat } from "./src/compat/bootstrap.js";

/**
 * Core-first extension для native OpenAI web_search.
 *
 * Supported path: standalone `pi` + `provider=openai` + `api=openai-responses`.
 * Experimental compat подключается лениво и не является обязательным для baseline pipeline.
 *
 * @param {any} pi Экземпляр pi runtime.
 */
export default function registerOpenAISearchExtension(pi) {
  void ensureExperimentalCompat(pi);

  registerCoreOpenAISearchExtension(pi, {
    ensureExperimentalCompat: () => ensureExperimentalCompat(pi),
  });
}
