import test from "node:test";
import assert from "node:assert/strict";

import {
  applyInteractiveSearchOrderPatch,
  probeInteractiveSearchOrderPatchCapability,
} from "../../src/compat/interactive/search-order-patch.js";
import {
  applyTruthfulInteractiveWebSearchPatch,
  probeTruthfulInteractiveWebSearchPatchCapability,
} from "../../src/compat/interactive/tool-execution-web-search-patch.js";
import { resetPiRuntimeCache } from "../../src/compat/runtime/pi-runtime.js";

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

test("interactive inline probe returns structured unavailability reason on mismatch", async () => {
  const originalPiBinPath = process.env.PI_BIN_PATH;
  process.env.PI_BIN_PATH = "/definitely/missing/pi";
  resetPiRuntimeCache();

  try {
    const result = await probeInteractiveSearchOrderPatchCapability();
    assert.equal(result.supported, false);
    assert.match(result.reason, /inline-патч пропущен/);
    assert.ok(result.diagnostics.length >= 1);
  } finally {
    resetPiRuntimeCache();
    if (originalPiBinPath == null) {
      delete process.env.PI_BIN_PATH;
    } else {
      process.env.PI_BIN_PATH = originalPiBinPath;
    }
  }
});

test("tool-render probe returns structured unavailability reason on mismatch", async () => {
  const originalPiBinPath = process.env.PI_BIN_PATH;
  process.env.PI_BIN_PATH = "/definitely/missing/pi";
  resetPiRuntimeCache();

  try {
    const result = await probeTruthfulInteractiveWebSearchPatchCapability();
    assert.equal(result.supported, false);
    assert.match(result.reason, /tool-render патч пропущен/);
    assert.ok(result.diagnostics.length >= 1);
  } finally {
    resetPiRuntimeCache();
    if (originalPiBinPath == null) {
      delete process.env.PI_BIN_PATH;
    } else {
      process.env.PI_BIN_PATH = originalPiBinPath;
    }
  }
});
