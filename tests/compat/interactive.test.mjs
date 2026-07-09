import test from "node:test";
import assert from "node:assert/strict";

import {
  applyInteractiveSearchOrderPatch,
  assertInteractiveSearchOrderPatchTargets,
  probeInteractiveSearchOrderPatchCapability,
} from "../../src/compat/interactive/search-order-patch.js";
import {
  formatTruthfulWebSearchDoneLabel,
  formatTruthfulWebSearchPendingLabel,
} from "../../src/core/lifecycle/search-status.js";
import {
  applyTruthfulInteractiveWebSearchPatch,
  probeTruthfulInteractiveWebSearchPatchCapability,
} from "../../src/compat/interactive/tool-execution-web-search-patch.js";
import { resetPiRuntimeCache } from "../../src/compat/runtime/pi-runtime.js";

test("interactive compat rejects incompatible inline runtime shape", () => {
  assert.throws(
    () => applyInteractiveSearchOrderPatch(undefined, undefined, undefined, {}),
    /AssistantMessageComponent|runtime/i,
  );
});

test("interactive compat rejects incompatible tool-execution runtime shape", () => {
  assert.throws(
    () => applyTruthfulInteractiveWebSearchPatch(undefined, {}),
    /ToolExecutionComponent|runtime/i,
  );
});

test("interactive inline current runtime supports streaming and addMessageToChat replay", async () => {
  class MockContainer {
    constructor() {
      this.children = [];
    }

    addChild(child) {
      this.children.push(child);
    }

    clear() {
      this.children = [];
    }
  }

  class MockMarkdown {
    constructor(text) {
      this.kind = "markdown";
      this.text = text;
    }
  }

  class MockText {
    constructor(text) {
      this.kind = "text";
      this.text = text;
    }
  }

  class MockSpacer {
    constructor() {
      this.kind = "spacer";
    }
  }

  class MockAssistantMessageComponent {
    constructor(message) {
      this.contentContainer = new MockContainer();
      if (message) {
        this.updateContent(message);
      }
    }

    updateContent(message) {
      this.lastMessage = message;
      this.contentContainer.clear();
      this.contentContainer.addChild({ kind: "fallback", message });
    }

    invalidate() {
      if (this.lastMessage) {
        this.updateContent(this.lastMessage);
      }
    }
  }

  class MockToolExecutionComponent {
    constructor(toolName, toolCallId, args, options) {
      this.kind = "tool";
      this.toolName = toolName;
      this.toolCallId = toolCallId;
      this.args = args;
      this.options = options;
    }

    setExpanded(expanded) {
      this.expanded = expanded;
    }

    updateResult(result) {
      this.result = result;
    }

    formatToolExecution() {
      return this.result
        ? formatTruthfulWebSearchDoneLabel(this.args)
        : formatTruthfulWebSearchPendingLabel(this.args);
    }
  }

  class MockInteractiveMode {
    constructor() {
      this.ui = { requestRender() {} };
      this.chatContainer = new MockContainer();
      this.pendingTools = new Map();
      this.toolOutputExpanded = false;
      this.settingsManager = {
        getShowImages: () => true,
        getImageWidthCells: () => 17,
      };
      this.sessionManager = { getCwd: () => process.cwd() };
    }

    getRegisteredToolDefinition() {
      return undefined;
    }

    addMessageToChat(message) {
      if (message.role === "assistant") {
        this.chatContainer.addChild(new MockAssistantMessageComponent(message));
      }
    }

    async handleEvent(event) {
      if (event.type === "message_start") {
        this.streamingMessage = event.message;
        this.streamingComponent = new MockAssistantMessageComponent(event.message);
        this.chatContainer.addChild(this.streamingComponent);
      }
    }
  }

  const runtime = {
    Spacer: MockSpacer,
    Text: MockText,
    Markdown: MockMarkdown,
    theme: { fg: (_name, text) => text, italic: (text) => text },
  };

  assert.doesNotThrow(() =>
    assertInteractiveSearchOrderPatchTargets(
      MockAssistantMessageComponent,
      MockToolExecutionComponent,
      MockInteractiveMode,
    ),
  );
  assert.doesNotThrow(() =>
    applyInteractiveSearchOrderPatch(
      MockAssistantMessageComponent,
      MockToolExecutionComponent,
      MockInteractiveMode,
      runtime,
    ),
  );

  const host = new MockInteractiveMode();
  await host.handleEvent({ type: "message_start", message: { role: "assistant", content: [] } });
  await host.handleEvent({
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "serverToolUse", id: "ws_1", name: "web_search", input: { query: "latest django version" } },
      ],
    },
  });

  const pendingTool = host.streamingComponent.contentContainer.children.find((child) => child.kind === "tool");
  assert.equal(pendingTool.formatToolExecution(), "Searching the web: latest django version");

  await host.handleEvent({
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "serverToolUse", id: "ws_1", name: "web_search", input: { query: "latest django version" } },
        { type: "webSearchResult", toolUseId: "ws_1", content: { type: "web_search_tool_result_complete" } },
      ],
    },
  });

  const doneTool = host.streamingComponent.contentContainer.children.find((child) => child.kind === "tool");
  assert.equal(doneTool.formatToolExecution(), "Searched latest django version");

  const replayHost = new MockInteractiveMode();
  replayHost.addMessageToChat(host.streamingMessage);

  const replayAssistant = replayHost.chatContainer.children[0];
  const replayTool = replayAssistant.contentContainer.children.find((child) => child.kind === "tool");
  assert.equal(replayTool.formatToolExecution(), "Searched latest django version");

  await host.handleEvent({
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tool_1", name: "read", arguments: { path: "README.md" } },
      ],
    },
  });
  assert.deepEqual(host.pendingTools.get("tool_1").options, {
    showImages: true,
    imageWidthCells: 17,
  });
});

test("interactive inline probe returns structured unavailability reason on mismatch", async () => {
  const originalPiBinPath = process.env.PI_BIN_PATH;
  process.env.PI_BIN_PATH = "/definitely/missing/pi";
  resetPiRuntimeCache();

  try {
    const result = await probeInteractiveSearchOrderPatchCapability();
    assert.equal(result.supported, false);
    assert.match(result.reason, /inline-патч пропущен/);
    assert.ok(result.diagnostics.length >= 1);
  } finally {
    resetPiRuntimeCache();
    if (originalPiBinPath == null) {
      delete process.env.PI_BIN_PATH;
    } else {
      process.env.PI_BIN_PATH = originalPiBinPath;
    }
  }
});

test("tool-render probe returns structured unavailability reason on mismatch", async () => {
  const originalPiBinPath = process.env.PI_BIN_PATH;
  process.env.PI_BIN_PATH = "/definitely/missing/pi";
  resetPiRuntimeCache();

  try {
    const result = await probeTruthfulInteractiveWebSearchPatchCapability();
    assert.equal(result.supported, false);
    assert.match(result.reason, /tool-render патч пропущен/);
    assert.ok(result.diagnostics.length >= 1);
  } finally {
    resetPiRuntimeCache();
    if (originalPiBinPath == null) {
      delete process.env.PI_BIN_PATH;
    } else {
      process.env.PI_BIN_PATH = originalPiBinPath;
    }
  }
});
