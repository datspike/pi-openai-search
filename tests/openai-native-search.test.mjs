import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  isOpenAIResponsesModel,
  loadNativeSearchConfig,
} from "../src/core/config/native-search-config.js";
import {
  buildWebSearchTool,
  ensureNativeSearchIncludes,
  injectNativeWebSearch,
} from "../src/core/payload/native-search.js";
import {
  appendStructuredCitations,
  buildWebSearchResultContent,
  extractInlineSourcesFromText,
  extractResultSources,
  extractStructuredSearchCallSources,
  resolveWebSearchResultSources,
} from "../src/core/truthful/search-results.js";
import {
  formatWebSearchResult,
  formatTruthfulWebSearchDoneLabel,
  formatTruthfulWebSearchPendingLabel,
  getFactualSearchLifecycleUpdate,
  summarizeSearchInput,
} from "../src/core/lifecycle/search-status.js";
import {
  applyInteractiveSearchOrderPatch,
} from "../src/compat/interactive/search-order-patch.js";
import {
  applyTruthfulInteractiveWebSearchPatch,
  registerTruthfulInteractiveWebSearchPatch,
} from "../src/compat/interactive/tool-execution-web-search-patch.js";
import {
  classifyRawResponse,
  classifyVerifierJsonl,
  findAssistantMessageEnd,
  formatProofTimestamp,
  isMainModule,
  parseJsonlEvents,
  resolveAbsoluteExtensionPath,
  resolveProviderApiKey,
  stampScenarioResult,
} from "../scripts/openai-search-proof-lib.mjs";
import {
  importPiRuntimeModule,
  resetPiRuntimeCache,
  resolvePiRuntimeDescriptor,
  resolvePiRuntimeRoot,
} from "../src/compat/runtime/pi-runtime.js";

