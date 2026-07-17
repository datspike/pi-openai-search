import test from "node:test";
import assert from "node:assert/strict";

import {
  isOpenAIResponsesModel,
  loadNativeSearchConfig,
  parseBooleanEnv,
  parseCsvEnv,
} from "../../src/core/config/native-search-config.js";

test("parseBooleanEnv normalizes common truthy and falsy values", () => {
  assert.equal(parseBooleanEnv("1", false), true);
  assert.equal(parseBooleanEnv("true", false), true);
  assert.equal(parseBooleanEnv("off", true), false);
  assert.equal(parseBooleanEnv("", true), true);
});

test("parseCsvEnv trims values and removes empties", () => {
  assert.deepEqual(parseCsvEnv("example.com, docs.example.com ,,"), [
    "example.com",
    "docs.example.com",
  ]);
  assert.equal(parseCsvEnv(""), undefined);
});

test("loadNativeSearchConfig reads stable env overrides", () => {
  const config = loadNativeSearchConfig({
    PI_OPENAI_NATIVE_SEARCH: "true",
    PI_OPENAI_NATIVE_SEARCH_MODE: "cached",
    PI_OPENAI_NATIVE_SEARCH_CONTEXT_SIZE: "high",
    PI_OPENAI_NATIVE_SEARCH_ALLOWED_DOMAINS: "example.com, docs.example.com ",
    PI_OPENAI_NATIVE_SEARCH_COUNTRY: "US",
    PI_OPENAI_NATIVE_SEARCH_CITY: "New York",
    PI_OPENAI_NATIVE_SEARCH_TIMEZONE: "America/New_York",
  });

  assert.deepEqual(config, {
    enabled: true,
    mode: "cached",
    contextSize: "high",
    allowedDomains: ["example.com", "docs.example.com"],
    userLocation: {
      type: "approximate",
      country: "US",
      region: undefined,
      city: "New York",
      timezone: "America/New_York",
    },
  });
});

test("isOpenAIResponsesModel accepts only OpenAI and OpenAI Codex transports", () => {
  assert.equal(isOpenAIResponsesModel({ provider: "openai", api: "openai-responses" }), true);
  assert.equal(
    isOpenAIResponsesModel({ provider: "openai-codex", api: "openai-codex-responses" }),
    true,
  );
  assert.equal(isOpenAIResponsesModel({ provider: "azure", api: "azure-openai-responses" }), false);
  assert.equal(isOpenAIResponsesModel({ provider: "custom", api: "openai-responses" }), false);
  assert.equal(isOpenAIResponsesModel({ api: "openai-responses" }), false);
  assert.equal(isOpenAIResponsesModel(undefined), false);
});
