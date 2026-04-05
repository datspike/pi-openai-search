import { registerApiProvider } from "./pi-ai-compat.js";
import { streamPatchedOpenAIResponses, streamSimplePatchedOpenAIResponses } from "./openai-responses-stream.js";

let providerRegistered = false;

/**
 * Конфиг provider registration для session-safe extension pipeline.
 *
 * @returns {{api: string, streamSimple: Function}} Конфиг для `pi.registerProvider()`.
 */
export function buildPatchedOpenAIResponsesProviderConfig() {
  return {
    api: "openai-responses",
    streamSimple: streamSimplePatchedOpenAIResponses,
  };
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
