import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerCliproxySearchEvents, CLIPROXY_RESPONSE_EVENT } from "../../src/compat/provider/cliproxy-search-events.js";
import { collectNativeSearchEntries } from "../../src/core/extension/search-entries.js";

const model = { provider: "cliproxyapi", api: "cliproxyapi-codex-responses" };
const fixture = JSON.parse(fs.readFileSync(new URL("../fixtures/terra-search-events.json", import.meta.url)));
const message = () => ({ ...model, role: "assistant", content: [], stopReason: "stop" });
function harness() {
  const listeners = new Set();
  let shutdown;
  const pi = {
    events: { on: (channel, handler) => {
      assert.equal(channel, CLIPROXY_RESPONSE_EVENT);
      listeners.add(handler);
      return () => listeners.delete(handler);
    } },
    on: (name, handler) => { assert.equal(name, "session_shutdown"); shutdown = handler; },
  };
  registerCliproxySearchEvents(pi);
  const emitted = [];
  return {
    emit: (event, output, route = model) => {
      for (const listener of listeners) listener({ event, output, model: route, stream: { push: (event) => emitted.push(event) } });
    },
    reload: () => { shutdown(); registerCliproxySearchEvents(pi); },
    shutdown: () => shutdown(), listeners, emitted,
  };
}

test("replays observed Terra search without inventing sources, including after reload", () => {
  const h = harness();
  for (let turn = 0; turn < 2; turn++) {
    const output = message();
    for (const event of fixture.events) h.emit(event, output);
    assert.deepEqual(collectNativeSearchEntries(output), [{
      id: "ws_live_terra", label: "Searched site:python.org downloads latest stable Python release",
      output: "Search complete", isError: false,
    }]);
    assert.equal(output.content.length, 2);
    h.reload();
    assert.equal(h.listeners.size, 1);
  }
  assert.equal(h.emitted.filter((e) => e.type === "web_search_result").length, 2);
  assert.ok(h.emitted.some((e) => e.type === "server_tool_use"));
  h.shutdown();
  assert.equal(h.listeners.size, 0);
});

test("non-search, unsupported routes and disabled search produce no blocks", () => {
  const h = harness();
  const output = message();
  h.emit({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "I searched https://example.com" }] }] } }, output);
  h.emit(fixture.events[1], output, { provider: "other", api: model.api });
  const original = process.env.PI_OPENAI_NATIVE_SEARCH_MODE;
  try {
    process.env.PI_OPENAI_NATIVE_SEARCH_MODE = "off";
    for (const event of fixture.events) h.emit(event, output);
  } finally {
    if (original === undefined) delete process.env.PI_OPENAI_NATIVE_SEARCH_MODE;
    else process.env.PI_OPENAI_NATIVE_SEARCH_MODE = original;
  }
  assert.deepEqual(output.content, []);
  assert.deepEqual(h.emitted, []);
});

test("concurrent outputs, call IDs and structured sources stay isolated; text is unchanged", () => {
  const h = harness();
  const a = message();
  const b = message();
  a.content.push({ type: "text", text: "Unchanged text", textSignature: "sig" });
  h.emit(fixture.events[0], a);
  h.emit(fixture.events[0], b);
  const withSource = { ...fixture.events[1], item: { ...fixture.events[1].item,
    action: { ...fixture.events[1].item.action, sources: [{ type: "url", url: "https://python.org/downloads/", title: "Python" }] } } };
  h.emit(withSource, a);
  h.emit(fixture.events[1], b);
  h.emit(fixture.events[2], a); // Поздний completed без sources не стирает наблюдаемые данные.
  assert.match(collectNativeSearchEntries(a)[0].output, /https:\/\/python.org\/downloads\//);
  assert.equal(collectNativeSearchEntries(b)[0].output, "Search complete");
  assert.deepEqual(a.content[0], { type: "text", text: "Unchanged text", textSignature: "sig" });
  h.emit({ ...withSource, item: { ...withSource.item, id: "ws_second", action: { type: "search", query: "second" } } }, a);
  assert.equal(collectNativeSearchEntries(a)[1].output, "Search complete");
});

test("failed and incomplete search are not labelled successful", () => {
  const h = harness();
  const output = message();
  h.emit(fixture.events[0], output);
  output.stopReason = "aborted";
  assert.equal(collectNativeSearchEntries(output)[0].label, "Web search interrupted");
  h.emit({ type: "response.completed", response: { output: [fixture.events[0].item] } }, output);
  assert.equal(output.content.length, 1);
  h.emit({ type: "response.output_item.done", item: { ...fixture.events[0].item, status: "failed", error: { message: "Provider search failed" } } }, output);
  assert.equal(collectNativeSearchEntries(output)[0].label, "Web search failed");
  assert.equal(collectNativeSearchEntries(output)[0].output, "Provider search failed");
});
