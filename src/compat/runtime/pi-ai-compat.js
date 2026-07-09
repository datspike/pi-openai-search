import { importPiRuntimeModule } from "./pi-runtime.js";

let piAiModule = {};

try {
  piAiModule = await importPiRuntimeModule("node_modules/@mariozechner/pi-ai/dist/index.js");
} catch {
  piAiModule = {};
}

const FailingAssistantMessageEventStream = class AssistantMessageEventStream {
  /**
   * Заглушка для несовместимого runtime.
   */
  constructor() {
    throw new Error("Compat runtime pi-ai недоступен.");
  }
};

export const hasPiAiProviderCompat =
  typeof piAiModule.AssistantMessageEventStream === "function"
  && typeof piAiModule.getEnvApiKey === "function";

export function supportsPiAiProviderCompat() {
  return hasPiAiProviderCompat;
}

export const AssistantMessageEventStream =
  typeof piAiModule.AssistantMessageEventStream === "function"
    ? piAiModule.AssistantMessageEventStream
    : FailingAssistantMessageEventStream;

export const getEnvApiKey =
  typeof piAiModule.getEnvApiKey === "function"
    ? piAiModule.getEnvApiKey
    : (() => undefined);

export const registerApiProvider =
  typeof piAiModule.registerApiProvider === "function"
    ? piAiModule.registerApiProvider
    : undefined;

export const supportsXhigh =
  typeof piAiModule.supportsXhigh === "function"
    ? piAiModule.supportsXhigh
    : (() => false);
