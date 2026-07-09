import { importPiRuntimeModule } from "../runtime/pi-runtime.js";
import {
  COMPAT_FEATURES,
  createCompatFeatureStatus,
} from "../runtime/pi-compat-capabilities.js";
import { formatWebSearchResult as formatInlineWebSearchResult } from "../../core/lifecycle/search-status.js";

const INLINE_SEARCH_PATCH_MARKER = Symbol.for("pi-openai-search.inline-search-order-patched");
const INLINE_SEARCH_RENDER_CONTEXT = Symbol.for("pi-openai-search.inline-search-render-context");
const INLINE_SEARCH_EXPANDED = Symbol.for("pi-openai-search.inline-search-expanded");

let interactiveSearchOrderPatchPromise;

/**
 * Загрузка interactive runtime для truthful search-order patch.
 *
 * @returns {Promise<{AssistantMessageComponent: any, ToolExecutionComponent: any, InteractiveMode: any, Spacer: any, Text: any, Markdown: any, theme: any}>} Runtime-модули.
 */
async function loadInteractiveSearchOrderRuntime() {
  try {
    const [assistantMessageModule, toolExecutionModule, interactiveModeModule, piTuiModule, themeModule] =
      await Promise.all([
        importPiRuntimeModule("dist/modes/interactive/components/assistant-message.js"),
        importPiRuntimeModule("dist/modes/interactive/components/tool-execution.js"),
        importPiRuntimeModule("dist/modes/interactive/interactive-mode.js"),
        importPiRuntimeModule("node_modules/@mariozechner/pi-tui/dist/index.js"),
        importPiRuntimeModule("dist/modes/interactive/theme/theme.js"),
      ]);

    return {
      AssistantMessageComponent: assistantMessageModule.AssistantMessageComponent,
      ToolExecutionComponent: toolExecutionModule.ToolExecutionComponent,
      InteractiveMode: interactiveModeModule.InteractiveMode,
      Spacer: piTuiModule.Spacer,
      Text: piTuiModule.Text,
      Markdown: piTuiModule.Markdown,
      theme: themeModule.theme,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Не удалось загрузить interactive search-order runtime: ${message}`);
  }
}

/**
 * Проверка target runtime на совместимость с patch.
 *
 * @param {any} AssistantMessageComponent Компонент assistant message.
 * @param {any} ToolExecutionComponent Компонент tool execution.
 * @param {any} InteractiveMode Interactive mode runtime.
 * @returns {void}
 */
export function assertInteractiveSearchOrderPatchTargets(AssistantMessageComponent, ToolExecutionComponent, InteractiveMode) {
  if (typeof AssistantMessageComponent !== "function") {
    throw new Error("Несовместимый interactive runtime: отсутствует AssistantMessageComponent.");
  }
  if (typeof AssistantMessageComponent.prototype?.updateContent !== "function") {
    throw new Error("Несовместимый interactive runtime: отсутствует AssistantMessageComponent.prototype.updateContent().");
  }
  if (typeof ToolExecutionComponent !== "function") {
    throw new Error("Несовместимый interactive runtime: отсутствует ToolExecutionComponent.");
  }
  if (typeof InteractiveMode !== "function") {
    throw new Error("Несовместимый interactive runtime: отсутствует InteractiveMode.");
  }
  if (typeof InteractiveMode.prototype?.addMessageToChat !== "function") {
    throw new Error("Несовместимый interactive runtime: отсутствует InteractiveMode.prototype.addMessageToChat().");
  }
  if (typeof InteractiveMode.prototype?.handleEvent !== "function") {
    throw new Error("Несовместимый interactive runtime: отсутствует InteractiveMode.prototype.handleEvent().");
  }
}

/**
 * Привязка runtime context к assistant component.
 *
 * @param {any} component Компонент assistant message.
 * @param {any} host Interactive mode host.
 * @returns {void}
 */
function attachInlineSearchRenderContext(component, host) {
  if (!component || !host) {
    return;
  }

  component[INLINE_SEARCH_RENDER_CONTEXT] = {
    ui: host.ui,
    formatWebSearchResult: typeof host.formatWebSearchResult === "function"
      ? host.formatWebSearchResult.bind(host)
      : formatInlineWebSearchResult,
    getShowImages: () => host.settingsManager?.getShowImages?.() ?? true,
    getCwd: () => host.sessionManager?.getCwd?.(),
  };

  if (typeof component.setExpanded === "function") {
    component.setExpanded(host.toolOutputExpanded);
  }
}

/**
 * Поиск результата для конкретного search tool use.
 *
 * @param {Array<any>} contentBlocks Полный assistant content.
 * @param {string} toolUseId ID search tool use.
 * @returns {any} Найденный result block или undefined.
 */
function findWebSearchResultBlock(contentBlocks, toolUseId) {
  return contentBlocks.find((block) => block?.type === "webSearchResult" && block.toolUseId === toolUseId);
}

/**
 * Проверка наличия видимого текстового/think блока.
 *
 * @param {Array<any>} contentBlocks Assistant content.
 * @returns {boolean} Есть ли видимый текст или thinking.
 */
function hasVisibleTextualContent(contentBlocks) {
  return contentBlocks.some(
    (content) =>
      (content?.type === "text" && String(content.text || "").trim()) ||
      (content?.type === "thinking" && String(content.thinking || "").trim()),
  );
}

/**
 * Проверка видимого текстового/think блока после текущего индекса.
 *
 * @param {Array<any>} contentBlocks Assistant content.
 * @param {number} index Текущий индекс.
 * @returns {boolean} Есть ли дальше видимый текст или thinking.
 */
function hasVisibleTextualContentAfter(contentBlocks, index) {
  return contentBlocks
    .slice(index + 1)
    .some(
      (content) =>
        (content?.type === "text" && String(content.text || "").trim()) ||
        (content?.type === "thinking" && String(content.thinking || "").trim()),
    );
}

/**
 * Построение inline web_search tool component внутри assistant message.
 *
 * @param {any} assistantComponent Экземпляр assistant component.
 * @param {any} ToolExecutionComponent Компонент tool execution.
 * @param {any} content Блок serverToolUse.
 * @param {any} message Полное assistant message.
 * @param {any} resultBlock Связанный webSearchResult.
 * @returns {any} Готовый component.
 */
function buildInlineWebSearchComponent(assistantComponent, ToolExecutionComponent, content, message, resultBlock) {
  const renderContext = assistantComponent[INLINE_SEARCH_RENDER_CONTEXT] || {};
  const ui = renderContext.ui || { requestRender() {} };
  const showImages = renderContext.getShowImages ? renderContext.getShowImages() : true;
  const component = new ToolExecutionComponent(
    content.name,
    content.id,
    content.input ?? {},
    { showImages },
    undefined,
    ui,
    renderContext.getCwd?.(),
  );

  component.setExpanded(Boolean(assistantComponent[INLINE_SEARCH_EXPANDED]));

  if (!resultBlock) {
    if (message?.stopReason === "aborted" || message?.stopReason === "error") {
      const errorText =
        message.stopReason === "aborted"
          ? message.errorMessage && message.errorMessage !== "Request was aborted"
            ? message.errorMessage
            : "Operation aborted"
          : message.errorMessage || "Error";
      component.updateResult({
        content: [{ type: "text", text: errorText }],
        isError: true,
      });
    }
    return component;
  }

  if (process.env.PI_OFFLINE === "1") {
    component.updateResult({
      content: [{ type: "text", text: "Web search disabled (offline mode)" }],
      isError: false,
    });
    return component;
  }

  const searchContent = resultBlock.content;
  const isError =
    searchContent &&
    typeof searchContent === "object" &&
    "type" in searchContent &&
    searchContent.type === "web_search_tool_result_error";
  const formatWebSearchResult =
    typeof renderContext.formatWebSearchResult === "function"
      ? renderContext.formatWebSearchResult
      : formatInlineWebSearchResult;

  component.updateResult({
    content: [{ type: "text", text: formatWebSearchResult(searchContent) }],
    isError: !!isError,
  });
  return component;
}

/**
 * Кастомный inline render native search внутри AssistantMessageComponent.
 *
 * @param {any} component Экземпляр AssistantMessageComponent.
 * @param {any} message Assistant message.
 * @param {{Spacer: any, Text: any, Markdown: any, theme: any, ToolExecutionComponent: any}} runtime Runtime helpers.
 * @returns {void}
 */
function updateAssistantContentWithInlineSearch(component, message, runtime) {
  component.lastMessage = message;
  component.contentContainer.clear();

  const contentBlocks = Array.isArray(message?.content) ? message.content : [];
  const hasVisibleContent = hasVisibleTextualContent(contentBlocks);

  if (hasVisibleContent) {
    component.contentContainer.addChild(new runtime.Spacer(1));
  }

  for (let i = 0; i < contentBlocks.length; i++) {
    const content = contentBlocks[i];

    if (content?.type === "text" && String(content.text || "").trim()) {
      component.contentContainer.addChild(
        new runtime.Markdown(String(content.text || "").trim(), 1, 0, component.markdownTheme),
      );
      continue;
    }

    if (content?.type === "thinking" && String(content.thinking || "").trim()) {
      const hasVisibleContentAfter = hasVisibleTextualContentAfter(contentBlocks, i);
      if (component.hideThinkingBlock) {
        component.contentContainer.addChild(
          new runtime.Text(runtime.theme.italic(runtime.theme.fg("thinkingText", "Thinking...")), 1, 0),
        );
      } else {
        component.contentContainer.addChild(
          new runtime.Markdown(String(content.thinking || "").trim(), 1, 0, component.markdownTheme, {
            color: (text) => runtime.theme.fg("thinkingText", text),
            italic: true,
          }),
        );
      }

      if (hasVisibleContentAfter) {
        component.contentContainer.addChild(new runtime.Spacer(1));
      }
      continue;
    }

    if (content?.type === "serverToolUse" && content.name === "web_search" && content.id) {
      const resultBlock = findWebSearchResultBlock(contentBlocks, content.id);
      component.contentContainer.addChild(
        buildInlineWebSearchComponent(component, runtime.ToolExecutionComponent, content, message, resultBlock),
      );
    }
  }

  const hasInlineTools = contentBlocks.some(
    (content) => content?.type === "toolCall" || (content?.type === "serverToolUse" && content.name === "web_search"),
  );

  if (!hasInlineTools) {
    if (message.stopReason === "aborted") {
      const abortMessage =
        message.errorMessage && message.errorMessage !== "Request was aborted"
          ? message.errorMessage
          : "Operation aborted";
      if (hasVisibleContent) {
        component.contentContainer.addChild(new runtime.Spacer(1));
      }
      component.contentContainer.addChild(new runtime.Text(runtime.theme.fg("error", abortMessage), 1, 0));
    } else if (message.stopReason === "error") {
      const errorMsg = message.errorMessage || "Unknown error";
      component.contentContainer.addChild(new runtime.Spacer(1));
      component.contentContainer.addChild(new runtime.Text(runtime.theme.fg("error", `Error: ${errorMsg}`), 1, 0));
    }
  }

  if (message.stopReason && message.timestamp) {
    const timeStr = runtime.formatTimestamp
      ? runtime.formatTimestamp(message.timestamp, component.timestampFormat)
      : String(message.timestamp);
    component.contentContainer.addChild(new runtime.Text(runtime.theme.fg("dim", timeStr), 1, 0));
  }
}

/**
 * Применение inline search-order patch к interactive runtime.
 *
 * @param {any} AssistantMessageComponent Компонент assistant message.
 * @param {any} ToolExecutionComponent Компонент tool execution.
 * @param {any} InteractiveMode Interactive mode runtime.
 * @param {{Spacer: any, Text: any, Markdown: any, theme: any, formatTimestamp?: Function}} runtime Runtime helpers.
 * @returns {void}
 */
export function applyInteractiveSearchOrderPatch(
  AssistantMessageComponent,
  ToolExecutionComponent,
  InteractiveMode,
  runtime,
) {
  assertInteractiveSearchOrderPatchTargets(AssistantMessageComponent, ToolExecutionComponent, InteractiveMode);

  if (AssistantMessageComponent.prototype[INLINE_SEARCH_PATCH_MARKER]) {
    return;
  }

  const originalAssistantUpdateContent = AssistantMessageComponent.prototype.updateContent;
  AssistantMessageComponent.prototype.updateContent = function patchedAssistantUpdateContent(message) {
    const hasInlineSearch = Array.isArray(message?.content)
      ? message.content.some((content) => content?.type === "serverToolUse" && content.name === "web_search")
      : false;

    if (!hasInlineSearch) {
      return originalAssistantUpdateContent.call(this, message);
    }

    return updateAssistantContentWithInlineSearch(this, message, {
      ...runtime,
      ToolExecutionComponent,
    });
  };

  AssistantMessageComponent.prototype.setExpanded = function setExpanded(expanded) {
    this[INLINE_SEARCH_EXPANDED] = expanded;
    this.invalidate();
  };

  const originalAddMessageToChat = InteractiveMode.prototype.addMessageToChat;
  InteractiveMode.prototype.addMessageToChat = function patchedAddMessageToChat(message, options) {
    const beforeChildren = this.chatContainer.children.length;
    const result = originalAddMessageToChat.call(this, message, options);

    if (message?.role === "assistant") {
      const assistantComponent = this.chatContainer.children[beforeChildren];
      attachInlineSearchRenderContext(assistantComponent, this);
      assistantComponent?.invalidate?.();
    }

    return result;
  };

  const originalHandleEvent = InteractiveMode.prototype.handleEvent;
  InteractiveMode.prototype.handleEvent = async function patchedHandleEvent(event) {
    if (event?.type === "message_update" && this.streamingComponent && event.message?.role === "assistant") {
      this.streamingMessage = event.message;
      attachInlineSearchRenderContext(this.streamingComponent, this);
      this.streamingComponent.updateContent(this.streamingMessage);

      const contentBlocks = this.streamingMessage.content;
      for (const content of contentBlocks) {
        if (content.type === "toolCall") {
          if (!this.pendingTools.has(content.id)) {
            const component = new ToolExecutionComponent(
              content.name,
              content.id,
              content.arguments,
              {
                showImages: this.settingsManager.getShowImages(),
                imageWidthCells: this.settingsManager.getImageWidthCells(),
              },
              this.getRegisteredToolDefinition(content.name),
              this.ui,
              this.sessionManager.getCwd(),
            );
            component.setExpanded(this.toolOutputExpanded);
            this.chatContainer.addChild(component);
            this.pendingTools.set(content.id, component);
          } else {
            this.pendingTools.get(content.id)?.updateArgs(content.arguments);
          }
        }
      }

      this.ui.requestRender();
      return;
    }

    const result = await originalHandleEvent.call(this, event);

    if (event?.type === "message_start" && event.message?.role === "assistant" && this.streamingComponent) {
      attachInlineSearchRenderContext(this.streamingComponent, this);
      this.streamingComponent.invalidate();
    }

    return result;
  };

  AssistantMessageComponent.prototype[INLINE_SEARCH_PATCH_MARKER] = true;
}

/**
 * Регистрация interactive patch для хронологического inline native search.
 *
 * @returns {Promise<void>} Promise регистрации patch.
 */
/**
 * Capability probe для inline interactive compat.
 *
 * @returns {Promise<{feature: string, enabled: boolean, status: string, supported: boolean, reason?: string, diagnostics: string[]}>} Статус compat-фичи.
 */
export async function probeInteractiveSearchOrderPatchCapability() {
  try {
    const runtime = await loadInteractiveSearchOrderRuntime();
    assertInteractiveSearchOrderPatchTargets(
      runtime.AssistantMessageComponent,
      runtime.ToolExecutionComponent,
      runtime.InteractiveMode,
    );
    return createCompatFeatureStatus(COMPAT_FEATURES.interactiveInline, {
      supported: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createCompatFeatureStatus(COMPAT_FEATURES.interactiveInline, {
      supported: false,
      reason: "UI compat для native search недоступен; inline-патч пропущен",
      diagnostics: [message],
    });
  }
}

export async function registerInteractiveSearchOrderPatch() {
  if (!interactiveSearchOrderPatchPromise) {
    interactiveSearchOrderPatchPromise = loadInteractiveSearchOrderRuntime()
      .then((runtime) => {
        applyInteractiveSearchOrderPatch(
          runtime.AssistantMessageComponent,
          runtime.ToolExecutionComponent,
          runtime.InteractiveMode,
          runtime,
        );
        return true;
      })
      .catch((error) => {
        interactiveSearchOrderPatchPromise = undefined;
        throw error;
      });
  }

  await interactiveSearchOrderPatchPromise;
}
