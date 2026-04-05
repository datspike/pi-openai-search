import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));

test("default entrypoint stays core-first and does not reference compat provider override", () => {
  const indexSource = fs.readFileSync(path.resolve(fixtureDir, "../../index.js"), "utf8");

  assert.match(indexSource, /registerCoreOpenAISearchExtension/);
  assert.doesNotMatch(indexSource, /registerOpenAIResponsesDisplayPatch/);
  assert.doesNotMatch(indexSource, /buildPatchedOpenAIResponsesProviderConfig/);
  assert.doesNotMatch(indexSource, /registerProvider\(/);
});
