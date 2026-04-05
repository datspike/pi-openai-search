import {
  formatTruthfulWebSearchDoneLabel,
  formatTruthfulWebSearchPendingLabel,
} from "./openai-search-display.js";
import { importGsdPiModule } from "./gsd-pi-compat.js";

const WEB_SEARCH_PATCH_MARKER = Symbol.for("pi-openai-search.web-search-tool-execution-patched");

let toolExecutionPatchPromise;

/**
 * Загрузка зависимостей interactive tool-execution runtime.
 *
 * @returns {Promise<{ToolExecutionComponent: any, keyHint: Function, theme: any}>} Набор runtime-модулей.
 */
async function loadInteractiveToolExecutionRuntime() {
  try {
    const [toolExecutionModule, keybindingHintsModule, themeModule] = await Promise.all([
      importGsdPiModule("packages/pi-coding-agent/dist/modes/interactive/components/tool-execution.js"),
      importGsdPiModule("packages/pi-coding-agent/dist/modes/interactive/components/keybinding-hints.js"),
      importGsdPiModule("packages/pi-coding-agent/dist/modes/interactive/theme/theme.js"),
    ]);

    return {
      ToolExecutionComponent: toolExecutionModule.ToolExecutionComponent,
      keyHint: keybindingHintsModule.keyHint,
      theme: themeModule.theme,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Не удалось загрузить interactive tool-execution runtime: ${message}`);
  }
}

/**
 * Проверка совместимости patch target.
 *
 * @param {any} ToolExecutionComponent Экспортированный компонент.
 * @returns {void}
 */
function assertPatchTarget(ToolExecutionComponent) {
  if (typeof ToolExecutionComponent !== "function") {
    throw new Error("Несовместимый interactive tool-execution runtime: отсутствует export ToolExecutionComponent.");
  }

  if (typeof ToolExecutionComponent.prototype?.formatToolExecution !== "function") {
    throw new Error(
      "Несовместимый interactive tool-execution runtime: отсутствует ToolExecutionComponent.prototype.formatToolExecution().",
    );
  }

  if (typeof ToolExecutionComponent.prototype?.getTextOutput !== "function") {
    throw new Error(
      "Несовместимый interactive tool-execution runtime: отсутствует ToolExecutionComponent.prototype.getTextOutput().",
    );
  }
}

/**
 * Truthful rendering одного interactive web_search блока.
 *
 * @param {any} component Экземпляр ToolExecutionComponent.
 * @param {{theme: any, keyHint: Function}} runtime Runtime helpers из gsd-pi.
 * @returns {string} Итоговый текст блока.
 */
function formatTruthfulInteractiveWebSearch(component, runtime) {
  const title = component.result
    ? formatTruthfulWebSearchDoneLabel(component.args)
    : formatTruthfulWebSearchPendingLabel(component.args);

  let text = runtime.theme.fg("toolTitle", runtime.theme.bold(title));

  if (process.env.PI_OFFLINE === "1") {
    text += "\n\n" + runtime.theme.fg("muted", "Offline - web search unavailable");
    return text;
  }

  if (!component.result) {
    return text;
  }

  const output = component.getTextOutput().trim();
  if (!output) {
    return text;
  }

  const lines = output.split("\n");
  const maxLines = component.expanded ? lines.length : 10;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;

  text += `\n\n${displayLines.map((line) => runtime.theme.fg("toolOutput", line)).join("\n")}`;
  if (remaining > 0) {
    text += `${runtime.theme.fg("muted", `\n... (${remaining} more lines,`)} ${runtime.keyHint("expandTools", "to expand")})`;
  }

  return text;
}

/**
 * Применение truthful patch к прототипу interactive ToolExecutionComponent.
 *
 * @param {any} ToolExecutionComponent Экспортированный компонент.
 * @param {{theme: any, keyHint: Function}} runtime Runtime helpers из gsd-pi.
 * @returns {void}
 */
export function applyTruthfulInteractiveWebSearchPatch(ToolExecutionComponent, runtime) {
  assertPatchTarget(ToolExecutionComponent);

  if (ToolExecutionComponent.prototype[WEB_SEARCH_PATCH_MARKER]) {
    return;
  }

  const originalFormatToolExecution = ToolExecutionComponent.prototype.formatToolExecution;
  ToolExecutionComponent.prototype.formatToolExecution = function patchedFormatToolExecution(...args) {
    if (this?.toolName === "web_search") {
      return formatTruthfulInteractiveWebSearch(this, runtime);
    }

    return originalFormatToolExecution.apply(this, args);
  };
  ToolExecutionComponent.prototype[WEB_SEARCH_PATCH_MARKER] = true;
}

/**
 * Регистрация truthful formatter для interactive web_search.
 *
 * @returns {Promise<void>} Promise регистрации patch.
 */
export async function registerTruthfulInteractiveWebSearchPatch() {
  if (!toolExecutionPatchPromise) {
    toolExecutionPatchPromise = loadInteractiveToolExecutionRuntime()
      .then((runtime) => {
        applyTruthfulInteractiveWebSearchPatch(runtime.ToolExecutionComponent, runtime);
        return true;
      })
      .catch((error) => {
        toolExecutionPatchPromise = undefined;
        throw error;
      });
  }

  await toolExecutionPatchPromise;
}
