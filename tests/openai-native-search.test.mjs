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
  resolveWebSearchResultSources,
} from "../src/openai-search-display.js";

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
  assert.deepEqual(result.include, ["web_search_call.action.sources"]);
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

test("ensureNativeSearchIncludes preserves existing include fields", () => {
  const payload = {
    include: ["reasoning.encrypted_content"],
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

test("resolveWebSearchResultSources falls back to annotations when action sources are empty", () => {
  const result = resolveWebSearchResultSources(
    [],
    [{ title: "OpenAI blog", url: "https://openai.com/index/openai-acquires-tbpn" }],
    [{ title: "Fallback", url: "https://example.com/fallback" }],
  );

  assert.deepEqual(result, [
    { title: "OpenAI blog", url: "https://openai.com/index/openai-acquires-tbpn" },
  ]);
  assert.deepEqual(buildWebSearchResultContent(result), [
    {
      type: "web_search_result",
      title: "OpenAI blog",
      url: "https://openai.com/index/openai-acquires-tbpn",
    },
  ]);
});

test("resolveWebSearchResultSources keeps action sources ahead of annotation fallback", () => {
  const result = resolveWebSearchResultSources(
    [{ title: "Action source", url: "https://example.com/action" }],
    [{ title: "Annotation source", url: "https://example.com/annotation" }],
    [{ title: "Fallback source", url: "https://example.com/fallback" }],
  );

  assert.deepEqual(result, [
    { title: "Action source", url: "https://example.com/action" },
  ]);
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
});

test("extension updates TUI status for native web search lifecycle", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-ui-test-"));

  try {
    const sourcePath = fileURLToPath(new URL("../index.js", import.meta.url));
    const mockFsPromisesPath = path.join(tempDir, "fs-promises-mock.js");
    const mockNativeSearchPath = path.join(tempDir, "openai-native-search-mock.js");
    const mockDisplayPatchPath = path.join(tempDir, "openai-responses-display-patch-mock.js");
    const transformedModulePath = path.join(tempDir, "index-ui.testable.mjs");

    fs.writeFileSync(
      mockFsPromisesPath,
      [
        'export async function mkdir() {}',
        'export async function writeFile() {}',
      ].join("\n"),
      "utf8",
    );

    fs.writeFileSync(
      mockNativeSearchPath,
      [
        'export function injectNativeWebSearch(payload) {',
        '  return { ...payload, tools: [{ type: "web_search", external_web_access: true }] };',
        '}',
        'export function isOpenAIResponsesModel() { return true; }',
        'export function loadNativeSearchConfig() { return { enabled: true, mode: "live" }; }',
      ].join("\n"),
      "utf8",
    );

    fs.writeFileSync(
      mockDisplayPatchPath,
      ['export function registerOpenAIResponsesDisplayPatch() {}'].join("\n"),
      "utf8",
    );

    const originalSource = fs.readFileSync(sourcePath, "utf8");
    const transformedSource = originalSource
      .replace('"node:fs/promises"', JSON.stringify(pathToFileURL(mockFsPromisesPath).href))
      .replace('"./src/openai-native-search.js"', JSON.stringify(pathToFileURL(mockNativeSearchPath).href))
      .replace(
        '"./src/openai-responses-display-patch.js"',
        JSON.stringify(pathToFileURL(mockDisplayPatchPath).href),
      );

    fs.writeFileSync(transformedModulePath, transformedSource, "utf8");
    const extensionModule = await import(pathToFileURL(transformedModulePath).href);

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
    assert.deepEqual(workingCalls, ["Native web search in progress..."]);
    assert.deepEqual(statusCalls, [["openai-native-web-search", "web: searching"]]);

    await handlers.get("message_end")(
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Sources: https://nodejs.org/en/download and https://nodejs.org/en/blog/release/v24.14.1.",
            },
          ],
        },
      },
      ctx,
    );

    assert.deepEqual(workingCalls, ["Native web search in progress...", undefined]);
    assert.deepEqual(statusCalls, [
      ["openai-native-web-search", "web: searching"],
      ["openai-native-web-search", "web: 2 sources"],
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("debug snapshot write failures do not escape extension handlers", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-openai-search-index-test-"));

  try {
    const sourcePath = fileURLToPath(new URL("../index.js", import.meta.url));
    const mockFsPromisesPath = path.join(tempDir, "fs-promises-mock.js");
    const mockNativeSearchPath = path.join(tempDir, "openai-native-search-mock.js");
    const mockDisplayPatchPath = path.join(tempDir, "openai-responses-display-patch-mock.js");
    const transformedModulePath = path.join(tempDir, "index.testable.mjs");

    fs.writeFileSync(
      mockFsPromisesPath,
      [
        'export async function mkdir() {}',
        'export async function writeFile() { throw new Error("debug write failed"); }',
      ].join("\n"),
      "utf8",
    );

    fs.writeFileSync(
      mockNativeSearchPath,
      [
        'export function injectNativeWebSearch(payload) { return { ...payload, injected: true }; }',
        'export function isOpenAIResponsesModel() { return true; }',
        'export function loadNativeSearchConfig() { return { enabled: true, mode: "live" }; }',
      ].join("\n"),
      "utf8",
    );

    fs.writeFileSync(
      mockDisplayPatchPath,
      ['export function registerOpenAIResponsesDisplayPatch() {}'].join("\n"),
      "utf8",
    );

    const originalSource = fs.readFileSync(sourcePath, "utf8");
    const transformedSource = originalSource
      .replace('"node:fs/promises"', JSON.stringify(pathToFileURL(mockFsPromisesPath).href))
      .replace('"./src/openai-native-search.js"', JSON.stringify(pathToFileURL(mockNativeSearchPath).href))
      .replace(
        '"./src/openai-responses-display-patch.js"',
        JSON.stringify(pathToFileURL(mockDisplayPatchPath).href),
      );

    fs.writeFileSync(transformedModulePath, transformedSource, "utf8");
    const extensionModule = await import(pathToFileURL(transformedModulePath).href);

    const handlers = new Map();
    extensionModule.default({
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    assert.equal(typeof handlers.get("before_provider_request"), "function");
    assert.equal(typeof handlers.get("message_end"), "function");

    process.env.PI_OPENAI_NATIVE_SEARCH_DEBUG_FILE = path.join(tempDir, "payload.json");
    process.env.PI_OPENAI_NATIVE_SEARCH_DEBUG_MESSAGE_FILE = path.join(tempDir, "message.json");

    assert.doesNotThrow(() => {
      handlers.get("before_provider_request")({
        payload: { tools: [] },
        model: { api: "openai-responses", provider: "openai" },
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
