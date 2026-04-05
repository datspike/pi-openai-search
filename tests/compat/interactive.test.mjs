import test from "node:test";
import assert from "node:assert/strict";

import { applyInteractiveSearchOrderPatch } from "../../src/compat/interactive/search-order-patch.js";
import { applyTruthfulInteractiveWebSearchPatch } from "../../src/compat/interactive/tool-execution-web-search-patch.js";

test("interactive compat rejects incompatible inline runtime shape", () => {
  assert.throws(
    () => applyInteractiveSearchOrderPatch(undefined, undefined, undefined, {}),
    /AssistantMessageComponent|runtime/i,
  );
});

test("interactive compat rejects incompatible tool-execution runtime shape", () => {
  assert.throws(
    () => applyTruthfulInteractiveWebSearchPatch(undefined, {}),
    /ToolExecutionComponent|runtime/i,
  );
});
