import test from "node:test";
import assert from "node:assert/strict";

import {
  parseCompatBoolean,
  registerCompatLayer,
} from "../../src/compat/runtime/pi-runtime.js";

test("parseCompatBoolean normalizes compat flags", () => {
  assert.equal(parseCompatBoolean("1", false), true);
  assert.equal(parseCompatBoolean("off", true), false);
  assert.equal(parseCompatBoolean(undefined, true), true);
});

test("registerCompatLayer skips disabled feature without error", async () => {
  const result = await registerCompatLayer("interactive-inline-search", async () => {
    throw new Error("should not run");
  }, "0");

  assert.deepEqual(result, {
    enabled: false,
    applied: false,
    reason: "interactive-inline-search disabled by env",
  });
});

test("registerCompatLayer degrades fail-open on runtime mismatch", async () => {
  const result = await registerCompatLayer("interactive-inline-search", async () => {
    throw new Error("runtime mismatch");
  }, "1");

  assert.equal(result.enabled, true);
  assert.equal(result.applied, false);
  assert.match(result.reason, /compat unavailable/);
  assert.match(result.error.message, /runtime mismatch/);
});
