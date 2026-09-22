import test from "node:test";
import assert from "node:assert/strict";

import {
  registerSearchProviderContextSanitizer,
  sanitizeSearchProviderMessages,
} from "../../src/compat/provider/provider-context.js";

const text = { type: "text", text: "Search findings are preserved." };
const toolCall = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } };
const serverToolUse = { type: "serverToolUse", id: "ws-1", name: "web_search", input: { type: "search", query: "Pi context" } };
const searchResult = { type: "webSearchResult", toolUseId: "ws-1", content: { type: "web_search_tool_result_complete" } };
const assistant = { role: "assistant", content: [text, serverToolUse, searchResult, toolCall] };

// Mirrors the legacy Pi estimator that caused the regression. It accepts only
// text, thinking, and toolCall assistant blocks.
function legacyEstimate(messages) {
  return messages.reduce((total, message) => total + message.content.reduce((chars, block) => {
    if (block.type === "text") return chars + block.text.length;
    if (block.type === "thinking") return chars + block.thinking.length;
    return chars + block.name.length + JSON.stringify(block.arguments).length;
  }, 0), 0);
}

test("completed search leaves a factual trace while display blocks stay only in transcript", () => {
  const source = [assistant, { role: "user", content: [{ type: "text", text: "Continue." }] }];
  assert.throws(() => legacyEstimate(source), /undefined/);
  const result = sanitizeSearchProviderMessages(source);
  assert.equal(result.changed, true);
  assert.deepEqual(result.messages[0].content, [text, { type: "text", text: "Web search completed successfully." }, toolCall]);
  assert.deepEqual(source[0].content, [text, serverToolUse, searchResult, toolCall]);
  assert.doesNotThrow(() => legacyEstimate(result.messages));
});

test("only observed successful page opens get a URL trace; failed searches leave none", () => {
  const page = { ...serverToolUse, input: { type: "open_page", url: "https://pi.dev/news/releases/0.87.0" } };
  assert.deepEqual(sanitizeSearchProviderMessages([{ role: "assistant", content: [page, searchResult] }]).messages[0].content,
    [{ type: "text", text: "Web search opened https://pi.dev/news/releases/0.87.0 successfully." }]);
  assert.deepEqual(sanitizeSearchProviderMessages([{ role: "assistant", content: [page] }]).messages[0].content, []);
});

test("context handler returns no rewrite when no search display blocks exist", () => {
  let handler;
  registerSearchProviderContextSanitizer({ on(name, fn) { assert.equal(name, "context"); handler = fn; } });
  assert.equal(handler({ messages: [{ role: "assistant", content: [text, toolCall] }] }), undefined);
});

test("context handler rewrites both native search projection block types", () => {
  let handler;
  registerSearchProviderContextSanitizer({ on(_name, fn) { handler = fn; } });
  const event = { messages: [assistant] };
  const result = handler(event);
  assert.deepEqual(result.messages, [{ role: "assistant", content: [text, { type: "text", text: "Web search completed successfully." }, toolCall] }]);
  assert.deepEqual(event.messages, [assistant]);
});
