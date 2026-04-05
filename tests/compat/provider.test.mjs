import test from "node:test";
import assert from "node:assert/strict";

import {
  activateProviderCompat,
  probeProviderCompatCapability,
} from "../../src/compat/provider/openai-responses-provider.js";
import { COMPAT_FEATURES } from "../../src/compat/runtime/pi-compat-capabilities.js";

test("provider compat probe accepts public registerProvider path", async () => {
  const result = await probeProviderCompatCapability({
    registerProvider() {},
  });

  assert.equal(result.feature, COMPAT_FEATURES.providerCompat);
  assert.equal(result.supported, true);
});

test("provider compat activation respects capability matrix", async () => {
  const registrations = [];
  const applied = await activateProviderCompat(
    {
      registerProvider(name, config) {
        registrations.push({ name, config });
      },
    },
    {
      features: {
        [COMPAT_FEATURES.providerCompat]: {
          supported: true,
        },
      },
    },
  );

  assert.equal(applied, true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, "openai");
  assert.equal(registrations[0].config.api, "openai-responses");
  assert.equal(typeof registrations[0].config.stream, "function");
  assert.equal(typeof registrations[0].config.streamSimple, "function");
});

test("provider compat activation skips unsupported feature", async () => {
  const applied = await activateProviderCompat(
    {
      registerProvider() {
        throw new Error("should not run");
      },
    },
    {
      features: {
        [COMPAT_FEATURES.providerCompat]: {
          supported: false,
        },
      },
    },
  );

  assert.equal(applied, false);
});
