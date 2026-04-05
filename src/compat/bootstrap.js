import {
  probeInteractiveSearchOrderPatchCapability,
  registerInteractiveSearchOrderPatch,
} from "./interactive/search-order-patch.js";
import {
  probeTruthfulInteractiveWebSearchPatchCapability,
  registerTruthfulInteractiveWebSearchPatch,
} from "./interactive/tool-execution-web-search-patch.js";
import {
  activateProviderCompat,
  probeProviderCompatCapability,
} from "./provider/openai-responses-provider.js";
import { COMPAT_FEATURES } from "./runtime/pi-compat-capabilities.js";
import { probePiCompatCapabilities } from "./runtime/pi-runtime.js";

let compatBootstrapPromise;
let compatActivationPromise;
let cachedCompatSummary;

/**
 * Сброс compat bootstrap cache.
 *
 * @returns {void}
 */
export function resetCompatBootstrapCache() {
  compatBootstrapPromise = undefined;
  compatActivationPromise = undefined;
  cachedCompatSummary = undefined;
}

/**
 * Активация compat-фич по capability summary.
 *
 * @param {any} pi Экземпляр pi runtime.
 * @param {{features: Record<string, {supported?: boolean}>}} capabilitySummary Capability summary.
 * @returns {Promise<{appliedFeatures: string[], warnings: string[]}>} Результат активации.
 */
export async function activateCompatFeatures(pi, capabilitySummary) {
  if (compatActivationPromise) {
    return compatActivationPromise;
  }

  compatActivationPromise = (async () => {
    const appliedFeatures = [];

    if (capabilitySummary?.features?.[COMPAT_FEATURES.providerCompat]?.supported) {
      const applied = await activateProviderCompat(pi, capabilitySummary);
      if (applied) {
        appliedFeatures.push(COMPAT_FEATURES.providerCompat);
      }
    }

    if (capabilitySummary?.features?.[COMPAT_FEATURES.interactiveInline]?.supported) {
      await registerInteractiveSearchOrderPatch();
      appliedFeatures.push(COMPAT_FEATURES.interactiveInline);
    }

    if (capabilitySummary?.features?.[COMPAT_FEATURES.toolRender]?.supported) {
      await registerTruthfulInteractiveWebSearchPatch();
      appliedFeatures.push(COMPAT_FEATURES.toolRender);
    }

    const warnings = Object.values(capabilitySummary?.features || {})
      .filter((feature) => feature?.enabled && !feature?.supported)
      .map((feature) => feature.reason)
      .filter(Boolean);

    return {
      appliedFeatures,
      warnings,
    };
  })().catch((error) => {
    compatActivationPromise = undefined;
    throw error;
  });

  return compatActivationPromise;
}

/**
 * Ранний одноразовый bootstrap compat runtime.
 *
 * @param {any} pi Экземпляр pi runtime.
 * @returns {Promise<{runtime: any, features: Record<string, any>, warnings: string[], diagnostics: string[], status: string, activation: {appliedFeatures: string[], warnings: string[]}}>} Compat summary.
 */
export function bootstrapCompatRuntime(pi) {
  if (!compatBootstrapPromise) {
    compatBootstrapPromise = (async () => {
      const capabilitySummary = await probePiCompatCapabilities(pi, {
        probeProviderCompat: probeProviderCompatCapability,
        probeInteractiveInlineCompat: probeInteractiveSearchOrderPatchCapability,
        probeToolRenderCompat: probeTruthfulInteractiveWebSearchPatchCapability,
      });
      const activation = await activateCompatFeatures(pi, capabilitySummary);
      cachedCompatSummary = {
        ...capabilitySummary,
        activation,
      };
      return cachedCompatSummary;
    })().catch((error) => {
      compatBootstrapPromise = undefined;
      throw error;
    });
  }

  return compatBootstrapPromise;
}

/**
 * Пользовательские warning для активной модели.
 *
 * @param {any} model Выбранная модель.
 * @param {{warnings?: string[]}} capabilitySummary Compat summary.
 * @returns {string[]} User-facing warnings.
 */
export function getCompatWarningsForModel(model, capabilitySummary) {
  if (!model) {
    return [];
  }

  return Array.isArray(capabilitySummary?.warnings) ? capabilitySummary.warnings : [];
}

/**
 * Получение кешированного compat summary.
 *
 * @returns {any} Последний compat summary.
 */
export function getCachedCompatSummary() {
  return cachedCompatSummary;
}
