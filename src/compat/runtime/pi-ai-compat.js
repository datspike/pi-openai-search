import { importPiRuntimeModule } from "./pi-runtime.js";

const piAiModule = await importPiRuntimeModule("node_modules/@mariozechner/pi-ai/dist/index.js");

export const {
  AssistantMessageEventStream,
  getEnvApiKey,
  registerApiProvider,
  supportsXhigh,
} = piAiModule;
