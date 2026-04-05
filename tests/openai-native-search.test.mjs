import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildWebSearchTool,
  ensureNativeSearchIncludes,
  injectNativeWebSearch,
  isOpenAIResponsesModel,
  loadNativeSearchConfig,
} from "../src/openai-native-search.js";
import {
  appendStructuredCitations,
  buildWebSearchResultContent,
  extractInlineSourcesFromText,
  extractResultSources,
  extractStructuredSearchCallSources,
  formatTruthfulWebSearchDoneLabel,
  formatTruthfulWebSearchPendingLabel,
  getFactualSearchLifecycleUpdate,
  resolveWebSearchResultSources,
} from "../src/openai-search-display.js";
import {
  applyTruthfulInteractiveWebSearchPatch,
  registerTruthfulInteractiveWebSearchPatch,
} from "../src/openai-tool-execution-web-search-patch.js";
import {
  classifyRawResponse,
  classifyVerifierJsonl,
  findAssistantMessageEnd,
  formatProofTimestamp,
  isMainModule,
  parseJsonlEvents,
  resolveAbsoluteExtensionPath,
  stampScenarioResult,
} from "../scripts/openai-search-proof-lib.mjs";

async function loadTestableExtensionModule(tempDir, { fsPromisesLines, nativeSearchLines }) {
  const sourcePath = fileURLToPath(new URL("../index.js", import.meta.url));
  const searchDisplayPath = fileURLToPath(new URL("../src/openai-search-display.js", import.meta.url));
  const mockFsPromisesPath = path.join(tempDir, "fs-promises-mock.js");
  const mockNativeSearchPath = path.join(tempDir, "openai-native-search-mock.js");
  const mockDisplayPatchPath = path.join(tempDir, "openai-responses-display-patch-mock.js");
  const mockToolExecutionPatchPath = path.join(tempDir, "openai-tool-execution-web-search-patch-mock.js");
  const transformedModulePath = path.join(tempDir, "index.testable.mjs");

  fs.writeFileSync(mockFsPromisesPath, fsPromisesLines.join("\n"), "utf8");
  fs.writeFileSync(mockNativeSearchPath, nativeSearchLines.join("\n"), "utf8");
  fs.writeFileSync(
    mockDisplayPatchPath,
    ['export function registerOpenAIResponsesDisplayPatch() {}'].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    mockToolExecutionPatchPath,
    ['export async function registerTruthfulInteractiveWebSearchPatch() {}'].join("\n"),
    "utf8",
  );

  const originalSource = fs.readFileSync(sourcePath, "utf8");
  const transformedSource = originalSource
    .replace('"node:fs/promises"', JSON.stringify(pathToFileURL(mockFsPromisesPath).href))
    .replace('"./src/openai-native-search.js"', JSON.stringify(pathToFileURL(mockNativeSearchPath).href))
    .replace('"./src/openai-search-display.js"', JSON.stringify(pathToFileURL(searchDisplayPath).href))
    .replace(
      '"./src/openai-responses-display-patch.js"',
      JSON.stringify(pathToFileURL(mockDisplayPatchPath).href),
    )
    .replace(
      '"./src/openai-tool-execution-web-search-patch.js"',
      JSON.stringify(pathToFileURL(mockToolExecutionPatchPath).href),
    );

  fs.writeFileSync(transformedModulePath, transformedSource, "utf8");
  return import(pathToFileURL(transformedModulePath).href);
}

async function loadTestableDisplayPatchModule(tempDir) {
  const sourcePath = fileURLToPath(new URL("../src/openai-responses-display-patch.js", import.meta.url));
  const searchDisplayPath = fileURLToPath(new URL("../src/openai-search-display.js", import.meta.url));
  const mockPiAiPath = path.join(tempDir, "pi-ai-mock.js");
  const transformedModulePath = path.join(tempDir, "openai-responses-display-patch.testable.mjs");

  fs.writeFileSync(
    mockPiAiPath,
    [
      "export class AssistantMessageEventStream {}",
      'export function getEnvApiKey() { return ""; }',
      "export function registerApiProvider() {}",
      "export function supportsXhigh() { return false; }",
    ].join("\n"),
    "utf8",
  );

  const originalSource = fs.readFileSync(sourcePath, "utf8");
  const transformedSource = originalSource
    .replace('"@gsd/pi-ai"', JSON.stringify(pathToFileURL(mockPiAiPath).href))
    .replace('"./openai-search-display.js"', JSON.stringify(pathToFileURL(searchDisplayPath).href));

  fs.writeFileSync(transformedModulePath, transformedSource, "utf8");
  return import(pathToFileURL(transformedModulePath).href);
}

test("isOpenAIResponsesModel detects supported transports", () => {
  assert.equal(isOpenAIResponsesModel({ api: "openai-responses" }), true);
  assert.equal(isOpenAIResponsesModel({ api: "openai-codex-responses" }), true);
  assert.equal(isOpenAIResponsesModel({ api: "azure-openai-responses" }), true);
  assert.equal(isOpenAIResponsesModel({ api: "openai-completions" }), false);
  assert.equal(isOpenAIResponsesModel(undefined), false);
});

test("loadNativeSearchConfig reads env overrides", () => {
  const config = loadNativeSearchConfig({
    PI_OPENAI_NATIVE_SEARCH: "true",
    PI_OPENAI_NATIVE_SEARCH_MODE: "cached",
    PI_OPENAI_NATIVE_SEARCH_CONTEXT_SIZE: "high",
    PI_OPENAI_NATIVE_SEARCH_ALLOWED_DOMAINS: "example.com, docs.example.com ",
    PI_OPENAI_NATIVE_SEARCH_COUNTRY: "US",
    PI_OPENAI_NATIVE_SEARCH_CITY: "New York",
    PI_OPENAI_NATIVE_SEARCH_TIMEZONE: "America/New_York",
  });

  assert.deepEqual(config, {
    enabled: true,
    mode: "cached",
    contextSize: "high",
    allowedDomains: ["example.com", "docs.example.com"],
    userLocation: {
      type: "approximate",
      country: "US",
      region: undefined,
      city: "New York",
      timezone: "America/New_York",
    },
  });
});

