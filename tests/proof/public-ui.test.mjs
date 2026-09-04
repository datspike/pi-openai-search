import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { importPiRuntimeModule, resolvePiRuntimeRoot } from "../../src/compat/runtime/pi-runtime.js";
import { NATIVE_SEARCH_ENTRY_TYPE, renderNativeSearchEntry } from "../../src/core/extension/search-entries.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("packaged Pi persists public search entries after assistant and excludes them from model context", async (t) => {
  let runtimeRoot;
  try { runtimeRoot = resolvePiRuntimeRoot(); }
  catch (error) { t.skip(error.message); return; }
  const pkg = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"));
  const { Text, visibleWidth } = await importPiRuntimeModule("node_modules/@mariozechner/pi-tui/dist/index.js");
  const { buildSessionContext } = await importPiRuntimeModule("dist/core/session-manager.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-public-ui-"));
  try {
    for (const scenario of ["SEARCH", "NO_SEARCH"]) {
      const session = path.join(dir, `${scenario}.jsonl`);
      const run = spawnSync(process.execPath, [
        path.resolve(runtimeRoot, pkg.bin.pi), "--no-extensions",
        "-e", path.join(root, "index.js"), "-e", path.join(root, "tests/fixtures/search-provider.js"),
        "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
        "--no-tools", "--model", "openai/search-fixture", "--session", session, "--print", scenario,
      ], {
        cwd: dir, encoding: "utf8", timeout: 30000,
        env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1",
          PI_OPENAI_NATIVE_SEARCH: "true", PI_OPENAI_NATIVE_SEARCH_MODE: "live",
          PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT: "false", PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT: "false" },
      });
      assert.equal(run.status, 0, run.stderr || run.error?.message);
      assert.doesNotMatch(run.stdout + run.stderr, /Failed to load extension|UI compat|Cannot find package/);
      assert.match(run.stdout, /Fixture finished/);
      const entries = fs.readFileSync(session, "utf8").trim().split("\n").map(JSON.parse);
      const cards = entries.filter((entry) => entry.type === "custom" && entry.customType === NATIVE_SEARCH_ENTRY_TYPE);
      const context = buildSessionContext(entries);
      assert.equal(context.messages.some((m) => m.customType === NATIVE_SEARCH_ENTRY_TYPE), false);
      assert.equal(cards.length, scenario === "SEARCH" ? 1 : 0);
      if (cards.length) {
        const assistantIndex = entries.findIndex((entry) => entry.message?.role === "assistant");
        assert.ok(entries.indexOf(cards[0]) > assistantIndex, "card must follow persisted assistant message");
        for (const expanded of [false, true]) {
          const component = renderNativeSearchEntry(cards[0], { expanded }, { fg: (_color, text) => text }, Text);
          for (const width of [1, 10, 40, 80]) {
            const lines = component.render(width);
            assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
          }
          assert.match(component.render(100).join("\n"), /Searched observed fixture query/);
          assert.match(component.render(100).join("\n"), /https:\/\/example.com\/fixture/);
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
