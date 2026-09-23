import test from "node:test";
import assert from "node:assert/strict";

import {
  enrichOutputFromCompletedResponse,
  processResponsesStreamWithSearchDisplay,
} from "../../src/compat/provider/openai-responses-search-mapper.js";

import { collectNativeSearchEntries } from "../../src/core/extension/search-entries.js";

function createOutput() {
  return {
    role: "assistant",
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
  };
}

function createStream() {
  const events = [];
  return { events, push(event) { events.push(event); } };
}

const helpers = {
  applyServiceTierPricing() {},
  mapStopReason() { return "stop"; },
};

test("mapper keeps interleaved observed web search calls correlated by id", async () => {
  const output = createOutput();
  const stream = createStream();
  const events = [
    { type: "response.output_item.added", item: { type: "web_search_call", id: "search_A", action: { type: "search", query: "alpha" } } },
    { type: "response.output_item.added", item: { type: "web_search_call", id: "search_B", action: { type: "search", query: "beta" } } },
    { type: "response.output_item.done", item: { type: "web_search_call", id: "search_A", action: { type: "search", query: "alpha" }, results: [{ title: "A", url: "https://example.com/a" }] } },
    { type: "response.output_item.done", item: { type: "web_search_call", id: "search_B", action: { type: "search", query: "beta" }, results: [{ title: "B", url: "https://example.com/b" }] } },
  ];

  await processResponsesStreamWithSearchDisplay(events, output, stream, {}, {}, helpers);

  assert.deepEqual(output.content.filter((block) => block.type === "serverToolUse"), [
    { type: "serverToolUse", id: "search_A", name: "web_search", input: { type: "search", query: "alpha" } },
    { type: "serverToolUse", id: "search_B", name: "web_search", input: { type: "search", query: "beta" } },
  ]);
  assert.deepEqual(output.content.filter((block) => block.type === "webSearchResult"), [
    { type: "webSearchResult", toolUseId: "search_A", content: [{ type: "web_search_result", title: "A", url: "https://example.com/a" }] },
    { type: "webSearchResult", toolUseId: "search_B", content: [{ type: "web_search_result", title: "B", url: "https://example.com/b" }] },
  ]);
});

test("mapper deduplicates repeated calls and ignores missing ids", async () => {
  const output = createOutput();
  const stream = createStream();
  const events = [
    { type: "response.output_item.added", item: { type: "web_search_call", id: "search_A", action: { type: "search" } } },
    { type: "response.output_item.added", item: { type: "web_search_call", id: "search_A", action: { type: "search" } } },
    { type: "response.output_item.done", item: { type: "web_search_call", id: "search_A", action: { type: "search", query: "alpha" } } },
    { type: "response.output_item.done", item: { type: "web_search_call", action: { type: "search", query: "ignored" } } },
  ];

  await processResponsesStreamWithSearchDisplay(events, output, stream, {}, {}, helpers);

  assert.equal(output.content.filter((block) => block.type === "serverToolUse").length, 1);
  assert.equal(output.content.filter((block) => block.type === "webSearchResult").length, 1);
  assert.deepEqual(output.content[0].input, { type: "search", query: "alpha" });
});

test("completed empty data does not erase an observed result or create synthetic calls", () => {
  const output = createOutput();
  const stream = createStream();
  const state = {
    messageBlockByItemId: new Map(),
    searchCallIds: new Set(["search_A"]),
    searchToolBlockById: new Map([["search_A", 0]]),
    searchResultBlockById: new Map([["search_A", 1]]),
  };
  output.content.push(
    { type: "serverToolUse", id: "search_A", name: "web_search", input: { type: "search", query: "alpha" } },
    { type: "webSearchResult", toolUseId: "search_A", content: [{ type: "web_search_result", title: "A", url: "https://example.com/a" }] },
  );

  enrichOutputFromCompletedResponse(output, { output: [
    { type: "web_search_call", id: "search_A", action: {}, results: [] },
    { type: "web_search_call", action: { type: "search", query: "ignored" } },
  ] }, state, stream);

  assert.deepEqual(output.content[0].input, { type: "search", query: "alpha" });
  assert.deepEqual(output.content[1].content, [{ type: "web_search_result", title: "A", url: "https://example.com/a" }]);
  assert.equal(output.content.length, 2);
});

test("completed interleaved calls keep structured sources isolated by call id", () => {
  const output = createOutput();
  const stream = createStream();
  const state = {
    messageBlockByItemId: new Map(),
    searchCallIds: new Set(),
    searchToolBlockById: new Map(),
    searchResultBlockById: new Map(),
  };

  enrichOutputFromCompletedResponse(output, { output: [
    {
      type: "web_search_call",
      id: "search_A",
      action: { type: "search", query: "alpha", sources: [{ title: "A", url: "https://example.com/a" }] },
    },
    {
      type: "web_search_call",
      id: "search_B",
      action: { type: "search", query: "beta", sources: [{ title: "B", url: "https://example.com/b" }] },
    },
  ] }, state, stream);

  assert.deepEqual(output.content
    .filter((block) => block.type === "webSearchResult")
    .map((block) => [block.toolUseId, block.content]), [
    ["search_A", [{ type: "web_search_result", title: "A", url: "https://example.com/a" }]],
    ["search_B", [{ type: "web_search_result", title: "B", url: "https://example.com/b" }]],
  ]);
});

