import test from "node:test";
import assert from "node:assert/strict";

import {
  activateProviderCompat,
  probeProviderCompatCapability,
} from "../../src/compat/provider/openai-responses-provider.js";
import { COMPAT_FEATURES } from "../../src/compat/runtime/pi-compat-capabilities.js";

const workingInternals = {
  convertResponsesMessages() {},
  convertResponsesTools() {},
  OpenAI: class OpenAI {},
};

function loadWorkingInternals() {
  return workingInternals;
}

const workingPiAiCompat = {
  hasPiAiProviderCompat: true,
  AssistantMessageEventStream: class AssistantMessageEventStream {},
  getEnvApiKey() {},
  supportsXhigh() {},
};

const missingPiAiCompat = {
  hasPiAiProviderCompat: false,
  AssistantMessageEventStream: class AssistantMessageEventStream {
    constructor() {
      throw new Error("stub must not count as compat");
    }
  },
  getEnvApiKey() {},
  supportsXhigh() {
    return false;
  },
};

test("provider compat probe accepts public registerProvider path", async () => {
  const result = await probeProviderCompatCapability(
    {
      registerProvider() {},
    },
    {
      loadOpenAIResponsesInternals: loadWorkingInternals,
      piAiCompat: workingPiAiCompat,
    },
  );

  assert.equal(result.feature, COMPAT_FEATURES.providerCompat);
  assert.equal(result.supported, true);
});

test("provider compat probe rejects throwing pi-ai compat stubs", async () => {
  const result = await probeProviderCompatCapability(
    {
      registerProvider() {
        throw new Error("should not run");
      },
    },
    {
      loadOpenAIResponsesInternals: loadWorkingInternals,
      piAiCompat: missingPiAiCompat,
    },
  );

  assert.equal(result.supported, false);
  assert.match(result.reason, /pi-ai compat/);
});

test("provider compat activation does not register when pi-ai compat is missing", async () => {
  let registrations = 0;
  const applied = await activateProviderCompat(
    {
      registerProvider() {
        registrations += 1;
      },
    },
    {
      features: {
        [COMPAT_FEATURES.providerCompat]: {
          supported: true,
        },
      },
    },
    {
      loadOpenAIResponsesInternals: loadWorkingInternals,
      piAiCompat: missingPiAiCompat,
    },
  );

  assert.equal(applied, false);
  assert.equal(registrations, 0);
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
    {
      loadOpenAIResponsesInternals: loadWorkingInternals,
      piAiCompat: workingPiAiCompat,
    },
  );

  assert.equal(applied, true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, "openai");
  assert.equal(registrations[0].config.api, "openai-responses");
  assert.equal(typeof registrations[0].config.stream, "function");
  assert.equal(typeof registrations[0].config.streamSimple, "function");
});

test("provider compat activation registers public provider once and does not use private fallback", async () => {
  const registrations = [];
  let privateRegistrations = 0;
  const pi = {
    registerProvider(name, config) {
      registrations.push({ name, config });
    },
  };
  const compat = {
    ...workingPiAiCompat,
    registerApiProvider() {
      privateRegistrations += 1;
    },
  };
  const summary = { features: { [COMPAT_FEATURES.providerCompat]: { supported: true } } };

  assert.equal(await activateProviderCompat(pi, summary, {
    loadOpenAIResponsesInternals: loadWorkingInternals,
    piAiCompat: compat,
  }), true);
  assert.equal(await activateProviderCompat(pi, summary, {
    loadOpenAIResponsesInternals: loadWorkingInternals,
    piAiCompat: compat,
  }), true);
  assert.equal(registrations.length, 1);
  assert.equal(privateRegistrations, 0);
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

test("provider compat probe reports unsupported when internals are missing", async () => {
  const result = await probeProviderCompatCapability(
    {
      registerProvider() {
        throw new Error("should not run");
      },
    },
    {
      loadOpenAIResponsesInternals: async () => {
        throw new Error("moved module missing");
      },
    },
  );

  assert.equal(result.supported, false);
  assert.match(result.reason, /internals/);
  assert.match(result.diagnostics[0], /moved module missing/);
});

test("provider compat activation does not register when internals are missing", async () => {
  let registrations = 0;
  const applied = await activateProviderCompat(
    {
      registerProvider() {
        registrations += 1;
      },
    },
    {
      features: {
        [COMPAT_FEATURES.providerCompat]: {
          supported: true,
        },
      },
    },
    {
      loadOpenAIResponsesInternals: async () => {
        throw new Error("missing internals");
      },
    },
  );

  assert.equal(applied, false);
  assert.equal(registrations, 0);
});
