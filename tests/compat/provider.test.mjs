import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));

test("legacy provider entrypoint is a thin compat bridge", () => {
  const legacySource = fs.readFileSync(
    path.resolve(fixtureDir, "../../src/openai-responses-provider.js"),
    "utf8",
  );

  assert.match(legacySource, /\.\/compat\/provider\/openai-responses-provider\.js/);
});