async function loadTestableExtensionModule(
  tempDir,
  {
    fsPromisesLines,
    nativeSearchLines,
    interactiveSearchOrderPatchLines,
    toolExecutionPatchLines,
    providerCompatLines,
  },
) {
  const sourcePath = fileURLToPath(new URL("../index.js", import.meta.url));
  const coreExtensionPath = fileURLToPath(new URL("../src/core/extension/register-openai-search-extension.js", import.meta.url));
  const debugSnapshotsPath = fileURLToPath(new URL("../src/core/extension/debug-snapshots.js", import.meta.url));
  const compatBootstrapPath = fileURLToPath(new URL("../src/compat/bootstrap.js", import.meta.url));
  const searchDisplayPath = fileURLToPath(new URL("../src/core/lifecycle/search-status.js", import.meta.url));
  const compatPath = fileURLToPath(new URL("../src/compat/runtime/pi-runtime.js", import.meta.url));
  const compatCapabilitiesPath = fileURLToPath(new URL("../src/compat/runtime/pi-compat-capabilities.js", import.meta.url));
  const mockCompatRuntimePath = path.join(tempDir, "pi-runtime-mock.js");
  const mockFsPromisesPath = path.join(tempDir, "fs-promises-mock.js");
  const mockNativeSearchPath = path.join(tempDir, "openai-native-search-mock.js");
  const mockInteractiveSearchOrderPatchPath = path.join(tempDir, "openai-interactive-search-order-patch-mock.js");
  const mockToolExecutionPatchPath = path.join(tempDir, "openai-tool-execution-web-search-patch-mock.js");
  const mockProviderCompatPath = path.join(tempDir, "openai-responses-provider-mock.js");
  const transformedDebugPath = path.join(tempDir, "debug-snapshots.testable.mjs");
  const transformedCoreExtensionPath = path.join(tempDir, "register-openai-search-extension.testable.mjs");
  const transformedCompatBootstrapPath = path.join(tempDir, "compat-bootstrap.testable.mjs");
  const transformedModulePath = path.join(tempDir, "index.testable.mjs");

  fs.writeFileSync(mockFsPromisesPath, fsPromisesLines.join("\n"), "utf8");
  fs.writeFileSync(mockNativeSearchPath, nativeSearchLines.join("\n"), "utf8");
  fs.writeFileSync(
    mockInteractiveSearchOrderPatchPath,
    (
      interactiveSearchOrderPatchLines || [
        'export async function probeInteractiveSearchOrderPatchCapability() {',
        '  return { feature: "interactive-inline", enabled: true, status: "supported", supported: true, diagnostics: [] };',
        '}',
        'export async function registerInteractiveSearchOrderPatch() {}',
      ]
    ).join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    mockToolExecutionPatchPath,
    (
      toolExecutionPatchLines || [
        'export async function probeTruthfulInteractiveWebSearchPatchCapability() {',
        '  return { feature: "tool-render", enabled: true, status: "supported", supported: true, diagnostics: [] };',
        '}',
        'export async function registerTruthfulInteractiveWebSearchPatch() {}',
      ]
    ).join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    mockProviderCompatPath,
    (
      providerCompatLines || [
        'export function buildPatchedOpenAIResponsesProviderConfig() {',
        '  return { api: "openai-responses", marker: "experimental-provider-compat", stream() {}, streamSimple() {} };',
        '}',
        'export async function probeProviderCompatCapability() {',
        '  return { feature: "provider-compat", enabled: true, status: "supported", supported: true, diagnostics: [] };',
        '}',
        'export async function activateProviderCompat(pi) {',
        '  if (typeof pi?.registerProvider === "function") {',
        '    pi.registerProvider("openai", buildPatchedOpenAIResponsesProviderConfig());',
        '    return true;',
        '  }',
        '  return registerOpenAIResponsesDisplayPatch();',
        '}',
        'export function setProviderCompatReadiness() {}',
        'export function registerOpenAIResponsesDisplayPatch() {',
        '  globalThis.__providerCompatFallbackCalls = (globalThis.__providerCompatFallbackCalls || 0) + 1;',
        '}',
      ]
    ).join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    mockCompatRuntimePath,
    [
      'export async function probePiCompatCapabilities() {',
      '  return {',
      '    runtime: { kind: "pi", version: { baseline: "0.65.0", detected: "0.65.0", status: "supported", diagnostics: [] } },',
      '    features: {',
      '      "provider-compat": { feature: "provider-compat", enabled: true, status: "supported", supported: true, diagnostics: [] },',
      '      "interactive-inline": { feature: "interactive-inline", enabled: true, status: "supported", supported: true, diagnostics: [] },',
      '      "tool-render": { feature: "tool-render", enabled: true, status: "supported", supported: true, diagnostics: [] },',
      '    },',
      '    warnings: [],',
      '    diagnostics: [],',
      '    status: "supported",',
      '  };',
      '}',
    ].join("\n"),
    "utf8",
  );

  const transformedDebugSource = fs
    .readFileSync(debugSnapshotsPath, "utf8")
    .replace('"node:fs/promises"', JSON.stringify(pathToFileURL(mockFsPromisesPath).href));
  fs.writeFileSync(transformedDebugPath, transformedDebugSource, "utf8");

  const transformedCoreExtensionSource = fs
    .readFileSync(coreExtensionPath, "utf8")
    .replace('"../payload/native-search.js"', JSON.stringify(pathToFileURL(mockNativeSearchPath).href))
    .replace('"../config/native-search-config.js"', JSON.stringify(pathToFileURL(mockNativeSearchPath).href))
    .replace('"../lifecycle/search-status.js"', JSON.stringify(pathToFileURL(searchDisplayPath).href))
    .replace('"./debug-snapshots.js"', JSON.stringify(pathToFileURL(transformedDebugPath).href));
  fs.writeFileSync(transformedCoreExtensionPath, transformedCoreExtensionSource, "utf8");

  const transformedCompatBootstrapSource = fs
    .readFileSync(compatBootstrapPath, "utf8")
    .replace('"./interactive/search-order-patch.js"', JSON.stringify(pathToFileURL(mockInteractiveSearchOrderPatchPath).href))
    .replace('"./interactive/tool-execution-web-search-patch.js"', JSON.stringify(pathToFileURL(mockToolExecutionPatchPath).href))
    .replace('"./provider/openai-responses-provider.js"', JSON.stringify(pathToFileURL(mockProviderCompatPath).href))
    .replace('"./runtime/pi-runtime.js"', JSON.stringify(pathToFileURL(mockCompatRuntimePath).href))
    .replace('"./runtime/pi-compat-capabilities.js"', JSON.stringify(pathToFileURL(compatCapabilitiesPath).href));
  fs.writeFileSync(transformedCompatBootstrapPath, transformedCompatBootstrapSource, "utf8");

  const transformedSource = fs
    .readFileSync(sourcePath, "utf8")
    .replace('"@earendil-works/pi-tui"', '"data:text/javascript,export class Text {}"')
    .replace(
      '"./src/core/extension/register-openai-search-extension.js"',
      JSON.stringify(pathToFileURL(transformedCoreExtensionPath).href),
    )
    .replace('"./src/compat/bootstrap.js"', JSON.stringify(pathToFileURL(transformedCompatBootstrapPath).href))
    .replace('"./src/compat/provider/cliproxy-search-events.js"', JSON.stringify(new URL("../src/compat/provider/cliproxy-search-events.js", import.meta.url).href))
    .replace('"./src/core/extension/search-entries.js"', JSON.stringify(new URL("../src/core/extension/search-entries.js", import.meta.url).href));

  fs.writeFileSync(transformedModulePath, transformedSource, "utf8");
  return import(pathToFileURL(transformedModulePath).href);
}

async function loadTestableDisplayPatchModule(tempDir) {
  void tempDir;
  const sourcePath = fileURLToPath(new URL("../src/compat/provider/display-patch.js", import.meta.url));
  return import(`${pathToFileURL(sourcePath).href}?t=${Date.now()}`);
}

