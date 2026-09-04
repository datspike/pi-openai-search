import test from "node:test";
import assert from "node:assert/strict";
import {
  collectNativeSearchEntries,
  NATIVE_SEARCH_ENTRY_TYPE,
  registerNativeSearchEntries,
  renderNativeSearchEntry,
} from "../../src/core/extension/search-entries.js";

const call = { type: "serverToolUse", name: "web_search", id: "ws_1", input: { query: "actual provider query" } };
const result = { type: "webSearchResult", toolUseId: "ws_1", content: [
  { type: "web_search_result", title: "Observed source", url: "https://example.com/source" },
] };
const message = (content, extra = {}) => ({ role: "assistant", provider: "openai", api: "openai-responses", content, stopReason: "stop", ...extra });
class Text { constructor(text) { this.text = text; } render() { return this.text.split("\n"); } }
class Box { constructor(_x, _y, bg) { this.children = []; this.bg = bg; } addChild(child) { this.children.push(child); } render(width) { return this.children.flatMap((child) => child.render(width)).map(this.bg); } }
class VStack { constructor(children) { this.children = children; } render(width) { return this.children.flatMap((child) => child.render(width)); } }
const components = { Box, Text, VStack };
const theme = { fg: (_color, text) => text, bg: (_color, text) => `[card]${text}[/card]`, bold: (text) => text };

test("public entries contain only observed calls with matching results", () => {
  const input = message([call, { ...result, toolUseId: "unrelated" }, result]);
  const before = structuredClone(input);
  assert.deepEqual(collectNativeSearchEntries(input), [{
    id: "ws_1", label: "Searched actual provider query", output: "Observed source: https://example.com/source", isError: false,
  }]);
  assert.deepEqual(input, before);
  assert.equal(collectNativeSearchEntries(message([call, call, result])).length, 1);
  assert.deepEqual(collectNativeSearchEntries(message([{ type: "text", text: "I searched https://example.com" }])), []);
  assert.deepEqual(collectNativeSearchEntries(message([result])), []);
  assert.deepEqual(collectNativeSearchEntries(message([call, result], { provider: "anthropic" })), []);
  assert.deepEqual(collectNativeSearchEntries({ role: "user", content: [call, result] }), []);
});

test("public entries preserve supported routes, source-less completion and interruption", () => {
  for (const [provider, api] of [["openai-codex", "openai-codex-responses"], ["cliproxyapi", "cliproxyapi-codex-responses"]]) {
    assert.equal(collectNativeSearchEntries(message([call, result], { provider, api })).length, 1);
  }
  const done = collectNativeSearchEntries(message([{ ...call, input: {} }, { ...result, content: { type: "web_search_tool_result_complete" } }]))[0];
  assert.equal(done.label, "Searched the web");
  assert.equal(done.output, "Search complete");
  const failed = collectNativeSearchEntries(message([call, { ...result, content: { type: "web_search_tool_result_error", message: "Rate limited" } }]))[0];
  assert.equal(failed.label, "Web search failed");
  assert.equal(failed.output, "Rate limited");
  assert.equal(failed.isError, true);
  const aborted = collectNativeSearchEntries(message([call], { stopReason: "aborted" }))[0];
  assert.equal(aborted.label, "Web search interrupted");
  assert.equal(aborted.isError, true);
  assert.equal(aborted.output, "");
  assert.equal(collectNativeSearchEntries(message([call]))[0].label, "Web search: result unavailable");
  assert.equal(collectNativeSearchEntries(message([call, { ...result, content: {} }]))[0].label, "Web search: result unavailable");
});

test("entry renderer creates separate visual cards, expands details and removes terminal controls", () => {
  const entry = { data: { searches: [{ label: "Searched\x1b[31m test", output: Array.from({ length: 15 }, (_, i) => `source ${i}`).join("\n") }] } };
  const collapsed = renderNativeSearchEntry(entry, { expanded: false }, theme, components).render(100).join("\n");
  const expanded = renderNativeSearchEntry(JSON.parse(JSON.stringify(entry)), { expanded: true }, theme, components).render(100).join("\n");
  assert.match(collapsed, /\[card\]⌕ Web search/);
  assert.match(collapsed, /Searched test/);
  assert.doesNotMatch(collapsed, /source 0|\x1b/);
  assert.match(expanded, /source 14/);
  assert.doesNotMatch(expanded, /\x1b/);
});

test("turn_end appends one TUI-only entry per message and keeps negative path empty", () => {
  const handlers = new Map();
  const entries = [];
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerEntryRenderer: (type, renderer) => { assert.equal(type, NATIVE_SEARCH_ENTRY_TYPE); assert.equal(typeof renderer, "function"); },
    appendEntry: (customType, data) => entries.push({ customType, data }),
  };
  registerNativeSearchEntries(pi, components);
  assert.deepEqual([...handlers.keys()], ["turn_end"]);
  handlers.get("turn_end")({ message: message([call, result]) });
  assert.equal(entries.length, 1);
  handlers.get("turn_end")({ message: message([{ type: "text", text: "No search" }]) });
  assert.equal(entries.length, 1);
  const original = process.env.PI_OPENAI_NATIVE_SEARCH;
  try {
    process.env.PI_OPENAI_NATIVE_SEARCH = "false";
    handlers.get("turn_end")({ message: message([call, result]) });
    assert.equal(entries.length, 1);
  } finally {
    if (original === undefined) delete process.env.PI_OPENAI_NATIVE_SEARCH;
    else process.env.PI_OPENAI_NATIVE_SEARCH = original;
  }
});