test("buildWebSearchTool builds OpenAI tool shape", () => {
  assert.deepEqual(
    buildWebSearchTool({
      mode: "live",
      contextSize: "medium",
      allowedDomains: ["example.com"],
      userLocation: {
        type: "approximate",
        country: "US",
      },
    }),
    {
      type: "web_search",
      external_web_access: true,
      search_context_size: "medium",
      filters: {
        allowed_domains: ["example.com"],
      },
      user_location: {
        type: "approximate",
        country: "US",
      },
    },
  );
});

test("injectNativeWebSearch injects tool and removes custom search tools", () => {
  const payload = {
    model: "gpt-5.4",
    tools: [
      { type: "function", name: "read" },
      { type: "function", name: "search-the-web" },
      { type: "function", name: "google_search" },
    ],
  };

  const result = injectNativeWebSearch(
    payload,
    { api: "openai-responses", provider: "openai" },
    {
      enabled: true,
      mode: "live",
      contextSize: "medium",
      allowedDomains: ["example.com"],
      userLocation: undefined,
    },
  );

  assert.equal(result.tool_choice, "auto");
  assert.equal(result.parallel_tool_calls, true);
  assert.deepEqual(result.include, [
    "web_search_call.action.sources",
  ]);
  assert.deepEqual(result.tools, [
    { type: "function", name: "read" },
    {
      type: "web_search",
      external_web_access: true,
      search_context_size: "medium",
      filters: {
        allowed_domains: ["example.com"],
      },
    },
  ]);
});

test("ensureNativeSearchIncludes preserves existing include fields and dedupes duplicates", () => {
  const payload = {
    include: [
      "reasoning.encrypted_content",
      "web_search_call.action.sources",
      "reasoning.encrypted_content",
    ],
  };

  ensureNativeSearchIncludes(payload);

  assert.deepEqual(payload.include, [
    "reasoning.encrypted_content",
    "web_search_call.action.sources",
  ]);
});

test("injectNativeWebSearch leaves non-openai-responses payload untouched", () => {
  const payload = {
    tools: [{ type: "function", name: "search-the-web" }],
  };

  const result = injectNativeWebSearch(
    payload,
    { api: "openai-completions", provider: "openai" },
    {
      enabled: true,
      mode: "live",
    },
  );

  assert.deepEqual(result.tools, [{ type: "function", name: "search-the-web" }]);
});

test("injectNativeWebSearch does not duplicate existing native tool", () => {
  const payload = {
    tools: [
      { type: "function", name: "read" },
      { type: "web_search", external_web_access: false },
    ],
  };

  const result = injectNativeWebSearch(
    payload,
    { api: "openai-responses", provider: "openai" },
    {
      enabled: true,
      mode: "cached",
    },
  );

  assert.deepEqual(result.tools, [
    { type: "function", name: "read" },
    { type: "web_search", external_web_access: false },
  ]);
});

test("appendStructuredCitations appends only missing URLs", () => {
  const text = "Короткий ответ без ссылок.";
  const next = appendStructuredCitations(text, [
    { title: "OpenAI docs", url: "https://platform.openai.com/docs/guides/tools-web-search" },
    { title: "OpenAI docs", url: "https://platform.openai.com/docs/guides/tools-web-search" },
  ]);

  assert.match(next, /Источники:/);
  assert.match(next, /tools-web-search/);

  const preserved = appendStructuredCitations(next, [
    { title: "OpenAI docs", url: "https://platform.openai.com/docs/guides/tools-web-search" },
  ]);
  assert.equal(preserved, next);
});

test("extractResultSources normalizes results-only payload and drops malformed entries", () => {
  const result = extractResultSources([
    { title: "Result source", url: "https://example.com/result" },
    { source: { title: "Nested result", url: "https://example.com/nested" } },
    { url_citation: { title: "Citation result", url: "https://example.com/citation" } },
    { title: "Missing URL" },
    { source: { title: "Missing nested URL" } },
    { title: "Duplicate result", url: "https://example.com/result" },
    null,
  ]);

  assert.deepEqual(result, [
    { title: "Result source", url: "https://example.com/result" },
    { title: "Nested result", url: "https://example.com/nested" },
    { title: "Citation result", url: "https://example.com/citation" },
  ]);
});

test("extractStructuredSearchCallSources merges action.sources and results without cross-contamination", () => {
  const result = extractStructuredSearchCallSources(
    {
      sources: [
        { title: "Action source", url: "https://example.com/action" },
        { title: "Duplicate from action", url: "https://example.com/result" },
      ],
    },
    [
      { title: "Result source", url: "https://example.com/result" },
      { title: "Malformed result" },
    ],
  );

  assert.deepEqual(result, [
    { title: "Action source", url: "https://example.com/action" },
    { title: "Duplicate from action", url: "https://example.com/result" },
  ]);
});

test("resolveWebSearchResultSources merges structured call and annotation sources only", () => {
  const result = resolveWebSearchResultSources(
    [{ title: "Action source", url: "https://example.com/action" }],
    [
      { title: "Annotation source", url: "https://example.com/annotation" },
      { title: "Action duplicate", url: "https://example.com/action" },
    ],
    [{ title: "Fallback source", url: "https://example.com/fallback" }],
  );

  assert.deepEqual(result, [
    { title: "Action source", url: "https://example.com/action" },
    { title: "Annotation source", url: "https://example.com/annotation" },
  ]);
  assert.deepEqual(buildWebSearchResultContent(result), [
    {
      type: "web_search_result",
      title: "Action source",
      url: "https://example.com/action",
    },
    {
      type: "web_search_result",
      title: "Annotation source",
      url: "https://example.com/annotation",
    },
  ]);
});

test("resolveWebSearchResultSources ignores synthetic fallback when structured inputs are absent", () => {
  const result = resolveWebSearchResultSources(
    [],
    [],
    [{ title: "Fallback source", url: "https://example.com/fallback" }],
  );

  assert.deepEqual(result, []);
  assert.deepEqual(buildWebSearchResultContent(result), {
    type: "web_search_tool_result_complete",
  });
});

