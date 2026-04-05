import {
  COMPAT_FEATURES,
  createCompatFeatureStatus,
} from "../runtime/pi-compat-capabilities.js";
import { registerApiProvider } from "../runtime/pi-ai-compat.js";
import { streamPatchedOpenAIResponses, streamSimplePatchedOpenAIResponses } from "./openai-responses-stream.js";

let providerRegistered = false;

/**
 * Конфиг provider registration для session-safe extension pipeline.
 *
 * @returns {{api: string, marker: string, stream: Function, streamSimple: Function}} Конфиг для `pi.registerProvider()`.
 */
export function buildPatchedOpenAIResponsesProviderConfig() {
  return {
    api: "openai-responses",
    marker: "experimental-provider-compat",
    stream: streamPatchedOpenAIResponses,
    streamSimple: streamSimplePatchedOpenAIResponses,
  };
}

/**
 * Capability probe для provider compat.
 *
 * @param {any} pi Экземпляр pi runtime.
 * @returns {Promise<{feature: string, enabled: boolean, status: string, supported: boolean, reason?: string, diagnostics: string[]}>} Статус compat-фичи.
 */
export async function probeProviderCompatCapability(pi) {
  if (typeof pi?.registerProvider === "function") {
    return createCompatFeatureStatus(COMPAT_FEATURES.providerCompat, {
      supported: true,
    });
  }

  if (typeof registerApiProvider === "function") {
    return createCompatFeatureStatus(COMPAT_FEATURES.providerCompat, {
      supported: true,
      status: "partial",
      diagnostics: ["Используется private registerApiProvider fallback для provider compat."],
    });
  }

  return createCompatFeatureStatus(COMPAT_FEATURES.providerCompat, {
    supported: false,
    reason: "Provider compat для native search недоступен; truthful search blocks отключены",
  });
}

/**
 * Регистрация patched provider поверх встроенного openai-responses.
 *
 * @returns {void}
 */
export function registerOpenAIResponsesDisplayPatch() {
  if (providerRegistered) {
    return;
  }

  registerApiProvider(
    {
      api: "openai-responses",
      stream: streamPatchedOpenAIResponses,
      streamSimple: streamSimplePatchedOpenAIResponses,
    },
    "pi-openai-search",
  );
  providerRegistered = true;
}

/**
 * Активация provider compat по capability summary.
 *
 * @param {any} pi Экземпляр pi runtime.
 * @param {{features?: Record<string, {supported?: boolean}>}} capabilitySummary Capability summary.
 * @returns {Promise<boolean>} true, если активация выполнена.
 */
export async function activateProviderCompat(pi, capabilitySummary) {
  const feature = capabilitySummary?.features?.[COMPAT_FEATURES.providerCompat];
  if (!feature?.supported) {
    return false;
  }

  // session/runtime patching нужен даже когда публичный provider override доступен
  registerOpenAIResponsesDisplayPatch();

  if (typeof pi?.registerProvider === "function") {
    pi.registerProvider("openai", buildPatchedOpenAIResponsesProviderConfig());
  }

  return true;
}
