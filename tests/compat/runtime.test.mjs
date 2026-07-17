import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  COMPAT_FEATURES,
  createDisabledCompatFeatureStatus,
} from "../../src/compat/runtime/pi-compat-capabilities.js";
import {
  importPiRuntimeModule,
  parseCompatBoolean,
  probePiCompatCapabilities,
  resetPiRuntimeCache,
  resolvePiRuntimeDescriptor,
  resolvePiRuntimeRoot,
} from "../../src/compat/runtime/pi-runtime.js";

function withRuntimeEnv(values, fn) {
  const originalEnv = new Map();
  const envKeys = [
    "PATH",
    "PI_BIN_PATH",
    "PI_RUNTIME_ROOT",
    "PI_VSCODE_SESSION_RESTORE_REAL_PI",
    "PI_OPENAI_NATIVE_SEARCH_PROVIDER_COMPAT",
    "PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT",
    "PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT",
  ];
  resetPiRuntimeCache();

  for (const key of envKeys) {
    originalEnv.set(key, process.env[key]);
    if (values[key] == null) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      resetPiRuntimeCache();
      for (const key of envKeys) {
        const originalValue = originalEnv.get(key);
        if (originalValue == null) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
    });
}

function writeRuntimePackage(root, name = "@earendil-works/pi-coding-agent") {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version: "1.2.3" }), "utf8");
  fs.writeFileSync(path.join(root, "dist/cli.js"), "#!/usr/bin/env node\n", "utf8");
}

test("parseCompatBoolean normalizes compat flags", () => {
  assert.equal(parseCompatBoolean("1", false), true);
  assert.equal(parseCompatBoolean("off", true), false);
  assert.equal(parseCompatBoolean(undefined, true), true);
});