test("extractInlineSourcesFromText extracts markdown links before plain URLs", () => {
  const result = extractInlineSourcesFromText(
    "- [OpenAI acquires TBPN](https://www.axios.com/2026/04/02/openai-acquires-tbpn)\n- Raw URL: https://openai.com/index/openai-acquires-tbpn",
  );

  assert.deepEqual(result, [
    {
      title: "OpenAI acquires TBPN",
      url: "https://www.axios.com/2026/04/02/openai-acquires-tbpn",
    },
    {
      title: "https://openai.com/index/openai-acquires-tbpn",
      url: "https://openai.com/index/openai-acquires-tbpn",
    },
  ]);

  const webSearchResultSources = resolveWebSearchResultSources([], [], result);
  assert.deepEqual(webSearchResultSources, []);
});

test("truthful web search labels use only factual args", () => {
  assert.equal(
    formatTruthfulWebSearchPendingLabel({ query: "latest django version" }),
    "Searching the web: latest django version",
  );
  assert.equal(
    formatTruthfulWebSearchDoneLabel({ queries: ["openai news", "openai blog"] }),
    "Searched openai news (+1)",
  );
  assert.equal(
    formatTruthfulWebSearchDoneLabel({ page_url: "https://example.com/post" }),
    "Searched https://example.com/post",
  );
  assert.equal(formatTruthfulWebSearchPendingLabel({ pattern: "tbpn" }), "Searching the web: find tbpn");
  assert.equal(formatTruthfulWebSearchPendingLabel({}), "Searching the web");
  assert.equal(formatTruthfulWebSearchDoneLabel({}), "Searched the web");
});

test("applyTruthfulInteractiveWebSearchPatch rejects incompatible runtime shape", () => {
  assert.throws(
    () => applyTruthfulInteractiveWebSearchPatch(class {}, { theme: {}, keyHint() {} }),
    /formatToolExecution/,
  );
});

test("interactive web search patch renders truthful labels for pending and done states", async (t) => {
  if (!process.env.GSD_BIN_PATH) {
    t.skip("GSD_BIN_PATH is required for interactive renderer regression");
    return;
  }

  await registerTruthfulInteractiveWebSearchPatch();

  const gsdRoot = path.resolve(
    path.dirname(process.env.GSD_BIN_PATH),
    "..",
    "lib",
    "node_modules",
    "gsd-pi",
  );
  const toolExecutionModule = await import(
    pathToFileURL(
      path.join(
        gsdRoot,
        "packages",
        "pi-coding-agent",
        "dist",
        "modes",
        "interactive",
        "components",
        "tool-execution.js",
      ),
    ).href
  );
  const themeModule = await import(
    pathToFileURL(
      path.join(
        gsdRoot,
        "packages",
        "pi-coding-agent",
        "dist",
        "modes",
        "interactive",
        "theme",
        "theme.js",
      ),
    ).href
  );
  themeModule.initTheme("default", false);

  const ui = { requestRender() {} };
  const pendingComponent = new toolExecutionModule.ToolExecutionComponent(
    "web_search",
    { query: "latest django version" },
    {},
    undefined,
    ui,
    process.cwd(),
  );

  assert.match(pendingComponent.formatToolExecution(), /Searching the web: latest django version/);

  pendingComponent.updateResult(
    {
      content: [{ type: "text", text: "https://docs.djangoproject.com/" }],
      details: {},
      isError: false,
    },
    false,
  );
  assert.match(pendingComponent.formatToolExecution(), /Searched latest django version/);

  const malformedComponent = new toolExecutionModule.ToolExecutionComponent(
    "web_search",
    {},
    {},
    undefined,
    ui,
    process.cwd(),
  );
  assert.match(malformedComponent.formatToolExecution(), /Searching the web/);
  malformedComponent.updateResult({ content: [], details: {}, isError: false }, false);
  assert.match(malformedComponent.formatToolExecution(), /Searched the web/);

  const secondComponent = new toolExecutionModule.ToolExecutionComponent(
    "web_search",
    { queries: ["openai news", "openai blog"] },
    {},
    undefined,
    ui,
    process.cwd(),
  );
  secondComponent.updateResult(
    {
      content: [{ type: "text", text: "https://openai.com/news/" }],
      details: {},
      isError: false,
    },
    false,
  );

  assert.match(secondComponent.formatToolExecution(), /Searched openai news \(\+1\)/);
});

test("getFactualSearchLifecycleUpdate uses only real search events", () => {
  const searchingMessage = {
    role: "assistant",
    content: [
      {
        type: "serverToolUse",
        id: "search_1",
        name: "web_search",
        input: {
          query: "latest django version",
        },
      },
    ],
  };

  assert.deepEqual(
    getFactualSearchLifecycleUpdate({
      type: "server_tool_use",
      contentIndex: 0,
      partial: searchingMessage,
    }),
    {
      phase: "searching",
      toolUseId: "search_1",
      statusText: "web: latest django version",
      workingMessage: "Searching the web: latest django version",
    },
  );

  const resultMessage = {
    role: "assistant",
    content: [
      searchingMessage.content[0],
      {
        type: "webSearchResult",
        toolUseId: "search_1",
        content: [
          { type: "web_search_result", title: "Django", url: "https://www.djangoproject.com/" },
          { type: "web_search_result", title: "Docs", url: "https://docs.djangoproject.com/" },
        ],
      },
    ],
  };

  assert.deepEqual(
    getFactualSearchLifecycleUpdate({
      type: "web_search_result",
      contentIndex: 1,
      partial: resultMessage,
    }),
    {
      phase: "complete",
      toolUseId: "search_1",
      statusText: "web: 2 sources",
      workingMessage: undefined,
    },
  );
});