async function loadTestableProviderModule(tempDir) {
  const sourcePath = fileURLToPath(new URL("../src/compat/provider/openai-responses-provider.js", import.meta.url));
  const compatCapabilitiesPath = fileURLToPath(new URL("../src/compat/runtime/pi-compat-capabilities.js", import.meta.url));
  const mockPiAiPath = path.join(tempDir, "pi-ai-mock.js");
  const mockClientPath = path.join(tempDir, "openai-responses-client-mock.js");
  const mockStreamPath = path.join(tempDir, "openai-responses-stream-mock.js");
  const transformedModulePath = path.join(tempDir, "openai-responses-provider.testable.mjs");

  fs.writeFileSync(
    mockPiAiPath,
    [
      'export function registerApiProvider(provider, sourceId) {',
      '  globalThis.__providerCalls = globalThis.__providerCalls || [];',
      '  globalThis.__providerCalls.push({ provider, sourceId });',
      '}',
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    mockClientPath,
    [
      'export async function loadOpenAIResponsesInternals() {',
      '  return { convertResponsesMessages() {}, convertResponsesTools() {}, OpenAI: class OpenAI {} };',
      '}',
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    mockStreamPath,
    [
      'export function setProviderCompatReadiness() {}',
      'export function streamPatchedOpenAIResponses() {}',
      'export function streamSimplePatchedOpenAIResponses() {}',
    ].join("\n"),
    "utf8",
  );

  const transformedSource = fs
    .readFileSync(sourcePath, "utf8")
    .replace('"../runtime/pi-ai-compat.js"', JSON.stringify(pathToFileURL(mockPiAiPath).href))
    .replace('"./openai-responses-client.js"', JSON.stringify(pathToFileURL(mockClientPath).href))
    .replace('"./openai-responses-stream.js"', JSON.stringify(pathToFileURL(mockStreamPath).href))
    .replace('"../runtime/pi-compat-capabilities.js"', JSON.stringify(pathToFileURL(compatCapabilitiesPath).href));

  fs.writeFileSync(transformedModulePath, transformedSource, "utf8");
  return import(pathToFileURL(transformedModulePath).href);
}

async function loadTestableInteractiveSearchOrderPatchModule(tempDir) {
  const sourcePath = fileURLToPath(new URL("../src/compat/interactive/search-order-patch.js", import.meta.url));
  const searchDisplayPath = fileURLToPath(new URL("../src/core/lifecycle/search-status.js", import.meta.url));
  const compatPath = fileURLToPath(new URL("../src/compat/runtime/pi-runtime.js", import.meta.url));
  const compatCapabilitiesPath = fileURLToPath(new URL("../src/compat/runtime/pi-compat-capabilities.js", import.meta.url));
  const transformedModulePath = path.join(tempDir, "openai-interactive-search-order-patch.testable.mjs");

  const transformedSource = fs
    .readFileSync(sourcePath, "utf8")
    .replace('"../../core/lifecycle/search-status.js"', JSON.stringify(pathToFileURL(searchDisplayPath).href))
    .replace('"../runtime/pi-runtime.js"', JSON.stringify(pathToFileURL(compatPath).href))
    .replace('"../runtime/pi-compat-capabilities.js"', JSON.stringify(pathToFileURL(compatCapabilitiesPath).href));
  fs.writeFileSync(transformedModulePath, transformedSource, "utf8");
  return import(pathToFileURL(transformedModulePath).href);
}

test("isOpenAIResponsesModel accepts supported OpenAI and CLIProxyAPI transports", () => {
  assert.equal(isOpenAIResponsesModel({ provider: "openai", api: "openai-responses" }), true);
  assert.equal(
    isOpenAIResponsesModel({ provider: "openai-codex", api: "openai-codex-responses" }),
    true,
  );
  assert.equal(
    isOpenAIResponsesModel({ provider: "cliproxyapi", api: "cliproxyapi-codex-responses" }),
    true,
  );
  assert.equal(isOpenAIResponsesModel({ provider: "azure", api: "azure-openai-responses" }), false);
  assert.equal(isOpenAIResponsesModel({ provider: "custom", api: "openai-responses" }), false);
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

test("injectNativeWebSearch injects tool and removes exact direct search duplicates", () => {
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

test("injectNativeWebSearch leaves responses-shaped payload without model metadata untouched", () => {
  const payload = {
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [{ type: "function", name: "search-the-web" }],
    include: ["reasoning.encrypted_content"],
  };

  const result = injectNativeWebSearch(payload, undefined, {
    enabled: true,
    mode: "live",
    contextSize: "medium",
  });

  assert.deepEqual(result, payload);
  assert.deepEqual(result.tools, [{ type: "function", name: "search-the-web" }]);
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

test("summarizeSearchInput reads defensive provider query variants", () => {
  assert.deepEqual(
    summarizeSearchInput({
      type: "search",
      search_query: "openai news today",
      search_queries: ["openai news today", "openai blog"],
    }),
    {
      type: "search",
      query: "openai news today",
      queries: ["openai news today", "openai blog"],
    },
  );

  assert.deepEqual(
    summarizeSearchInput({
      type: "search",
      query_text: "latest openai announcements",
    }),
    {
      type: "search",
      query: "latest openai announcements",
    },
  );

  assert.deepEqual(
    summarizeSearchInput({
      type: "search",
      input: {
        query: "openai responses web_search",
        search_queries: ["openai responses web_search", "pi native search"],
      },
    }),
    {
      type: "search",
      query: "openai responses web_search",
      queries: ["openai responses web_search", "pi native search"],
    },
  );
});

test("applyInteractiveSearchOrderPatch rejects incompatible runtime shape", () => {
  assert.throws(
    () =>
      applyInteractiveSearchOrderPatch(
        class {},
        class {},
        class {},
        { Spacer: class {}, Text: class {}, Markdown: class {}, theme: {} },
      ),
    /AssistantMessageComponent/,
  );
});

test("interactive search-order patch keeps native web search inline in chronological order", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-inline-order-test-"));

  try {
    const patchModule = await loadTestableInteractiveSearchOrderPatchModule(tempDir);

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

    class MockSpacer {
      constructor(size) {
        this.kind = "spacer";
        this.size = size;
      }
    }

    class MockText {
      constructor(text) {
        this.kind = "text";
        this.text = text;
      }
    }

    class MockMarkdown {
      constructor(text) {
        this.kind = "markdown";
        this.text = text;
      }
    }

    class MockAssistantMessageComponent {
      constructor(message, hideThinkingBlock = false, markdownTheme = {}, timestampFormat = "iso") {
        this.hideThinkingBlock = hideThinkingBlock;
        this.markdownTheme = markdownTheme;
        this.timestampFormat = timestampFormat;
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
      constructor(toolName, toolCallIdOrArgs, argsOrOptions) {
        this.kind = "tool";
        this.toolName = toolName;
        this.toolCallId =
          typeof toolCallIdOrArgs === "string" ? toolCallIdOrArgs : undefined;
        this.args =
          typeof toolCallIdOrArgs === "string" ? argsOrOptions : toolCallIdOrArgs;
        this.result = undefined;
        this.expanded = false;
      }

      setExpanded(expanded) {
        this.expanded = expanded;
      }

      updateArgs(args) {
        this.args = args;
      }

      updateResult(result) {
        this.result = result;
      }

      setArgsComplete() {
        this.argsComplete = true;
      }
    }

    class MockInteractiveMode {
      constructor() {
        this.ui = { requestRender() {} };
        this.chatContainer = new MockContainer();
        this.pendingTools = new Map();
        this.hideThinkingBlock = false;
        this.toolOutputExpanded = false;
        this.settingsManager = {
          getShowImages() {
            return true;
          },
          getTimestampFormat() {
            return "iso";
          },
        };
        this.session = { retryAttempt: 0 };
        this.footer = { invalidate() {} };
      }

      getMarkdownThemeWithSettings() {
        return {};
      }

      getRegisteredToolDefinition() {
        return undefined;
      }

      formatWebSearchResult(content) {
        if (Array.isArray(content)) {
          return content.map((item) => item.url).join("\n");
        }
        return "complete";
      }

      updateEditorBorderColor() {}

      addMessageToChat(message) {
        if (message.role === "assistant") {
          const component = new MockAssistantMessageComponent(
            message,
            this.hideThinkingBlock,
            this.getMarkdownThemeWithSettings(),
            this.settingsManager.getTimestampFormat(),
          );
          this.chatContainer.addChild(component);
          return;
        }

        this.chatContainer.addChild({ kind: "message", message });
      }

      async handleEvent(event) {
        if (event.type === "message_start" && event.message.role === "assistant") {
          this.streamingComponent = new MockAssistantMessageComponent(
            undefined,
            this.hideThinkingBlock,
            this.getMarkdownThemeWithSettings(),
            this.settingsManager.getTimestampFormat(),
          );
          this.streamingMessage = event.message;
          this.chatContainer.addChild(this.streamingComponent);
          this.streamingComponent.updateContent(this.streamingMessage);
          return;
        }

        if (event.type === "message_end" && event.message.role === "assistant" && this.streamingComponent) {
          this.streamingMessage = event.message;
          this.streamingComponent.updateContent(this.streamingMessage);
          this.streamingComponent = undefined;
          this.streamingMessage = undefined;
        }
      }
    }

    patchModule.applyInteractiveSearchOrderPatch(
      MockAssistantMessageComponent,
      MockToolExecutionComponent,
      MockInteractiveMode,
      {
        Spacer: MockSpacer,
        Text: MockText,
        Markdown: MockMarkdown,
        theme: {
          fg(_name, text) {
            return text;
          },
          italic(text) {
            return text;
          },
        },
        formatTimestamp() {
          return "2026-04-05T00:00:00.000Z";
        },
      },
    );

    const host = new MockInteractiveMode();
    await host.handleEvent({ type: "message_start", message: { role: "assistant", content: [] } });

    const searchingMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first thought" },
        { type: "serverToolUse", id: "ws_1", name: "web_search", input: { type: "search" } },
        { type: "thinking", thinking: "second thought" },
      ],
    };

    await host.handleEvent({ type: "message_update", message: searchingMessage });

    const firstRenderKinds = host.streamingComponent.contentContainer.children.map((child) => child.kind);
    assert.deepEqual(firstRenderKinds, ["spacer", "markdown", "spacer", "tool", "markdown"]);
    assert.equal(host.chatContainer.children.length, 1);

    const partialTool = host.streamingComponent.contentContainer.children.find((child) => child.kind === "tool");
    assert.deepEqual(partialTool.args, { type: "search" });
    assert.equal(partialTool.result, undefined);

    const completedMessage = {
      role: "assistant",
      stopReason: "stop",
      timestamp: 1,
      content: [
        { type: "thinking", thinking: "first thought" },
        {
          type: "serverToolUse",
          id: "ws_1",
          name: "web_search",
          input: { type: "search", query: "openai news" },
        },
        { type: "thinking", thinking: "second thought" },
        {
          type: "webSearchResult",
          toolUseId: "ws_1",
          content: [{ type: "web_search_result", title: "OpenAI", url: "https://openai.com/news" }],
        },
        { type: "text", text: "final answer" },
      ],
    };

    await host.handleEvent({ type: "message_update", message: completedMessage });

    const secondRenderKinds = host.streamingComponent.contentContainer.children.map((child) => child.kind);
    assert.deepEqual(secondRenderKinds, ["spacer", "markdown", "spacer", "tool", "markdown", "spacer", "markdown", "text"]);

    const completedTool = host.streamingComponent.contentContainer.children.find((child) => child.kind === "tool");
    assert.equal(completedTool.args.query, "openai news");
    assert.deepEqual(completedTool.result, {
      content: [{ type: "text", text: "https://openai.com/news" }],
      isError: false,
    });

    const replayHost = new MockInteractiveMode();
    replayHost.addMessageToChat(completedMessage);

    assert.equal(replayHost.chatContainer.children.length, 1);
    const replayAssistant = replayHost.chatContainer.children[0];
    assert.deepEqual(
      replayAssistant.contentContainer.children.map((child) => child.kind),
      ["spacer", "markdown", "spacer", "tool", "markdown", "spacer", "markdown", "text"],
    );

    const failedMessage = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider timeout",
      content: [
        {
          type: "serverToolUse",
          id: "ws_2",
          name: "web_search",
          input: { type: "search" },
        },
      ],
    };

    await host.handleEvent({ type: "message_update", message: failedMessage });
    const failedTool = host.streamingComponent.contentContainer.children.find((child) => child.kind === "tool");
    assert.deepEqual(failedTool.result, {
      content: [{ type: "text", text: "provider timeout" }],
      isError: true,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("interactive search-order patch formats web search result without runtime helper", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-inline-fallback-test-"));

  try {
    const patchModule = await loadTestableInteractiveSearchOrderPatchModule(tempDir);

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
      constructor(toolName, toolCallId, args) {
        this.kind = "tool";
        this.toolName = toolName;
        this.toolCallId = toolCallId;
        this.args = args;
      }

      setExpanded(expanded) {
        this.expanded = expanded;
      }

      updateResult(result) {
        this.result = result;
      }
    }

    class MockInteractiveMode {
      constructor() {
        this.ui = { requestRender() {} };
        this.chatContainer = new MockContainer();
        this.pendingTools = new Map();
        this.hideThinkingBlock = false;
        this.toolOutputExpanded = false;
        this.settingsManager = {
          getShowImages() {
            return true;
          },
        };
        this.footer = { invalidate() {} };
      }

      getMarkdownThemeWithSettings() {
        return {};
      }

      getRegisteredToolDefinition() {
        return undefined;
      }

      updateEditorBorderColor() {}

      addMessageToChat(message) {
        if (message.role === "assistant") {
          this.chatContainer.addChild(new MockAssistantMessageComponent(message));
          return;
        }

        this.chatContainer.addChild({ kind: "message", message });
      }

      async handleEvent() {}
    }

    patchModule.applyInteractiveSearchOrderPatch(
      MockAssistantMessageComponent,
      MockToolExecutionComponent,
      MockInteractiveMode,
      {
        Spacer: class MockSpacer {},
        Text: class MockText {},
        Markdown: class MockMarkdown {},
        theme: {
          fg(_name, text) {
            return text;
          },
          italic(text) {
            return text;
          },
        },
      },
    );

    const host = new MockInteractiveMode();
    const assistantMessage = {
      role: "assistant",
      content: [
        {
          type: "serverToolUse",
          id: "ws_1",
          name: "web_search",
          input: { type: "open_page", url: "https://openai.com/index/openai-acquires-tbpn" },
        },
        {
          type: "webSearchResult",
          toolUseId: "ws_1",
          content: { type: "web_search_tool_result_complete" },
        },
      ],
    };

    host.addMessageToChat(assistantMessage);

    const assistantComponent = host.chatContainer.children[0];
    const toolComponent = assistantComponent.contentContainer.children.find((child) => child.kind === "tool");

    assert.deepEqual(toolComponent.result, {
      content: [{ type: "text", text: "Search complete" }],
      isError: false,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("applyTruthfulInteractiveWebSearchPatch rejects incompatible runtime shape", () => {
  assert.throws(
    () => applyTruthfulInteractiveWebSearchPatch(class {}, { theme: {}, keyHint() {} }),
    /formatToolExecution/,
  );
});

test("interactive web search patch renders truthful labels for pending and done states", async (t) => {
  let runtimeDescriptor;
  try {
    runtimeDescriptor = resolvePiRuntimeDescriptor();
  } catch (error) {
    t.skip(error instanceof Error ? error.message : String(error));
    return;
  }

  await registerTruthfulInteractiveWebSearchPatch();

  void runtimeDescriptor;
  const toolExecutionModule = await importPiRuntimeModule(
    "dist/modes/interactive/components/tool-execution.js",
  );
  const themeModule = await importPiRuntimeModule(
    "dist/modes/interactive/theme/theme.js",
  );
  themeModule.initTheme("default", false);

  const ui = { requestRender() {} };
  const pendingComponent = new toolExecutionModule.ToolExecutionComponent(
    "web_search",
    "call_1",
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
    "call_2",
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
    "call_3",
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

test("formatWebSearchResult formats sources and completion sentinel", () => {
  assert.equal(
    formatWebSearchResult([
      { type: "web_search_result", title: "OpenAI", url: "https://openai.com/" },
      { type: "web_search_result", title: "Docs", url: "https://platform.openai.com/" },
    ]),
    "OpenAI: https://openai.com/\nDocs: https://platform.openai.com/",
  );
  assert.equal(
    formatWebSearchResult({ type: "web_search_tool_result_complete" }),
    "Search complete",
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

test("upsertSearchToolUseBlock emits update when web search query arrives on output_item.done", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-upsert-search-tool-test-"));

  try {
    const patchModule = await loadTestableDisplayPatchModule(tempDir);
  const output = {
    role: "assistant",
    content: [
      {
        type: "serverToolUse",
        id: "ws_1",
        name: "web_search",
        input: { type: "search" },
      },
    ],
  };
  const state = {
    searchCallIds: new Set(["ws_1"]),
    searchToolBlockById: new Map([["ws_1", 0]]),
  };
  const streamEvents = [];
  const stream = {
    push(event) {
      streamEvents.push(event);
    },
  };

  patchModule.upsertSearchToolUseBlock(
    output,
    state,
    {
      type: "web_search_call",
      id: "ws_1",
      action: {
        type: "search",
        query: "openai news",
      },
    },
    stream,
    false,
  );

  assert.deepEqual(output.content[0].input, {
    type: "search",
    query: "openai news",
  });
  assert.equal(streamEvents.length, 1);
  assert.equal(streamEvents[0].type, "server_tool_use");
  assert.equal(streamEvents[0].contentIndex, 0);
  assert.deepEqual(streamEvents[0].partial.content[0], {
    type: "serverToolUse",
    id: "ws_1",
    name: "web_search",
    input: {
      type: "search",
      query: "openai news",
    },
  });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extension bootstrap keeps core hooks and enables provider compat overlay by default", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-provider-test-"));

  try {
    const extensionModule = await loadTestableExtensionModule(tempDir, {
      fsPromisesLines: [
        'export async function mkdir() {}',
        'export async function writeFile() {}',
      ],
      nativeSearchLines: [
        'export function injectNativeWebSearch(payload) { return payload; }',
        'export function isOpenAIResponsesModel() { return true; }',
        'export function loadNativeSearchConfig() { return { enabled: true, mode: "live" }; }',
      ],
    });

    delete globalThis.__providerCompatFallbackCalls;

    const providerRegistrations = [];
    const handlers = new Map();
    extensionModule.default({
      on(event, handler) {
        handlers.set(event, handler);
      },
      registerProvider(name, config) {
        providerRegistrations.push({ name, config });
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(providerRegistrations.length, 1);
    assert.equal(providerRegistrations[0].name, "openai");
    assert.equal(providerRegistrations[0].config.api, "openai-responses");
    assert.equal(providerRegistrations[0].config.marker, "experimental-provider-compat");
    assert.equal(typeof providerRegistrations[0].config.stream, "function");
    assert.equal(typeof providerRegistrations[0].config.streamSimple, "function");
    assert.equal(globalThis.__providerCompatFallbackCalls, undefined);
    assert.equal(typeof handlers.get("model_select"), "function");
    assert.equal(typeof handlers.get("before_provider_request"), "function");
    assert.equal(typeof handlers.get("message_update"), "function");
    assert.equal(typeof handlers.get("message_end"), "function");
  } finally {
    delete globalThis.__providerCompatFallbackCalls;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extension starts provider and ui compat eagerly on bootstrap", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-compat-bootstrap-test-"));

  try {
    delete globalThis.__interactiveCompatCalls;
    delete globalThis.__toolRenderCompatCalls;
    delete globalThis.__providerCompatCalls;

    const extensionModule = await loadTestableExtensionModule(tempDir, {
      fsPromisesLines: [
        "export async function mkdir() {}",
        "export async function writeFile() {}",
      ],
      nativeSearchLines: [
        "export function injectNativeWebSearch(payload) { return payload; }",
        "export function isOpenAIResponsesModel() { return true; }",
        'export function loadNativeSearchConfig() { return { enabled: true, mode: "live" }; }',
      ],
      interactiveSearchOrderPatchLines: [
        "export async function probeInteractiveSearchOrderPatchCapability() {",
        "  return { feature: 'interactive-inline', enabled: true, status: 'supported', supported: true, diagnostics: [] };",
        "}",
        "export async function registerInteractiveSearchOrderPatch() {",
        "  globalThis.__interactiveCompatCalls = (globalThis.__interactiveCompatCalls || 0) + 1;",
        "}",
      ],
      toolExecutionPatchLines: [
        "export async function probeTruthfulInteractiveWebSearchPatchCapability() {",
        "  return { feature: 'tool-render', enabled: true, status: 'supported', supported: true, diagnostics: [] };",
        "}",
        "export async function registerTruthfulInteractiveWebSearchPatch() {",
        "  globalThis.__toolRenderCompatCalls = (globalThis.__toolRenderCompatCalls || 0) + 1;",
        "}",
      ],
      providerCompatLines: [
        "export function buildPatchedOpenAIResponsesProviderConfig() {",
        "  globalThis.__providerCompatCalls = (globalThis.__providerCompatCalls || 0) + 1;",
        "  return { api: 'openai-responses', marker: 'experimental-provider-compat', stream() {}, streamSimple() {} };",
        "}",
        "export async function probeProviderCompatCapability() {",
        "  return { feature: 'provider-compat', enabled: true, status: 'supported', supported: true, diagnostics: [] };",
        "}",
        "export async function activateProviderCompat(pi) {",
        "  registerOpenAIResponsesDisplayPatch();",
        "  pi.registerProvider('openai', buildPatchedOpenAIResponsesProviderConfig());",
        "  return true;",
        "}",
        "export function setProviderCompatReadiness() {}",
        "export function registerOpenAIResponsesDisplayPatch() {}",
      ],
    });

    const handlers = new Map();
    extensionModule.default({
      on(event, handler) {
        handlers.set(event, handler);
      },
      registerProvider() {},
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(globalThis.__providerCompatCalls, 1);
    assert.equal(globalThis.__interactiveCompatCalls, 1);
    assert.equal(globalThis.__toolRenderCompatCalls, 1);

    await handlers.get("model_select")(
      {
        model: { api: "openai-responses", provider: "openai", id: "gpt-5.4" },
      },
      {
        hasUI: true,
        ui: {
          notify() {},
          setStatus() {},
          setWorkingMessage() {},
        },
      },
    );

    assert.equal(globalThis.__interactiveCompatCalls, 1);
    assert.equal(globalThis.__toolRenderCompatCalls, 1);
  } finally {
    delete globalThis.__interactiveCompatCalls;
    delete globalThis.__toolRenderCompatCalls;
    delete globalThis.__providerCompatCalls;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test("extension does not reuse selected model when provider request omits metadata", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-model-fallback-test-"));

  try {
    const extensionModule = await loadTestableExtensionModule(tempDir, {
      fsPromisesLines: [
        'export async function mkdir() {}',
        'export async function writeFile() {}',
      ],
      nativeSearchLines: [
        'export function injectNativeWebSearch(payload, model) {',
        '  return { ...payload, seenModelApi: model?.api, seenProvider: model?.provider, seenModelId: model?.id };',
        '}',
        'export function isOpenAIResponsesModel(model) { return model?.api === "openai-responses"; }',
        'export function loadNativeSearchConfig() { return { enabled: true, mode: "live" }; }',
      ],
    });

    const handlers = new Map();
    extensionModule.default({
      on(event, handler) {
        handlers.set(event, handler);
      },
      registerProvider() {},
    });

    handlers.get("model_select")(
      {
        model: { api: "openai-responses", provider: "openai", id: "gpt-5.4-mini" },
      },
      { hasUI: false },
    );

    const nextPayload = handlers.get("before_provider_request")({
      payload: { tools: [] },
    });

    assert.equal(nextPayload.seenModelApi, undefined);
    assert.equal(nextPayload.seenProvider, undefined);
    assert.equal(nextPayload.seenModelId, undefined);
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

test("encodeReasoningSignature keeps mandatory summary for continuation payload", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-reasoning-signature-test-"));

  try {
    const patchModule = await loadTestableDisplayPatchModule(tempDir);

    assert.deepEqual(
      JSON.parse(
        patchModule.encodeReasoningSignature({
          type: "reasoning",
          id: "rs_test",
          encrypted_content: "encrypted",
        }),
      ),
      {
        type: "reasoning",
        id: "rs_test",
        encrypted_content: "encrypted",
        summary: [],
      },
    );

    assert.deepEqual(
      JSON.parse(
        patchModule.encodeReasoningSignature({
          type: "reasoning",
          id: "rs_test_with_summary",
          encrypted_content: "encrypted",
          summary: [{ type: "summary_text", text: "Краткое резюме" }],
        }),
      ),
      {
        type: "reasoning",
        id: "rs_test_with_summary",
        encrypted_content: "encrypted",
        summary: [{ type: "summary_text", text: "Краткое резюме" }],
      },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildPatchedParams preserves existing include fields and does not inject hidden developer prompt", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-build-params-test-"));

  try {
    const patchModule = await loadTestableDisplayPatchModule(tempDir);
    const params = patchModule.buildPatchedParams(
      {
        id: "gpt-5.4",
        name: "gpt-5.4",
        maxTokens: 64000,
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
      },
      {},
      {},
      {
        convertResponsesMessages() {
          return [{ role: "user", content: [{ type: "input_text", text: "test" }] }];
        },
        convertResponsesTools() {
          return [];
        },
        clampReasoningForModel(_name, effort) {
          return effort;
        },
      },
    );

    assert.deepEqual(params.include, ["reasoning.encrypted_content"]);
    assert.equal(params.input.length, 1);
    assert.equal(params.input[0].role, "user");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("enrichOutputFromCompletedResponse keeps per-call truthfulness and backfills observed search calls only", async () => {
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
        title: "Second source",
        url: "https://example.com/second",
      },
      {
        type: "web_search_result",
        title: "First source duplicate",
        url: "https://example.com/first",
      },
      {
        type: "web_search_result",
        title: "Third result source",
        url: "https://example.com/third",
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

test("registerOpenAIResponsesDisplayPatch is idempotent on repeated calls", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-test-"));

  try {
    delete globalThis.__providerCalls;
    const providerModule = await loadTestableProviderModule(tempDir);
    providerModule.registerOpenAIResponsesDisplayPatch();
    providerModule.registerOpenAIResponsesDisplayPatch();

    assert.equal(globalThis.__providerCalls.length, 1);
    assert.equal(globalThis.__providerCalls[0].provider.api, "openai-responses");
  } finally {
    delete globalThis.__providerCalls;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolvePiRuntimeRoot auto-detects installed standalone pi runtime", (t) => {
  const originalPiBinPath = process.env.PI_BIN_PATH;
  resetPiRuntimeCache();
  delete process.env.PI_BIN_PATH;

  try {
    let root;
    try {
      root = resolvePiRuntimeRoot();
    } catch (error) {
      t.skip(error instanceof Error ? error.message : String(error));
      return;
    }
    assert.equal(fs.existsSync(root), true);
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.match(packageJson.name, /^@(?:earendil-works|mariozechner)\/pi-coding-agent$/);
  } finally {
    resetPiRuntimeCache();
    if (originalPiBinPath == null) {
      delete process.env.PI_BIN_PATH;
    } else {
      process.env.PI_BIN_PATH = originalPiBinPath;
    }
  }
});

test("packaged CLI imports extension without private loader dependencies", async (t) => {
  let runtimeRoot;
  try {
    runtimeRoot = resolvePiRuntimeRoot();
  } catch (error) {
    t.skip(error instanceof Error ? error.message : String(error));
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-cli-load-"));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"));
    const result = spawnSync(process.execPath, [
      path.resolve(runtimeRoot, pkg.bin.pi), "--no-extensions", "-e", path.resolve("index.js"),
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--no-approve", "--list-models",
    ], {
      cwd: tempDir, encoding: "utf8", timeout: 30000,
      env: { ...process.env, PI_CODING_AGENT_DIR: tempDir, PI_OFFLINE: "1",
        PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT: "false", PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT: "false" },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.doesNotMatch(result.stderr + result.stdout, /Failed to load extension|UI compat|Cannot find package/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("proof helper resolves provider api key via standalone pi auth api", async () => {
  const authStorage = {
    async getApiKey(provider) {
      assert.equal(provider, "openai");
      return "pi-api-key";
    },
  };

  const apiKey = await resolveProviderApiKey(authStorage, "openai");

  assert.equal(apiKey, "pi-api-key");
});

test("proof helper resolves provider api key via credential-based auth api", async () => {
  const authStorage = {
    getCredentialsForProvider(provider) {
      assert.equal(provider, "openai");
      return [undefined, { slot: "secondary" }, { slot: "primary" }];
    },
    async resolveCredentialApiKey(provider, credential) {
      assert.equal(provider, "openai");
      assert.deepEqual(credential, { slot: "secondary" });
      return "legacy-api-key";
    },
  };

  const apiKey = await resolveProviderApiKey(authStorage, "openai");

  assert.equal(apiKey, "legacy-api-key");
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

test("raw proof classification passes scenario A with inline source URLs even without structured seams", () => {
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

  assert.equal(result.verdict, "pass");
  assert.match(result.reason, /inline source URLs|output_text/);
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

test("raw proof classification passes scenario A with opportunistic results seam", () => {
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

  assert.equal(result.verdict, "pass");
  assert.match(result.reason, /opportunistic result sources/);
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

test("verifier classification marks sentinel-only scenario A as blocker when no URLs survive", () => {
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
  assert.equal(result.summary.streamSearchEventMode, "stream_events");
  assert.equal(result.summary.finalServerToolUseCount, 1);
  assert.equal(result.summary.finalWebSearchResultCount, 1);
  assert.equal(result.summary.resultBlockCount, 1);
  assert.equal(result.summary.sentinelCount, 1);
});

test("verifier classification accepts final-only factual blocks in no-session JSON mode", () => {
  const result = classifyVerifierJsonl(
    parseJsonlEvents(
      [
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 4,
            partial: {
              role: "assistant",
              content: [],
            },
            delta: "- OpenAI news: https://openai.com/index/openai-acquires-tbpn",
          },
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "serverToolUse", id: "ws_1", name: "web_search", input: { query: "openai news" } },
              { type: "webSearchResult", toolUseId: "ws_1", content: { type: "web_search_tool_result_complete" } },
              { type: "text", text: "- OpenAI news: https://openai.com/index/openai-acquires-tbpn" },
            ],
          },
        }),
      ].join("\n"),
    ),
    "A",
  );

  assert.equal(result.verdict, "pass");
  assert.match(result.reason, /inline|message_end/);
  assert.equal(result.summary.serverToolEventCount, 0);
  assert.equal(result.summary.webSearchResultEventCount, 0);
  assert.equal(result.summary.streamSearchEventMode, "final_message_only");
  assert.equal(result.summary.finalServerToolUseCount, 1);
  assert.equal(result.summary.finalWebSearchResultCount, 1);
  assert.equal(result.summary.inlineSourceCount, 1);
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
    const childScript = String.raw`
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const piBinPath = process.env.PI_BIN_PATH;
const runtimeRoot = path.resolve(path.dirname(piBinPath), "..", "lib", "node_modules", "@mariozechner", "pi-coding-agent");
const tempDir = fs.mkdtempSync(path.join(repoRoot, ".tmp-pi-openai-search-live-"));
const sessionDir = path.join(tempDir, "sessions");
const agentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

const { DefaultResourceLoader } = await import(pathToFileURL(path.join(runtimeRoot, "dist/core/resource-loader.js")).href);
const { SettingsManager } = await import(pathToFileURL(path.join(runtimeRoot, "dist/core/settings-manager.js")).href);
const { AuthStorage } = await import(pathToFileURL(path.join(runtimeRoot, "dist/core/auth-storage.js")).href);
const { ModelRegistry } = await import(pathToFileURL(path.join(runtimeRoot, "dist/core/model-registry.js")).href);
const { SessionManager } = await import(pathToFileURL(path.join(runtimeRoot, "dist/core/session-manager.js")).href);
const { createAgentSession } = await import(pathToFileURL(path.join(runtimeRoot, "dist/core/sdk.js")).href);

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
        PI_BIN_PATH: process.env.PI_BIN_PATH || spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).stdout.trim(),
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

test("async extension startup keeps core and public UI when optional compat rejects", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-compat-rejection-"));
  try {
    const extension = await loadTestableExtensionModule(tempDir, {
      fsPromisesLines: ['export async function mkdir() {}', 'export async function writeFile() {}'],
      nativeSearchLines: [
        'export function injectNativeWebSearch(payload) { return payload; }',
        'export function isOpenAIResponsesModel() { return true; }',
        'export function loadNativeSearchConfig() { return { enabled: true, mode: "live" }; }',
      ],
      providerCompatLines: [
        'export function setProviderCompatReadiness() {}',
        'export async function probeProviderCompatCapability() {}',
        'export async function activateProviderCompat() { throw new Error("fixture compat failure"); }',
      ],
    });
    const handlers = new Map();
    const notifications = [];
    await extension.default({
      on: (name, handler) => handlers.set(name, handler),
      registerEntryRenderer() {}, appendEntry() {},
    });
    assert.equal(typeof handlers.get("before_provider_request"), "function");
    assert.equal(typeof handlers.get("turn_end"), "function");
    await handlers.get("model_select")({ model: { provider: "openai", id: "fixture" } }, {
      hasUI: true, ui: { setWorkingMessage() {}, setStatus() {}, notify: (text) => notifications.push(text) },
    });
    assert.ok(notifications.some((text) => text.includes("fixture compat failure")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
