import test from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_CONTRACT_MAP,
  CANONICAL_SOURCE_EVIDENCE,
  ENV_TAXONOMY,
} from "../../src/core/contracts/architecture.js";

test("architecture contract keeps supported runtime narrow", () => {
  assert.deepEqual(CANONICAL_CONTRACT_MAP.supportedRuntime, {
    product: "standalone-pi",
    provider: "openai",
    api: "openai-responses",
  });
});

test("env taxonomy separates stable and experimental flags", () => {
  assert.ok(ENV_TAXONOMY.stable.includes("PI_OPENAI_NATIVE_SEARCH"));
  assert.ok(ENV_TAXONOMY.experimental.includes("PI_OPENAI_NATIVE_SEARCH_PROVIDER_COMPAT"));
  assert.ok(ENV_TAXONOMY.experimental.includes("PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT"));
  assert.equal(ENV_TAXONOMY.stable.includes("PI_BIN_PATH"), false);
});

test("truthful source evidence forbids synthetic fallback artifacts", () => {
  assert.ok(CANONICAL_SOURCE_EVIDENCE.documentedStructured.includes("web_search_call.action.sources"));
  assert.ok(CANONICAL_SOURCE_EVIDENCE.observedNonStructured.includes("inline_urls_in_final_text"));
  assert.ok(CANONICAL_SOURCE_EVIDENCE.forbiddenSyntheticFallbacks.includes("synthetic citations"));
});