test("getFactualSearchLifecycleUpdate ignores malformed and non-factual inputs", () => {
  assert.equal(getFactualSearchLifecycleUpdate(undefined), null);
  assert.equal(
    getFactualSearchLifecycleUpdate({
      type: "server_tool_use",
      contentIndex: 0,
      partial: {
        role: "assistant",
        content: [{ type: "serverToolUse", id: "search_1", name: "web_search", input: {} }],
      },
    }),
    null,
  );
  assert.equal(
    getFactualSearchLifecycleUpdate({
      type: "web_search_result",
      contentIndex: 0,
      partial: {
        role: "assistant",
        content: [{ type: "webSearchResult", content: [] }],
      },
    }),
    null,
  );
  assert.equal(
    getFactualSearchLifecycleUpdate({
      type: "text_delta",
      contentIndex: 0,
      partial: {
        role: "assistant",
        content: [{ type: "text", text: "https://example.com" }],
      },
    }),
    null,
  );
});

test("extension updates TUI status for native web search lifecycle", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-ui-test-"));

  try {
    const extensionModule = await loadTestableExtensionModule(tempDir, {
      fsPromisesLines: [
        'export async function mkdir() {}',
        'export async function writeFile() {}',
      ],
      nativeSearchLines: [
        'export function injectNativeWebSearch(payload) {',
        '  return { ...payload, tools: [{ type: "web_search", external_web_access: true }] };',
        '}',
        'export function isOpenAIResponsesModel() { return true; }',
        'export function loadNativeSearchConfig() { return { enabled: true, mode: "live" }; }',
      ],
    });

    const handlers = new Map();
    extensionModule.default({
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    const statusCalls = [];
    const workingCalls = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify() {},
        setStatus(key, value) {
          statusCalls.push([key, value]);
        },
        setWorkingMessage(value) {
          workingCalls.push(value);
        },
      },
    };

    const nextPayload = handlers.get("before_provider_request")(
      {
        payload: { tools: [] },
        model: { api: "openai-responses", provider: "openai" },
      },
      ctx,
    );

    assert.deepEqual(nextPayload.tools, [{ type: "web_search", external_web_access: true }]);
    assert.deepEqual(workingCalls, []);
    assert.deepEqual(statusCalls, []);

    const searchingMessage = {
      role: "assistant",
      content: [
        {
          type: "serverToolUse",
          id: "search_1",
          name: "web_search",
          input: {
            query: "node.js 24.14.1 release notes",
          },
        },
      ],
    };

    handlers.get("message_update")(
      {
        message: searchingMessage,
        assistantMessageEvent: {
          type: "server_tool_use",
          contentIndex: 0,
          partial: searchingMessage,
        },
      },
      ctx,
    );

    assert.deepEqual(workingCalls, ["Searching the web: node.js 24.14.1 release notes"]);
    assert.deepEqual(statusCalls, [["openai-native-web-search", "web: node.js 24.14.1 release notes"]]);

    const resultMessage = {
      role: "assistant",
      content: [
        searchingMessage.content[0],
        {
          type: "webSearchResult",
          toolUseId: "search_1",
          content: [
            { type: "web_search_result", title: "Node.js", url: "https://nodejs.org/en/download" },
            { type: "web_search_result", title: "Release", url: "https://nodejs.org/en/blog/release/v24.14.1" },
          ],
        },
      ],
    };

    handlers.get("message_update")(
      {
        message: resultMessage,
        assistantMessageEvent: {
          type: "web_search_result",
          contentIndex: 1,
          partial: resultMessage,
        },
      },
      ctx,
    );

    assert.deepEqual(workingCalls, ["Searching the web: node.js 24.14.1 release notes", undefined]);
    assert.deepEqual(statusCalls, [
      ["openai-native-web-search", "web: node.js 24.14.1 release notes"],
      ["openai-native-web-search", "web: 2 sources"],
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extension does not show synthetic search status without factual search events", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-no-search-test-"));

  try {
    const extensionModule = await loadTestableExtensionModule(tempDir, {
      fsPromisesLines: [
        'export async function mkdir() {}',
        'export async function writeFile() {}',
      ],
      nativeSearchLines: [
        'export function injectNativeWebSearch(payload) {',
        '  return { ...payload, tools: [{ type: "web_search", external_web_access: true }] };',
        '}',
        'export function isOpenAIResponsesModel() { return true; }',
        'export function loadNativeSearchConfig() { return { enabled: true, mode: "live" }; }',
      ],
    });

    const handlers = new Map();
    extensionModule.default({
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    const statusCalls = [];
    const workingCalls = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify() {},
        setStatus(key, value) {
          statusCalls.push([key, value]);
        },
        setWorkingMessage(value) {
          workingCalls.push(value);
        },
      },
    };

    handlers.get("before_provider_request")(
      {
        payload: { tools: [] },
        model: { api: "openai-responses", provider: "openai" },
      },
      ctx,
    );

    await handlers.get("message_end")(
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Here is a normal answer with an inline URL https://example.com but no real search event.",
            },
          ],
        },
      },
      ctx,
    );

    assert.deepEqual(workingCalls, []);
    assert.deepEqual(statusCalls, []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extension clears factual search status when assistant turn ends without completion", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-cleanup-test-"));

  try {
    const extensionModule = await loadTestableExtensionModule(tempDir, {
      fsPromisesLines: [
        'export async function mkdir() {}',
        'export async function writeFile() {}',
      ],
      nativeSearchLines: [
        'export function injectNativeWebSearch(payload) {',
        '  return { ...payload, tools: [{ type: "web_search", external_web_access: true }] };',
        '}',
        'export function isOpenAIResponsesModel() { return true; }',
        'export function loadNativeSearchConfig() { return { enabled: true, mode: "live" }; }',
      ],
    });

    const handlers = new Map();
    extensionModule.default({
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    const statusCalls = [];
    const workingCalls = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify() {},
        setStatus(key, value) {
          statusCalls.push([key, value]);
        },
        setWorkingMessage(value) {
          workingCalls.push(value);
        },
      },
    };

    const searchingMessage = {
      role: "assistant",
      content: [
        {
          type: "serverToolUse",
          id: "search_1",
          name: "web_search",
          input: {
            query: "latest django version",
          },
        },
      ],
    };

    handlers.get("message_update")(
      {
        message: searchingMessage,
        assistantMessageEvent: {
          type: "server_tool_use",
          contentIndex: 0,
          partial: searchingMessage,
        },
      },
      ctx,
    );

    await handlers.get("message_end")(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer without a matching search completion." }],
        },
      },
      ctx,
    );

    assert.deepEqual(workingCalls, ["Searching the web: latest django version", undefined]);
    assert.deepEqual(statusCalls, [
      ["openai-native-web-search", "web: latest django version"],
      ["openai-native-web-search", undefined],
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("debug snapshot write failures do not escape extension handlers", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-index-test-"));

  try {
    const extensionModule = await loadTestableExtensionModule(tempDir, {
      fsPromisesLines: [
        'export async function mkdir() {}',
        'export async function writeFile() { throw new Error("debug write failed"); }',
      ],
      nativeSearchLines: [
        'export function injectNativeWebSearch(payload) { return { ...payload, injected: true }; }',
        'export function isOpenAIResponsesModel() { return true; }',
        'export function loadNativeSearchConfig() { return { enabled: true, mode: "live" }; }',
      ],
    });

    const handlers = new Map();
    extensionModule.default({
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    assert.equal(typeof handlers.get("before_provider_request"), "function");
    assert.equal(typeof handlers.get("message_update"), "function");
    assert.equal(typeof handlers.get("message_end"), "function");

    process.env.PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE = path.join(tempDir, "payload.json");
    process.env.PI_OPENAI_NATIVE_SEARCH_DEBUG_MESSAGE_FILE = path.join(tempDir, "message.json");

    assert.doesNotThrow(() => {
      handlers.get("before_provider_request")({
        payload: { tools: [] },
        model: { api: "openai-responses", provider: "openai" },
      });
    });

    assert.doesNotThrow(() => {
      handlers.get("message_update")({
        message: {
          role: "assistant",
          content: [
            {
              type: "serverToolUse",
              id: "search_1",
              name: "web_search",
              input: { query: "latest django version" },
            },
          ],
        },
        assistantMessageEvent: {
          type: "server_tool_use",
          contentIndex: 0,
          partial: {
            role: "assistant",
            content: [
              {
                type: "serverToolUse",
                id: "search_1",
                name: "web_search",
                input: { query: "latest django version" },
              },
            ],
          },
        },
      });
    });

    await assert.doesNotReject(async () => {
      await handlers.get("message_end")({
        message: {
          role: "assistant",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.4",
          stopReason: "stop",
          content: [{ type: "text", text: "ok" }],
        },
      });
    });
  } finally {
    delete process.env.PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE;
    delete process.env.PI_OPENAI_NATIVE_SEARCH_DEBUG_MESSAGE_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("isCompactNoSessionOutput treats piped stdout as compact proof mode", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-compact-mode-test-"));
  const originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  try {
    const patchModule = await loadTestableDisplayPatchModule(tempDir);

    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: undefined,
    });
    assert.equal(patchModule.isCompactNoSessionOutput(), true);

    process.stdout.isTTY = false;
    assert.equal(patchModule.isCompactNoSessionOutput(), true);

    process.stdout.isTTY = true;
    assert.equal(patchModule.isCompactNoSessionOutput(), false);
  } finally {
    if (originalIsTTYDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", originalIsTTYDescriptor);
    } else {
      delete process.stdout.isTTY;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("enrichOutputFromCompletedResponse keeps per-call truthfulness and backfills terminal search only", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-enrich-test-"));

  try {
    const patchModule = await loadTestableDisplayPatchModule(tempDir);
    const streamEvents = [];
    const stream = {
      push(event) {
        streamEvents.push(event);
      },
    };
    const output = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Итоговый ответ с inline URL https://inline.example.com/ghost",
        },
      ],
    };
    const state = {
      messageBlockByItemId: new Map([["msg_1", 0]]),
      searchCallIds: new Set(),
      searchToolBlockById: new Map(),
      searchResultBlockById: new Map(),
    };

    patchModule.enrichOutputFromCompletedResponse(
      output,
      {
        output: [
          {
            type: "web_search_call",
            id: "search_1",
            action: {
              type: "search",
              query: "openai news april",
            },
            results: [
              { title: "First result source", url: "https://example.com/first" },
              { title: "Malformed result without url" },
            ],
          },
          {
            type: "web_search_call",
            id: "open_1",
            action: {
              type: "open_page",
              url: "https://example.com/article",
            },
          },
          {
            type: "web_search_call",
            id: "find_1",
            action: {
              type: "find_in_page",
              pattern: "OpenAI",
            },
          },
          {
            type: "web_search_call",
            id: "search_2",
            action: {
              type: "search",
              query: "latest openai announcements",
              sources: [
                { title: "Second source", url: "https://example.com/second" },
                { title: "First source duplicate", url: "https://example.com/first" },
              ],
            },
            results: [
              { title: "Third result source", url: "https://example.com/third" },
              { title: "Second source duplicate", url: "https://example.com/second" },
              { source: { title: "Malformed nested result" } },
            ],
          },
          {
            type: "message",
            id: "msg_1",
            content: [
              {
                type: "output_text",
                text: "- Raw URL in text only: https://inline.example.com/ghost",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      title: "Annotation source",
                      url: "https://example.com/annotated",
                    },
                  },
                  {
                    type: "url_citation",
                    url_citation: {
                      title: "Second source duplicate",
                      url: "https://example.com/second",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      state,
      stream,
    );

    const resultByToolUseId = new Map(
      output.content
        .filter((block) => block?.type === "webSearchResult")
        .map((block) => [block.toolUseId, block.content]),
    );

    assert.deepEqual(resultByToolUseId.get("search_1"), [
      {
        type: "web_search_result",
        title: "First result source",
        url: "https://example.com/first",
      },
    ]);
    assert.deepEqual(resultByToolUseId.get("open_1"), {
      type: "web_search_tool_result_complete",
    });
    assert.deepEqual(resultByToolUseId.get("find_1"), {
      type: "web_search_tool_result_complete",
    });
    assert.deepEqual(resultByToolUseId.get("search_2"), [
      {
        type: "web_search_result",
        title: "First result source",
        url: "https://example.com/first",
      },
      {
        type: "web_search_result",
        title: "Second source",
        url: "https://example.com/second",
      },
      {
        type: "web_search_result",
        title: "Third result source",
        url: "https://example.com/third",
      },
      {
        type: "web_search_result",
        title: "Annotation source",
        url: "https://example.com/annotated",
      },
    ]);

    assert.ok(
      output.content[0].text.includes("https://inline.example.com/ghost"),
      "inline URL в тексте должен сохраниться только в text block",
    );
    assert.ok(
      output.content[0].text.includes("https://example.com/annotated"),
      "structured annotation sources should still be appended to text citations",
    );
    assert.equal(
      resultByToolUseId.get("search_1").some((item) => item.url === "https://inline.example.com/ghost"),
      false,
    );
    assert.equal(
      resultByToolUseId.get("search_2").some((item) => item.url === "https://inline.example.com/ghost"),
      false,
    );
    assert.deepEqual(
      output.content
        .filter((block) => block?.type === "serverToolUse")
        .map((block) => block.id),
      ["search_1", "open_1", "find_1", "search_2"],
    );
    assert.equal(streamEvents.filter((event) => event.type === "web_search_result").length, 4);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("registerOpenAIResponsesDisplayPatch re-registers provider on repeated calls", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-test-"));

  try {
    const sourcePath = fileURLToPath(new URL("../src/openai-responses-display-patch.js", import.meta.url));
    const searchDisplayPath = fileURLToPath(new URL("../src/openai-search-display.js", import.meta.url));
    const mockPiAiPath = path.join(tempDir, "pi-ai-mock.js");
    const transformedModulePath = path.join(tempDir, "openai-responses-display-patch.testable.mjs");

    fs.writeFileSync(
      mockPiAiPath,
      [
        'export class AssistantMessageEventStream {}',
        'export function getEnvApiKey() { return ""; }',
        'export function registerApiProvider(provider, sourceId) {',
        '  globalThis.__providerCalls = globalThis.__providerCalls || [];',
        '  globalThis.__providerCalls.push({ provider, sourceId });',
        '}',
        'export function supportsXhigh() { return false; }',
      ].join("\n"),
      "utf8",
    );

    const originalSource = fs.readFileSync(sourcePath, "utf8");
    const transformedSource = originalSource
      .replace('"@gsd/pi-ai"', JSON.stringify(pathToFileURL(mockPiAiPath).href))
      .replace('"./openai-search-display.js"', JSON.stringify(pathToFileURL(searchDisplayPath).href));

    fs.writeFileSync(transformedModulePath, transformedSource, "utf8");
    delete globalThis.__providerCalls;

    const patchModule = await import(pathToFileURL(transformedModulePath).href);
    patchModule.registerOpenAIResponsesDisplayPatch();
    patchModule.registerOpenAIResponsesDisplayPatch();

    assert.equal(globalThis.__providerCalls.length, 2);
    assert.equal(globalThis.__providerCalls[0].provider.api, "openai-responses");
    assert.equal(globalThis.__providerCalls[1].provider.api, "openai-responses");
  } finally {
    delete globalThis.__providerCalls;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadExtensions replaces openai-responses provider in shared pi-ai registry", async (t) => {
  if (!process.env.GSD_BIN_PATH) {
    t.skip("GSD_BIN_PATH is required for gsd-pi integration test");
    return;
  }

  const gsdRoot = path.resolve(
    path.dirname(process.env.GSD_BIN_PATH),
    "..",
    "lib",
    "node_modules",
    "gsd-pi",
  );
  const piAiModule = await import(pathToFileURL(path.join(gsdRoot, "packages/pi-ai/dist/index.js")).href);
  const loaderModule = await import(
    pathToFileURL(path.join(gsdRoot, "packages/pi-coding-agent/dist/core/extensions/loader.js")).href
  );

  piAiModule.resetApiProviders();
  const before = piAiModule.getApiProvider("openai-responses");

  try {
    const result = await loaderModule.loadExtensions([path.resolve("index.js")], process.cwd());
    const after = piAiModule.getApiProvider("openai-responses");

    assert.equal(result.errors.length, 0);
    assert.equal(result.extensions.length, 1);
    assert.notEqual(after, before);
    assert.equal(typeof after?.streamSimple, "function");
    assert.equal(typeof after?.stream, "function");
  } finally {
    piAiModule.resetApiProviders();
  }
});

test("proof helper parses JSONL and rejects malformed rows", () => {
  const events = parseJsonlEvents('{"type":"message_start"}\n{"type":"message_end","message":{"role":"assistant","content":[]}}\n');
  assert.equal(events.length, 2);

  assert.throws(
    () => parseJsonlEvents('{"type":"message_start"}\nnot-json\n'),
    /JSONL строку 2/,
  );
});

test("proof helper requires existing absolute extension path", () => {
  assert.equal(resolveAbsoluteExtensionPath("./index.js"), path.resolve("index.js"));

  assert.throws(
    () => resolveAbsoluteExtensionPath("./missing-index.js"),
    /Extension path не найден/,
  );
});

test("proof helper treats symlinked script path as direct entrypoint", () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-main-module-test-"));

  try {
    const targetPath = path.join(tempDir, "target-script.mjs");
    const symlinkPath = path.join(tempDir, "linked-script.mjs");
    const otherPath = path.join(tempDir, "other-script.mjs");

    fs.writeFileSync(targetPath, "export default null;\n", "utf8");
    fs.symlinkSync(targetPath, symlinkPath);

    assert.equal(isMainModule(symlinkPath, pathToFileURL(targetPath).href), true);
    assert.equal(isMainModule(otherPath, pathToFileURL(targetPath).href), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("proof helper stamps scenario result with deterministic ISO timestamp", () => {
  const observedAt = formatProofTimestamp("2026-04-04T20:06:44.000Z");
  const result = stampScenarioResult({ scenario: "A", verdict: "blocker" }, observedAt);

  assert.equal(observedAt, "2026-04-04T20:06:44.000Z");
  assert.deepEqual(result, {
    scenario: "A",
    verdict: "blocker",
    observedAt: "2026-04-04T20:06:44.000Z",
  });
});

test("raw proof classification marks scenario A as blocker without structured seams", () => {
  const result = classifyRawResponse(
    {
      output: [
        {
          type: "web_search_call",
          id: "ws_1",
          action: {
            type: "search",
            query: "openai news",
          },
          results: [],
        },
        {
          type: "message",
          id: "msg_1",
          content: [
            {
              type: "output_text",
              text: "- OpenAI news: https://openai.com/index/openai-acquires-tbpn",
              annotations: [],
            },
          ],
        },
      ],
    },
    "A",
  );

  assert.equal(result.verdict, "blocker");
  assert.match(result.reason, /inline URLs|structured URLs/);
  assert.equal(result.summary.searchCallCount, 1);
  assert.deepEqual(result.summary.structuredSourceCounts, {
    actionSources: 0,
    resultSources: 0,
    annotationSources: 0,
    inlineSources: 1,
  });
});

test("raw proof classification passes scenario A when action.sources is present", () => {
  const result = classifyRawResponse(
    {
      output: [
        {
          type: "web_search_call",
          id: "ws_1",
          action: {
            type: "search",
            query: "openai news",
            sources: [
              { type: "url", url: "https://example.com/action-source" },
            ],
          },
        },
        {
          type: "message",
          id: "msg_1",
          content: [
            {
              type: "output_text",
              text: "- OpenAI news",
              annotations: [],
            },
          ],
        },
      ],
    },
    "A",
  );

  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.summary.documentedStructuredSeams, ["action.sources"]);
  assert.deepEqual(result.summary.opportunisticStructuredSeams, []);
});

test("raw proof classification keeps results-only seam as blocker", () => {
  const result = classifyRawResponse(
    {
      output: [
        {
          type: "web_search_call",
          id: "ws_1",
          action: {
            type: "search",
            query: "openai news",
          },
          results: [
            { title: "Result source", url: "https://example.com/result-source" },
          ],
        },
        {
          type: "message",
          id: "msg_1",
          content: [
            {
              type: "output_text",
              text: "- OpenAI news",
              annotations: [],
            },
          ],
        },
      ],
    },
    "A",
  );

  assert.equal(result.verdict, "blocker");
  assert.match(result.reason, /opportunistic results seam/);
  assert.deepEqual(result.summary.documentedStructuredSeams, []);
  assert.deepEqual(result.summary.opportunisticStructuredSeams, ["results"]);
});

test("raw proof classification passes scenario B only when search stays absent", () => {
  const passResult = classifyRawResponse(
    {
      output: [
        {
          type: "message",
          id: "msg_1",
          content: [
            {
              type: "output_text",
              text: "Calm acknowledgement",
              annotations: [],
            },
          ],
        },
      ],
    },
    "B",
  );
  assert.equal(passResult.verdict, "pass");

  const failResult = classifyRawResponse(
    {
      output: [
        {
          type: "web_search_call",
          id: "ws_1",
          action: { type: "search", query: "openai news" },
        },
        {
          type: "message",
          id: "msg_1",
          content: [{ type: "output_text", text: "Calm acknowledgement", annotations: [] }],
        },
      ],
    },
    "B",
  );
  assert.equal(failResult.verdict, "fail");
});

test("verifier classification marks sentinel-only scenario A as blocker", () => {
  const result = classifyVerifierJsonl(
    parseJsonlEvents(
      [
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: {
            type: "server_tool_use",
            contentIndex: 0,
            partial: {
              role: "assistant",
              content: [{ type: "serverToolUse", id: "ws_1", name: "web_search", input: { query: "openai news" } }],
            },
          },
        }),
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: {
            type: "web_search_result",
            contentIndex: 0,
            partial: {
              role: "assistant",
              content: [{ type: "webSearchResult", toolUseId: "ws_1", content: { type: "web_search_tool_result_complete" } }],
            },
          },
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "serverToolUse", id: "ws_1", name: "web_search", input: { query: "openai news" } },
              { type: "webSearchResult", toolUseId: "ws_1", content: { type: "web_search_tool_result_complete" } },
              { type: "text", text: "Done" },
            ],
          },
        }),
      ].join("\n"),
    ),
    "A",
  );

  assert.equal(result.verdict, "blocker");
  assert.match(result.reason, /sentinel/);
  assert.equal(result.summary.serverToolEventCount, 1);
  assert.equal(result.summary.webSearchResultEventCount, 1);
  assert.equal(result.summary.finalServerToolUseCount, 1);
  assert.equal(result.summary.finalWebSearchResultCount, 1);
  assert.equal(result.summary.resultBlockCount, 1);
  assert.equal(result.summary.sentinelCount, 1);
});

test("proof helper rejects verifier streams without final message_end", () => {
  const events = parseJsonlEvents(
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","partial":{"content":[]}}}\n',
  );

  assert.throws(
    () => findAssistantMessageEnd(events),
    /message_end/,
  );
});

test("verifier classification ignores valid www domains and still rejects standalone garbage placeholders", () => {
  const passResult = classifyVerifierJsonl(
    parseJsonlEvents(
      [
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: {
            type: "server_tool_use",
            contentIndex: 0,
            partial: {
              role: "assistant",
              content: [{ type: "serverToolUse", id: "ws_1", name: "web_search", input: { query: "openai news" } }],
            },
          },
        }),
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: {
            type: "web_search_result",
            contentIndex: 0,
            partial: {
              role: "assistant",
              content: [
                {
                  type: "webSearchResult",
                  toolUseId: "ws_1",
                  content: [
                    {
                      type: "web_search_result",
                      title: "Axios",
                      url: "https://www.axios.com/2026/04/02/openai-acquires-tbpn",
                    },
                  ],
                },
              ],
            },
          },
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "serverToolUse", id: "ws_1", name: "web_search", input: { query: "openai news" } },
              {
                type: "webSearchResult",
                toolUseId: "ws_1",
                content: [
                  {
                    type: "web_search_result",
                    title: "Axios",
                    url: "https://www.axios.com/2026/04/02/openai-acquires-tbpn",
                  },
                ],
              },
              { type: "text", text: "Done" },
            ],
          },
        }),
      ].join("\n"),
    ),
    "A",
  );
  assert.equal(passResult.verdict, "pass");

  const failResult = classifyVerifierJsonl(
    parseJsonlEvents(
      [
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Garbage https://www placeholder" }],
          },
        }),
      ].join("\n"),
    ),
    "B",
  );
  assert.equal(failResult.verdict, "fail");
  assert.match(failResult.reason, /мусорный URL|garbage URL/);
});

