import {
  COMPAT_FEATURES,
  createCompatFeatureStatus,
} from "../runtime/pi-compat-capabilities.js";
import * as piAiCompat from "../runtime/pi-ai-compat.js";
import { loadOpenAIResponsesInternals } from "./openai-responses-client.js";
import {
  setProviderCompatReadiness,
  streamPatchedOpenAIResponses,
  streamSimplePatchedOpenAIResponses,
} from "./openai-responses-stream.js";

export { setProviderCompatReadiness };

let providerRegistered = false;
const publicProviderRuntimes = new WeakSet();

function validateOpenAIResponsesInternals(internals) {
  return typeof internals?.convertResponsesMessages === "function"
    && typeof internals?.convertResponsesTools === "function"
    && typeof internals?.OpenAI === "function";
}

async function probeOpenAIResponsesInternals(loadInternals = loadOpenAIResponsesInternals) {
  try {
    const internals = await loadInternals();
    if (!validateOpenAIResponsesInternals(internals)) {
      return {
        ok: false,
        reason: "OpenAI Responses internals недоступны; provider compat не активирован",
        diagnostic: "loadOpenAIResponsesInternals вернул неполный набор зависимостей.",
      };
    }
    return { ok: true };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: "OpenAI Responses internals недоступны; provider compat не активирован",
      diagnostic,
    };
  }
}

function resolvePiAiCompat(options = {}) {
  return options.piAiCompat || piAiCompat;
}

function probePiAiProviderCompat(compat = piAiCompat) {
  if (compat.supportsPiAiProviderCompat?.() === true || compat.hasPiAiProviderCompat === true) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "pi-ai compat для provider stream недоступен; provider compat не активирован",
    diagnostic: "Нужны AssistantMessageEventStream, getEnvApiKey и supportsXhigh из pi-ai compat.",
  };
}

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
export async function probeProviderCompatCapability(pi, options = {}) {
  const internalsProbe = await probeOpenAIResponsesInternals(options.loadOpenAIResponsesInternals);
  if (!internalsProbe.ok) {
    return createCompatFeatureStatus(COMPAT_FEATURES.providerCompat, {
      supported: false,
      reason: internalsProbe.reason,
      diagnostics: [internalsProbe.diagnostic],
    });
  }

  const compatProbe = probePiAiProviderCompat(resolvePiAiCompat(options));
  if (!compatProbe.ok) {
    return createCompatFeatureStatus(COMPAT_FEATURES.providerCompat, {
      supported: false,
      reason: compatProbe.reason,
      diagnostics: [compatProbe.diagnostic],
    });
  }

  const compat = resolvePiAiCompat(options);
  if (typeof pi?.registerProvider === "function") {
    return createCompatFeatureStatus(COMPAT_FEATURES.providerCompat, {
      supported: true,
    });
  }

  if (typeof compat.registerApiProvider === "function") {
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
 * @returns {boolean} true, если private patch зарегистрирован или уже был активен.
 */
export function registerOpenAIResponsesDisplayPatch(compat = piAiCompat) {
  if (providerRegistered) {
    return true;
  }
  if (typeof compat.registerApiProvider !== "function") {
    return false;
  }

  compat.registerApiProvider(
    {
      api: "openai-responses",
      stream: streamPatchedOpenAIResponses,
      streamSimple: streamSimplePatchedOpenAIResponses,
    },
    "pi-openai-search",
  );
  providerRegistered = true;
  return true;
}

/**
 * Активация provider compat по capability summary.
 *
 * @param {any} pi Экземпляр pi runtime.
 * @param {{features?: Record<string, {supported?: boolean}>}} capabilitySummary Capability summary.
 * @returns {Promise<boolean>} true, если активация выполнена.
 */
export async function activateProviderCompat(pi, capabilitySummary, options = {}) {
  const feature = capabilitySummary?.features?.[COMPAT_FEATURES.providerCompat];
  if (!feature?.supported) {
    return false;
  }

  const internalsProbe = await probeOpenAIResponsesInternals(options.loadOpenAIResponsesInternals);
  if (!internalsProbe.ok) {
    return false;
  }

  const compat = resolvePiAiCompat(options);
  if (!probePiAiProviderCompat(compat).ok) {
    return false;
  }

  // `registerProvider` is the documented backend path. Private registration is
  // a capability-gated fallback only; it must never be required for a request.
  if (typeof pi?.registerProvider === "function") {
    if (!publicProviderRuntimes.has(pi)) {
      pi.registerProvider("openai", buildPatchedOpenAIResponsesProviderConfig());
      publicProviderRuntimes.add(pi);
    }
    return true;
  }

  return registerOpenAIResponsesDisplayPatch(compat);
}
