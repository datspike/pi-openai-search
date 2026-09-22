import test from "node:test";
import assert from "node:assert/strict";

import { buildPatchedParams } from "../../src/compat/provider/openai-responses-params.js";

const model = {
  id: "gpt-5.6",
  maxTokens: 32000,
  baseUrl: "http://127.0.0.1:8317/v1",
};

const read = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: {} },
};

test("buildPatchedParams reads active tools from the transcript", () => {
  let convertedTools;
  const params = buildPatchedParams(
    model,
    {
      messages: [{ role: "system", content: "", toolsAdded: [read], timestamp: 0 }],
    },
    {},
    {
      convertResponsesMessages() { return []; },
      convertResponsesTools(tools) {
        convertedTools = tools;
        return tools.map((tool) => ({ type: "function", name: tool.name }));
      },
    },
  );

  assert.deepEqual(convertedTools, [read]);
  assert.deepEqual(params.tools, [{ type: "function", name: "read" }]);
});

test("buildPatchedParams retains legacy context.tools fallback", () => {
  const params = buildPatchedParams(
    model,
    { messages: [], tools: [read] },
    {},
    {
      convertResponsesMessages() { return []; },
      convertResponsesTools(tools) {
        return tools.map((tool) => ({ type: "function", name: tool.name }));
      },
    },
  );

  assert.deepEqual(params.tools, [{ type: "function", name: "read" }]);
});