test("verifier classification keeps scenario B clean and rejects garbage URLs", () => {
  const passResult = classifyVerifierJsonl(
    parseJsonlEvents(
      [
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "" },
              { type: "text", text: "Calm acknowledgement" },
            ],
          },
        }),
      ].join("\n"),
    ),
    "B",
  );
  assert.equal(passResult.verdict, "pass");

  const failResult = classifyVerifierJsonl(
    parseJsonlEvents(
      [
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Garbage https://www placeholder" },
            ],
          },
        }),
      ].join("\n"),
    ),
    "B",
  );
  assert.equal(failResult.verdict, "fail");
  assert.match(failResult.reason, /мусорный URL|garbage URL/);
});

test(
  "live createAgentSession persists native web search blocks in assistant history",
  { timeout: 240_000 },
  async (t) => {
    if (!process.env.PI_OPENAI_NATIVE_SEARCH_LIVE_TEST) {
      t.skip("set PI_OPENAI_NATIVE_SEARCH_LIVE_TEST=1 to run live OpenAI regression");
      return;
    }
    if (!process.env.OPENAI_API_KEY) {
      t.skip("OPENAI_API_KEY is required for live OpenAI regression");
      return;
    }
    if (!process.env.GSD_BIN_PATH) {
      t.skip("GSD_BIN_PATH is required for gsd-pi live regression");
      return;
    }

    const childScript = String.raw`
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const gsdRoot = path.resolve(path.dirname(process.env.GSD_BIN_PATH), "..", "lib", "node_modules", "gsd-pi");
const tempDir = fs.mkdtempSync(path.join(repoRoot, ".tmp-pi-openai-search-live-"));
const sessionDir = path.join(tempDir, "sessions");
const agentDir = "/home/spike/.gsd/agent";

const { DefaultResourceLoader } = await import(pathToFileURL(path.join(gsdRoot, "packages/pi-coding-agent/dist/core/resource-loader.js")).href);
const { SettingsManager } = await import(pathToFileURL(path.join(gsdRoot, "packages/pi-coding-agent/dist/core/settings-manager.js")).href);
const { AuthStorage } = await import(pathToFileURL(path.join(gsdRoot, "packages/pi-coding-agent/dist/core/auth-storage.js")).href);
const { ModelRegistry } = await import(pathToFileURL(path.join(gsdRoot, "packages/pi-coding-agent/dist/core/model-registry.js")).href);
const { SessionManager } = await import(pathToFileURL(path.join(gsdRoot, "packages/pi-coding-agent/dist/core/session-manager.js")).href);
const { createAgentSession } = await import(pathToFileURL(path.join(gsdRoot, "packages/pi-coding-agent/dist/core/sdk.js")).href);

try {
  const settingsManager = SettingsManager.create(repoRoot, agentDir);
  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
  const model = modelRegistry.find("openai", "gpt-5.4");
  if (!model) {
    throw new Error("openai/gpt-5.4 model is not available in model registry");
  }

  const loader = new DefaultResourceLoader({
    cwd: repoRoot,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [path.resolve(repoRoot, "index.js")],
  });
  await loader.reload();

  const sessionManager = SessionManager.create(repoRoot, sessionDir);
  const { session } = await createAgentSession({
    cwd: repoRoot,
    agentDir,
    resourceLoader: loader,
    modelRegistry,
    authStorage,
    model,
    thinkingLevel: "off",
    sessionManager,
  });

  await session.prompt("Search the web for the latest OpenAI news today. Return exactly one bullet with one link.");

  const memoryLast = session.messages.at(-1);
  const persistedLast = sessionManager.buildSessionContext().messages.at(-1);
  const memoryResultBlock = Array.isArray(memoryLast?.content)
    ? memoryLast.content.find((block) => block?.type === "webSearchResult")
    : undefined;
  const persistedResultBlock = Array.isArray(persistedLast?.content)
    ? persistedLast.content.find((block) => block?.type === "webSearchResult")
    : undefined;
  console.log(JSON.stringify({
    model: { provider: model.provider, id: model.id, api: model.api },
    memoryTypes: Array.isArray(memoryLast?.content) ? memoryLast.content.map((block) => block.type) : null,
    persistedTypes: Array.isArray(persistedLast?.content) ? persistedLast.content.map((block) => block.type) : null,
    memoryResultContent: memoryResultBlock?.content ?? null,
    persistedResultContent: persistedResultBlock?.content ?? null,
    stopReason: memoryLast?.stopReason,
  }));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
process.exit(0);
`;

    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_OPENAI_NATIVE_SEARCH: "1",
        PI_OPENAI_NATIVE_SEARCH_MODE: "live",
      },
      encoding: "utf8",
      timeout: 230_000,
      maxBuffer: 1024 * 1024,
    });

    if (child.error) {
      throw child.error;
    }

    assert.equal(child.status, 0, child.stderr || child.stdout);

    const result = JSON.parse(child.stdout.trim());
    assert.deepEqual(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
    });
    assert.deepEqual(result.memoryTypes, ["serverToolUse", "webSearchResult", "text"]);
    assert.deepEqual(result.persistedTypes, ["serverToolUse", "webSearchResult", "text"]);
    assert.ok(Array.isArray(result.memoryResultContent), "memory webSearchResult should contain search result entries");
    assert.ok(Array.isArray(result.persistedResultContent), "persisted webSearchResult should contain search result entries");
    assert.ok(result.memoryResultContent.length > 0, "memory webSearchResult should not be empty");
    assert.ok(result.persistedResultContent.length > 0, "persisted webSearchResult should not be empty");
    assert.equal(result.memoryResultContent[0]?.type, "web_search_result");
    assert.equal(result.persistedResultContent[0]?.type, "web_search_result");
    assert.equal(result.stopReason, "stop");
  },
);
