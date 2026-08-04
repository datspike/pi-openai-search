import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWebSearchTool,
  ensureNativeSearchIncludes,
  injectNativeWebSearch,
  isDirectSearchToolDuplicate,
} from "../../src/core/payload/native-search.js";

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

test("injectNativeWebSearch removes only exact direct native duplicates", () => {
  const payload = {
    model: "gpt-5.6",
    tools: [
      { type: "function", name: "read" },
      { type: "function", name: "search-the-web" },
      { type: "function", name: "search_and_read" },
      { type: "function", name: "google_search" },
      { type: "function", name: "bx" },
      { type: "function", name: "mcp" },
      { type: "function", name: "brave_web_search" },
      { type: "hosted", name: "search-the-web" },
      { type: "web_search_preview" },
      { type: "web_search_preview_2025_03_11" },
      { type: "web_search", external_web_access: false },
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
    { type: "function", name: "bx" },
    { type: "function", name: "mcp" },
    { type: "function", name: "brave_web_search" },
    { type: "hosted", name: "search-the-web" },
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

test("isDirectSearchToolDuplicate accepts exact native function and tool types", () => {
  assert.equal(isDirectSearchToolDuplicate({ type: "function", name: "search_and_read" }), true);
  assert.equal(isDirectSearchToolDuplicate({ type: "function", name: "google_search" }), true);
  assert.equal(isDirectSearchToolDuplicate({ type: "web_search_preview" }), true);
  assert.equal(isDirectSearchToolDuplicate({ type: "web_search_preview_2025_03_11" }), true);
  assert.equal(isDirectSearchToolDuplicate({ type: "web_search" }), true);
  assert.equal(isDirectSearchToolDuplicate({ type: "function", name: "bx" }), false);
  assert.equal(isDirectSearchToolDuplicate({ type: "function", name: "brave_web_search" }), false);
  assert.equal(isDirectSearchToolDuplicate({ type: "hosted", name: "search-the-web" }), false);
});

test("injectNativeWebSearch is idempotent and preserves explicit tool settings", () => {
  const payload = {
    include: ["reasoning.encrypted_content", "reasoning.encrypted_content"],
    tools: [{ type: "function", name: "read" }],
    tool_choice: { type: "function", name: "read" },
    parallel_tool_calls: false,
  };
  const model = { api: "openai-responses", provider: "openai", id: "gpt-5.6" };
  const config = { enabled: true, mode: "live" };

  const once = injectNativeWebSearch(payload, model, config);
  const twice = injectNativeWebSearch(once, model, config);

  assert.deepEqual(twice, once);
  assert.deepEqual(twice.include, ["reasoning.encrypted_content", "web_search_call.action.sources"]);
  assert.deepEqual(twice.tool_choice, { type: "function", name: "read" });
  assert.equal(twice.parallel_tool_calls, false);
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

test("injectNativeWebSearch leaves responses-shaped payload without model metadata untouched", () => {
  const payload = {
    input: [],
    tools: [{ type: "function", name: "search-the-web" }],
  };

  const result = injectNativeWebSearch(payload, undefined, { enabled: true, mode: "live" });

  assert.deepEqual(result, payload);
  assert.deepEqual(result.tools, [{ type: "function", name: "search-the-web" }]);
});

test("injectNativeWebSearch supports OpenAI Codex", () => {
  const payload = { tools: [{ type: "function", name: "read" }] };
  const result = injectNativeWebSearch(
    payload,
    { provider: "openai-codex", api: "openai-codex-responses" },
    { enabled: true, mode: "cached" },
  );

  assert.deepEqual(result.tools, [
    { type: "function", name: "read" },
    { type: "web_search", external_web_access: false },
  ]);
});
