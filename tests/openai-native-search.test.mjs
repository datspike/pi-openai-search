import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildWebSearchTool,
  ensureNativeSearchIncludes,
  injectNativeWebSearch,
  isOpenAIResponsesModel,
  loadNativeSearchConfig,
} from "../src/openai-native-search.js";
import { appendStructuredCitations } from "../src/openai-search-display.js";

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

test("registerOpenAIResponsesDisplayPatch re-registers provider on repeated calls", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-openai-search-test-"));

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
