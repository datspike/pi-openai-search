import assert from "node:assert/strict";

import { probeInteractiveSearchOrderPatchCapability } from "../src/compat/interactive/search-order-patch.js";
import { probeTruthfulInteractiveWebSearchPatchCapability } from "../src/compat/interactive/tool-execution-web-search-patch.js";
import { probeProviderCompatCapability } from "../src/compat/provider/openai-responses-provider.js";
import { probePiCompatCapabilities } from "../src/compat/runtime/pi-runtime.js";

async function main() {
  const pi = {
    registerProvider() {},
  };

  const summary = await probePiCompatCapabilities(pi, {
    probeProviderCompat: probeProviderCompatCapability,
    probeInteractiveInlineCompat: probeInteractiveSearchOrderPatchCapability,
    probeToolRenderCompat: probeTruthfulInteractiveWebSearchPatchCapability,
  });

  assert.equal(summary.runtime.kind, "pi");
  assert.ok(summary.runtime.version.baseline);
  assert.ok(summary.features["provider-compat"]);
  assert.ok(summary.features["interactive-inline"]);
  assert.ok(summary.features["tool-render"]);

  console.log(JSON.stringify({
    status: summary.status,
    runtime: summary.runtime.version,
    features: summary.features,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
