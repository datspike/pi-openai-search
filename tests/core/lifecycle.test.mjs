import test from "node:test";
import assert from "node:assert/strict";

import {
  formatTruthfulWebSearchDoneLabel,
  formatTruthfulWebSearchPendingLabel,
  formatWebSearchResult,
  getFactualSearchLifecycleUpdate,
  summarizeSearchInput,
} from "../../src/core/lifecycle/search-status.js";

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

  assert.deepEqual(
    getFactualSearchLifecycleUpdate({
      type: "web_search_result",
      contentIndex: 0,
      partial: {
        role: "assistant",
        content: [
          {
            type: "webSearchResult",
            toolUseId: "search_1",
            content: { type: "web_search_tool_result_complete" },
          },
        ],
      },
    }),
    {
      phase: "complete",
      toolUseId: "search_1",
      statusText: "web: finished",
      workingMessage: undefined,
    },
  );
});

test("getFactualSearchLifecycleUpdate ignores malformed and non-factual inputs", () => {
  assert.equal(getFactualSearchLifecycleUpdate(undefined), null);
  assert.equal(getFactualSearchLifecycleUpdate({ type: "text_delta" }), null);
  assert.equal(
    getFactualSearchLifecycleUpdate({
      type: "server_tool_use",
      contentIndex: 0,
      partial: {
        content: [
          {
            type: "serverToolUse",
            id: "search_1",
            name: "web_search",
            input: {},
          },
        ],
      },
    }),
    null,
  );
});

test("formatWebSearchResult formats sources and completion sentinel", () => {
  assert.equal(
    formatWebSearchResult([
      {
        type: "web_search_result",
        title: "Axios",
        url: "https://www.axios.com/2026/04/02/openai-acquires-tbpn",
      },
    ]),
    "Axios: https://www.axios.com/2026/04/02/openai-acquires-tbpn",
  );
  assert.equal(
    formatWebSearchResult({ type: "web_search_tool_result_complete" }),
    "Search complete",
  );
});
