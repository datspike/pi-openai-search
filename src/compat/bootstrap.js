import { registerInteractiveSearchOrderPatch } from "./interactive/search-order-patch.js";
import { registerTruthfulInteractiveWebSearchPatch } from "./interactive/tool-execution-web-search-patch.js";
import { registerCompatLayer } from "./runtime/pi-runtime.js";

let providerCompatPromise;
let uiCompatPromise;

/**
 * Eager bootstrap experimental provider compat для truthful search blocks.
 *
 * @param {any} pi Экземпляр pi runtime.
 * @returns {Promise<{warnings: string[]}>} Результат bootstrap.
 */
export function startExperimentalProviderCompat(pi) {
  if (!providerCompatPromise) {
    providerCompatPromise = registerCompatLayer(
      "provider-search-display",
      async () => {
        const providerCompat = await import("./provider/openai-responses-provider.js");

        if (typeof pi?.registerProvider === "function") {
          pi.registerProvider("openai", providerCompat.buildPatchedOpenAIResponsesProviderConfig());
          return;
        }

        providerCompat.registerOpenAIResponsesDisplayPatch();
      },
      process.env.PI_OPENAI_NATIVE_SEARCH_PROVIDER_COMPAT,
    ).then((providerCompat) => {
      const warnings = [];

      if (providerCompat.enabled && !providerCompat.applied) {
        warnings.push("Provider compat для native search недоступен; truthful search blocks отключены");
      }

      return { warnings };
    });
  }

  return providerCompatPromise;
}

/**
 * Ленивая регистрация experimental UI compat-слоя.
 *
 * @param {any} pi Экземпляр pi runtime.
 * @returns {Promise<{warnings: string[]}>} Результат bootstrap.
 */
export function ensureExperimentalCompat(pi) {
  if (!uiCompatPromise) {
    uiCompatPromise = Promise.all([
      registerCompatLayer(
        "interactive-inline-search",
        () => registerInteractiveSearchOrderPatch(),
        process.env.PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT,
      ),
      registerCompatLayer(
        "interactive-web-search-render",
        () => registerTruthfulInteractiveWebSearchPatch(),
        process.env.PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT,
      ),
    ]).then(([inline, toolExecution]) => {
      const warnings = [];

      if (inline.enabled && !inline.applied) {
        warnings.push("UI compat для native search недоступен; inline-патч пропущен");
      }
      if (toolExecution.enabled && !toolExecution.applied) {
        warnings.push("UI compat для native search недоступен; tool-render патч пропущен");
      }

      return { warnings };
    });
  }

  return Promise.all([
    startExperimentalProviderCompat(pi),
    uiCompatPromise,
  ]).then(([provider, ui]) => ({
    warnings: [...provider.warnings, ...ui.warnings],
  }));
}