test("failed search status is preserved from output_item.done and the final response", async () => {
  const output = createOutput();
  const stream = createStream();
  const call = { type: "web_search_call", id: "search_failed", status: "failed",
    action: { type: "search", query: "alpha" }, error: { message: "Provider search failed" } };
  await processResponsesStreamWithSearchDisplay([
    { type: "response.output_item.added", item: { ...call, status: "in_progress", error: undefined } },
    { type: "response.output_item.done", item: call },
    { type: "response.completed", response: { status: "completed", output: [call] } },
  ], output, stream, {}, {}, helpers);

  assert.deepEqual(output.content.filter((block) => block.type === "webSearchResult"), [{
    type: "webSearchResult", toolUseId: "search_failed",
    content: { type: "web_search_tool_result_error", message: "Provider search failed" },
  }]);
  assert.equal(stream.events.filter((event) => event.type === "web_search_result").length, 1);
});

test("final failed status overrides a prior source-less completion without touching other calls", async () => {
  const output = createOutput();
  const stream = createStream();
  const events = [
    { type: "response.output_item.done", item: { type: "web_search_call", id: "search_failed", status: "completed", action: { type: "search", query: "alpha" } } },
    { type: "response.output_item.done", item: { type: "web_search_call", id: "search_ok", status: "completed", action: { type: "search", query: "beta", sources: [{ title: "B", url: "https://example.com/b" }] } } },
    { type: "response.completed", response: { status: "completed", output: [
      { type: "web_search_call", id: "search_failed", status: "failed", error: { message: "Search timed out" }, action: { type: "search", query: "alpha" } },
      { type: "web_search_call", id: "search_ok", status: "completed", action: { type: "search", query: "beta" } },
    ] } },
  ];
  await processResponsesStreamWithSearchDisplay(events, output, stream, {}, {}, helpers);

  assert.deepEqual(output.content.filter((block) => block.type === "webSearchResult"), [
    { type: "webSearchResult", toolUseId: "search_failed", content: { type: "web_search_tool_result_error", message: "Search timed out" } },
    { type: "webSearchResult", toolUseId: "search_ok", content: [{ type: "web_search_result", title: "B", url: "https://example.com/b" }] },
  ]);
  assert.equal(stream.events.filter((event) => event.type === "web_search_result").length, 3);
});

test("a completed search without structured sources stays distinct from a failed search", async () => {
  const output = createOutput();
  const stream = createStream();
  await processResponsesStreamWithSearchDisplay([
    { type: "response.output_item.done", item: { type: "web_search_call", id: "search_empty", status: "completed", action: { type: "search", query: "alpha" } } },
    { type: "response.output_item.done", item: { type: "web_search_call", id: "search_failed", status: "failed", action: { type: "search", query: "beta" } } },
  ], output, stream, {}, {}, helpers);
  assert.deepEqual(output.content.filter((block) => block.type === "webSearchResult"), [
    { type: "webSearchResult", toolUseId: "search_empty", content: { type: "web_search_tool_result_complete" } },
    { type: "webSearchResult", toolUseId: "search_failed", content: { type: "web_search_tool_result_error", message: "Web search failed" } },
  ]);
});

test("a failed call present only in response.completed produces an error card", async () => {
  const output = createOutput();
  Object.assign(output, { provider: "openai", api: "openai-responses", stopReason: "stop" });
  await processResponsesStreamWithSearchDisplay([
    { type: "response.completed", response: { status: "completed", output: [
      { type: "web_search_call", id: "search_failed", status: "failed", action: { type: "search", query: "alpha" }, error: { message: "Search timed out" } },
    ] } },
  ], output, createStream(), {}, {}, helpers);
  assert.deepEqual(collectNativeSearchEntries(output).map(({ label, output: text, isError }) => ({ label, text, isError })), [
    { label: "Web search failed", text: "Search timed out", isError: true },
  ]);
});

test("a completed source-less call never claims verified sources or an error", async () => {
  const output = createOutput();
  Object.assign(output, { provider: "openai", api: "openai-responses", stopReason: "stop" });
  await processResponsesStreamWithSearchDisplay([
    { type: "response.output_item.done", item: { type: "web_search_call", id: "search_empty", status: "completed", action: { type: "search", query: "alpha" } } },
  ], output, createStream(), {}, {}, helpers);
  assert.deepEqual(collectNativeSearchEntries(output).map(({ label, output: text, isError }) => ({ label, text, isError })), [
    { label: "Searched alpha (no structured sources)", text: "No structured search sources available", isError: false },
  ]);
});
