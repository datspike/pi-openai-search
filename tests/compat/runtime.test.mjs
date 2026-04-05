import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPAT_FEATURES,
  createDisabledCompatFeatureStatus,
} from "../../src/compat/runtime/pi-compat-capabilities.js";
import {
  parseCompatBoolean,
  probePiCompatCapabilities,
  resetPiRuntimeCache,
} from "../../src/compat/runtime/pi-runtime.js";

test("parseCompatBoolean normalizes compat flags", () => {
  assert.equal(parseCompatBoolean("1", false), true);
  assert.equal(parseCompatBoolean("off", true), false);
  assert.equal(parseCompatBoolean(undefined, true), true);
});

test("probePiCompatCapabilities returns supported summary for available features", async () => {
  const summary = await probePiCompatCapabilities(
    { registerProvider() {} },
    {
      probeProviderCompat: async () => ({
        feature: COMPAT_FEATURES.providerCompat,
        enabled: true,
        status: "supported",
        supported: true,
        diagnostics: [],
      }),
      probeInteractiveInlineCompat: async () => ({
        feature: COMPAT_FEATURES.interactiveInline,
        enabled: true,
        status: "supported",
        supported: true,
        diagnostics: [],
      }),
      probeToolRenderCompat: async () => ({
        feature: COMPAT_FEATURES.toolRender,
        enabled: true,
        status: "supported",
        supported: true,
        diagnostics: [],
      }),
    },
  );

  assert.equal(summary.runtime.kind, "pi");
  assert.ok(summary.runtime.version.baseline);
  assert.equal(summary.status, "supported");
  assert.deepEqual(summary.warnings, []);
});

test("probePiCompatCapabilities keeps partial compat as first-class result", async () => {
  const summary = await probePiCompatCapabilities(
    { registerProvider() {} },
    {
      probeProviderCompat: async () => ({
        feature: COMPAT_FEATURES.providerCompat,
        enabled: true,
        status: "supported",
        supported: true,
        diagnostics: [],
      }),
      probeInteractiveInlineCompat: async () => ({
        feature: COMPAT_FEATURES.interactiveInline,
        enabled: true,
        status: "unavailable",
        supported: false,
        reason: "UI compat для native search недоступен; inline-патч пропущен",
        diagnostics: ["missing AssistantMessageComponent.prototype.updateContent"],
      }),
      probeToolRenderCompat: async () => createDisabledCompatFeatureStatus(COMPAT_FEATURES.toolRender),
    },
  );

  assert.equal(summary.status, "partial");
  assert.equal(summary.features[COMPAT_FEATURES.providerCompat].supported, true);
  assert.equal(summary.features[COMPAT_FEATURES.interactiveInline].supported, false);
  assert.match(summary.warnings[0], /inline-патч пропущен/);
});

test("probePiCompatCapabilities degrades fail-open on runtime resolution mismatch", async () => {
  const originalPiBinPath = process.env.PI_BIN_PATH;
  process.env.PI_BIN_PATH = "/definitely/missing/pi";
  resetPiRuntimeCache();

  try {
    const summary = await probePiCompatCapabilities({}, {
      probeProviderCompat: async () => {
        throw new Error("should not run");
      },
      probeInteractiveInlineCompat: async () => {
        throw new Error("should not run");
      },
      probeToolRenderCompat: async () => {
        throw new Error("should not run");
      },
    });

    assert.equal(summary.status, "unavailable");
    assert.ok(summary.warnings.length >= 1);
    assert.match(summary.diagnostics[0], /Не удалось определить путь к pi binary|не найден/i);
  } finally {
    resetPiRuntimeCache();
    if (originalPiBinPath == null) {
      delete process.env.PI_BIN_PATH;
    } else {
      process.env.PI_BIN_PATH = originalPiBinPath;
    }
  }
});