test("resolvePiRuntimeDescriptor finds source checkout from real pi bin path", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-runtime-"));
  try {
    const root = path.join(tempDir, "packages/coding-agent");
    writeRuntimePackage(root);
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, "pi");
    fs.symlinkSync(path.join(root, "dist/cli.js"), binPath);

    await withRuntimeEnv({ PI_BIN_PATH: binPath }, () => {
      const descriptor = resolvePiRuntimeDescriptor();
      assert.equal(descriptor.root, root);
      assert.equal(descriptor.version, "1.2.3");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolvePiRuntimeDescriptor resolves pi-vscode-session-restore wrapper via contract env", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-runtime-"));
  try {
    const root = path.join(tempDir, "packages/coding-agent");
    writeRuntimePackage(root);
    const realBinPath = path.join(root, "dist/cli.js");
    const wrapperPath = path.join(tempDir, "bin/pi");
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, "#!/usr/bin/env sh\nexit 1\n", "utf8");
    fs.chmodSync(wrapperPath, 0o755);

    await withRuntimeEnv({
      PI_BIN_PATH: wrapperPath,
      PI_VSCODE_SESSION_RESTORE_REAL_PI: realBinPath,
    }, () => {
      const descriptor = resolvePiRuntimeDescriptor();
      assert.equal(descriptor.binPath, realBinPath);
      assert.equal(descriptor.root, root);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolvePiRuntimeDescriptor resolves pi-vscode-session-restore wrapper via event log", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-runtime-"));
  try {
    const root = path.join(tempDir, "packages/coding-agent");
    writeRuntimePackage(root);
    const realBinPath = path.join(root, "dist/cli.js");
    const wrapperPath = path.join(tempDir, "bin/pi");
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(
      wrapperPath,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const log = process.env.PI_VSCODE_SESSION_RESTORE_EVENT_LOG;",
        `const realPi = ${JSON.stringify(realBinPath)};`,
        "if (log) { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.appendFileSync(log, JSON.stringify({ event: 'pi-wrapper-invocation', realPi }) + '\\n'); }",
        "process.stdout.write('1.2.3\\n');",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(wrapperPath, 0o755);

    await withRuntimeEnv({ PI_BIN_PATH: wrapperPath }, () => {
      const descriptor = resolvePiRuntimeDescriptor();
      assert.equal(descriptor.binPath, realBinPath);
      assert.equal(descriptor.root, root);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolvePiRuntimeRoot supports new scoped npm layout", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-runtime-"));
  try {
    const binPath = path.join(tempDir, "bin/pi");
    const root = path.join(tempDir, "lib/node_modules/@earendil-works/pi-coding-agent");
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "#!/usr/bin/env node\n", "utf8");
    writeRuntimePackage(root);

    await withRuntimeEnv({ PI_BIN_PATH: binPath }, () => {
      assert.equal(resolvePiRuntimeRoot(), root);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolvePiRuntimeRoot keeps old scoped npm layout fallback", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-runtime-"));
  try {
    const binPath = path.join(tempDir, "bin/pi");
    const root = path.join(tempDir, "lib/node_modules/@mariozechner/pi-coding-agent");
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "#!/usr/bin/env node\n", "utf8");
    writeRuntimePackage(root, "@mariozechner/pi-coding-agent");

    await withRuntimeEnv({ PI_BIN_PATH: binPath }, () => {
      assert.equal(resolvePiRuntimeRoot(), root);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolvePiRuntimeRoot validates PI_RUNTIME_ROOT package name", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-runtime-"));
  try {
    writeRuntimePackage(tempDir, "not-pi");

    await assert.rejects(
      withRuntimeEnv({ PI_RUNTIME_ROOT: tempDir }, () => resolvePiRuntimeRoot()),
      /package name/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("importPiRuntimeModule maps old pi-ai index to new compat before old fallback", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-runtime-"));
  try {
    const root = path.join(tempDir, "packages/coding-agent");
    writeRuntimePackage(root);
    fs.writeFileSync(path.join(root, "dist/cli.js"), "#!/usr/bin/env node\n", "utf8");
    fs.mkdirSync(path.join(tempDir, "node_modules/@earendil-works/pi-ai/dist"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules/@mariozechner/pi-ai/dist"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "node_modules/@earendil-works/pi-ai/dist/compat.js"), "export const marker = 'new-compat';\n", "utf8");
    fs.writeFileSync(path.join(root, "node_modules/@mariozechner/pi-ai/dist/index.js"), "export const marker = 'old';\n", "utf8");

    await withRuntimeEnv({ PI_BIN_PATH: path.join(root, "dist/cli.js") }, async () => {
      const module = await importPiRuntimeModule("node_modules/@mariozechner/pi-ai/dist/index.js");
      assert.equal(module.marker, "new-compat");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("importPiRuntimeModule keeps old pi-ai index as fallback", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-runtime-"));
  try {
    const root = path.join(tempDir, "packages/coding-agent");
    writeRuntimePackage(root);
    fs.mkdirSync(path.join(root, "node_modules/@mariozechner/pi-ai/dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/@mariozechner/pi-ai/dist/index.js"), "export const marker = 'old';\n", "utf8");

    await withRuntimeEnv({ PI_BIN_PATH: path.join(root, "dist/cli.js") }, async () => {
      const module = await importPiRuntimeModule("node_modules/@mariozechner/pi-ai/dist/index.js");
      assert.equal(module.marker, "old");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("importPiRuntimeModule maps moved openai-responses-shared to new dist api path", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-runtime-"));
  try {
    const root = path.join(tempDir, "packages/coding-agent");
    writeRuntimePackage(root);
    fs.mkdirSync(path.join(tempDir, "node_modules/@earendil-works/pi-ai/dist/api"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules/@mariozechner/pi-ai/dist/providers"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js"),
      "export const marker = 'new-api';\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js"),
      "export const marker = 'old-provider';\n",
      "utf8",
    );

    await withRuntimeEnv({ PI_BIN_PATH: path.join(root, "dist/cli.js") }, async () => {
      const module = await importPiRuntimeModule("node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js");
      assert.equal(module.marker, "new-api");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("importPiRuntimeModule keeps old pi-tui path as fallback", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-runtime-"));
  try {
    const root = path.join(tempDir, "packages/coding-agent");
    writeRuntimePackage(root);
    fs.mkdirSync(path.join(root, "node_modules/@mariozechner/pi-tui/dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/@mariozechner/pi-tui/dist/index.js"), "export const marker = 'old';\n", "utf8");

    await withRuntimeEnv({ PI_BIN_PATH: path.join(root, "dist/cli.js") }, async () => {
      const module = await importPiRuntimeModule("node_modules/@mariozechner/pi-tui/dist/index.js");
      assert.equal(module.marker, "old");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("probePiCompatCapabilities returns supported summary for available features", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-runtime-"));
  try {
    writeRuntimePackage(tempDir);
    await withRuntimeEnv({ PI_RUNTIME_ROOT: tempDir }, async () => {
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
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("probePiCompatCapabilities keeps partial compat as first-class result", async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pi-runtime-"));
  try {
    writeRuntimePackage(tempDir);
    await withRuntimeEnv({ PI_RUNTIME_ROOT: tempDir }, async () => {
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
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("probePiCompatCapabilities degrades fail-open on runtime resolution mismatch", async () => {
  await withRuntimeEnv({ PI_BIN_PATH: "/definitely/missing/pi" }, async () => {
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
    assert.equal(summary.warnings.length, 1);
    assert.match(summary.diagnostics[0], /Не удалось определить путь к pi binary|не найден/i);
  });
});

test("probePiCompatCapabilities preserves explicit opt-out when runtime resolution fails", async () => {
  await withRuntimeEnv({
    PI_BIN_PATH: "/definitely/missing/pi",
    PI_OPENAI_NATIVE_SEARCH_PROVIDER_COMPAT: "false",
    PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT: "false",
    PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT: "false",
  }, async () => {
    const summary = await probePiCompatCapabilities({});

    assert.equal(summary.status, "unavailable");
    assert.deepEqual(summary.warnings, []);
    for (const feature of Object.values(summary.features)) {
      assert.equal(feature.enabled, false);
      assert.match(feature.reason, /disabled by env/);
    }
  });
});
