/**
 * Загрузка совместимого pi-ai пакета для standalone pi и legacy gsd runtime.
 *
 * @returns {Promise<any>} Экспортированный модуль pi-ai.
 */
async function loadPiAiModule() {
  try {
    return await import("@mariozechner/pi-ai");
  } catch (piError) {
    try {
      return await import("@gsd/pi-ai");
    } catch (gsdError) {
      const piReason = piError instanceof Error ? piError.message : String(piError);
      const gsdReason = gsdError instanceof Error ? gsdError.message : String(gsdError);
      throw new Error(`Не удалось загрузить pi-ai compat module. pi: ${piReason}; gsd: ${gsdReason}`);
    }
  }
}

const piAiModule = await loadPiAiModule();

export const {
  AssistantMessageEventStream,
  getEnvApiKey,
  registerApiProvider,
  supportsXhigh,
} = piAiModule;
