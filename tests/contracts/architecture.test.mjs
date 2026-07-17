import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_CONTRACT_MAP,
  CANONICAL_SOURCE_EVIDENCE,
  ENV_TAXONOMY,
} from "../../src/core/contracts/architecture.js";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(fixtureDir, "../..");

test("architecture contract keeps supported runtime narrow", () => {
  assert.deepEqual(CANONICAL_CONTRACT_MAP.supportedRuntime, {
    product: "standalone-pi",
    models: [
      { provider: "openai", api: "openai-responses" },
      { provider: "openai-codex", api: "openai-codex-responses" },
    ],
    testedBaselineVersion: "0.65.0",
  });
});

test("compat contract exposes default-enabled capability-first policy", () => {
  assert.deepEqual(CANONICAL_CONTRACT_MAP.compatCapabilities.features, [
    "provider-compat",
    "interactive-inline",
    "tool-render",
  ]);
  assert.equal(CANONICAL_CONTRACT_MAP.compatCapabilities.policy.defaultEnabled, true);
  assert.equal(CANONICAL_CONTRACT_MAP.compatCapabilities.policy.optOut, "per-feature-env-false");
  assert.equal(CANONICAL_CONTRACT_MAP.compatCapabilities.policy.unknownVersion, "allowed-if-probe-passes");
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

test("legacy bridge modules are removed", () => {
  const removedPaths = [
    "src/openai-native-search.js",
    "src/openai-search-display.js",
    "src/pi-runtime.js",
    "src/pi-ai-compat.js",
    "src/openai-interactive-search-order-patch.js",
    "src/openai-tool-execution-web-search-patch.js",
    "src/openai-responses-provider.js",
    "src/openai-responses-client.js",
    "src/openai-responses-display-patch.js",
    "src/openai-responses-params.js",
    "src/openai-responses-search-mapper.js",
    "src/openai-responses-stream.js",
  ];

  for (const relativePath of removedPaths) {
    assert.equal(fs.existsSync(path.join(repoRoot, relativePath)), false, relativePath);
  }
});
