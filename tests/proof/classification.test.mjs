import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyRawResponse,
  classifyVerifierJsonl,
  parseJsonlEvents,
} from "../../scripts/openai-search-proof-lib.mjs";

test("raw proof classification keeps truthful positive path", () => {
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
});

test("verifier classification keeps sentinel-only scenario A as blocker", () => {
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
  assert.equal(result.summary.sentinelCount, 1);
});

test("verifier classification keeps negative path clean", () => {
  const result = classifyRawResponse(
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

  assert.equal(result.verdict, "pass");
});
