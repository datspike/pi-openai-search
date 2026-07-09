import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  buildCompatWarnings,
  classifyPiVersion,
  COMPAT_FEATURES,
  createCompatFeatureStatus,
  createDisabledCompatFeatureStatus,
  summarizeCompatStatus,
} from "./pi-compat-capabilities.js";

const PI_RUNTIME_PACKAGE_NAMES = new Set([
  "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-coding-agent",
]);
const PI_RUNTIME_SCOPES = ["@earendil-works", "@mariozechner"];
const RUNTIME_PACKAGE_BASENAME = "pi-coding-agent";
const LEGACY_RUNTIME_PACKAGES = new Map([
  ["@mariozechner/pi-ai", "@earendil-works/pi-ai"],
  ["@mariozechner/pi-tui", "@earendil-works/pi-tui"],
]);

let resolvedPiBinPath;
let resolvedRuntimeDescriptor;

function isSamePath(left, right) {
  if (!left || !right) {
    return false;
  }

  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function maybeWrapperRealPiPath(candidatePath) {
  const envRealPi = process.env.PI_VSCODE_SESSION_RESTORE_REAL_PI?.trim();
  if (envRealPi && existsSync(envRealPi) && !isSamePath(envRealPi, candidatePath)) {
    return envRealPi;
  }

  if (!existsSync(candidatePath)) {
    return undefined;
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-openai-search-wrapper-"));
  const eventLog = path.join(tempDir, "events.jsonl");

  try {
    const probe = spawnSync(candidatePath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        PI_VSCODE_SESSION_RESTORE_EVENT_LOG: eventLog,
        PI_VSCODE_SESSION_RESTORE_MARKER: "pi-openai-search-runtime-probe",
      },
    });

    if (probe.error || !existsSync(eventLog)) {
      return undefined;
    }

    const events = readFileSync(eventLog, "utf8").trim().split(/\n+/).filter(Boolean);
    for (const line of events) {
      try {
        const event = JSON.parse(line);
        if (event?.event === "pi-wrapper-invocation" && event.realPi && existsSync(event.realPi) && !isSamePath(event.realPi, candidatePath)) {
          return event.realPi;
        }
      } catch {
        // Игнорируем повреждённые диагностические строки wrapper.
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return undefined;
}

/**
 * Сброс кеша runtime auto-discovery.
 *
 * @returns {void}
 */
export function resetPiRuntimeCache() {
  resolvedPiBinPath = undefined;
  resolvedRuntimeDescriptor = undefined;
}

/**
 * Чтение env-флага compat-слоя.
 *
 * @param {string | undefined} value Сырой env.
 * @param {boolean} fallback Значение по умолчанию.
 * @returns {boolean} Нормализованный флаг.
 */
export function parseCompatBoolean(value, fallback = true) {
  if (value == null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

/**
 * Определение пути к бинарю standalone pi.
 *
 * @returns {string} Абсолютный путь к бинарю.
 */
export function resolvePiBinPath() {
  if (resolvedPiBinPath) {
    return resolvedPiBinPath;
  }

  const envBinPath = process.env.PI_BIN_PATH?.trim();
  if (envBinPath) {
    if (!existsSync(envBinPath)) {
      throw new Error(`pi binary не найден по PI_BIN_PATH: ${envBinPath}`);
    }
    resolvedPiBinPath = maybeWrapperRealPiPath(envBinPath) || envBinPath;
    return resolvedPiBinPath;
  }

  const argvCandidate = process.argv.find((value) => typeof value === "string" && /(^|\/)pi$/.test(value));
  if (argvCandidate && existsSync(argvCandidate)) {
    resolvedPiBinPath = argvCandidate;
    return resolvedPiBinPath;
  }

  const lookup = spawnSync("sh", ["-lc", "command -v pi"], {
    encoding: "utf8",
  });
  const discoveredPath = String(lookup.stdout || "").trim();
  if (lookup.status === 0 && discoveredPath && existsSync(discoveredPath)) {
    resolvedPiBinPath = maybeWrapperRealPiPath(discoveredPath) || discoveredPath;
    return resolvedPiBinPath;
  }

  throw new Error("Не удалось определить путь к pi binary. Укажи PI_BIN_PATH или добавь pi в PATH.");
}

function readPackageJson(root) {
  const packageJsonPath = path.join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return undefined;
  }
}

function validatePiRuntimeRoot(root) {
  const packageJson = readPackageJson(root);
  const packageName = packageJson?.name;
  if (!PI_RUNTIME_PACKAGE_NAMES.has(packageName)) {
    throw new Error(`Корень standalone pi runtime не прошёл проверку package name: ${root}`);
  }
  return path.resolve(root);
}

function findPiRuntimeRootByPackageWalk(startPath) {
  let current = existsSync(startPath) ? realpathSync(startPath) : path.resolve(startPath);
  if (!current.endsWith(path.sep) && path.basename(current) !== "") {
    current = path.dirname(current);
  }

  for (;;) {
    const packageJson = readPackageJson(current);
    if (packageJson && PI_RUNTIME_PACKAGE_NAMES.has(packageJson.name)) {
      return validatePiRuntimeRoot(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function findPiRuntimeRootByNpmLayout(binPath) {
  const prefixRoot = path.resolve(path.dirname(binPath), "..", "lib", "node_modules");
  for (const scope of PI_RUNTIME_SCOPES) {
    const candidate = path.join(prefixRoot, scope, RUNTIME_PACKAGE_BASENAME);
    if (!existsSync(candidate)) {
      continue;
    }
    return validatePiRuntimeRoot(candidate);
  }
  return undefined;
}

/**
 * Чтение версии standalone pi из package metadata.
 *
 * @param {string} root Корень runtime.
 * @returns {string | undefined} Версия runtime.
 */
function readPiRuntimeVersion(root) {
  const packageJson = readPackageJson(root);
  return typeof packageJson?.version === "string" ? packageJson.version : undefined;
}

/**
 * Определение дескриптора standalone pi runtime.
 *
 * @returns {{kind: "pi", binPath: string, root: string, version?: string}} Дескриптор runtime.
 */
export function resolvePiRuntimeDescriptor() {
  if (resolvedRuntimeDescriptor) {
    return resolvedRuntimeDescriptor;
  }

  const envRoot = process.env.PI_RUNTIME_ROOT?.trim();
  if (envRoot) {
    resolvedRuntimeDescriptor = {
      kind: "pi",
      binPath: process.env.PI_BIN_PATH?.trim() || "pi",
      root: validatePiRuntimeRoot(realpathSync(envRoot)),
      version: readPiRuntimeVersion(envRoot),
    };
    return resolvedRuntimeDescriptor;
  }

  const binPath = resolvePiBinPath();
  const root = findPiRuntimeRootByPackageWalk(binPath) || findPiRuntimeRootByNpmLayout(binPath);

  if (!root) {
    throw new Error(`Корень standalone pi runtime не найден для binary: ${binPath}`);
  }

  resolvedRuntimeDescriptor = {
    kind: "pi",
    binPath,
    root,
    version: readPiRuntimeVersion(root),
  };
  return resolvedRuntimeDescriptor;
}

/**
 * Корень standalone pi runtime.
 *
 * @returns {string} Абсолютный путь к runtime root.
 */
export function resolvePiRuntimeRoot() {
  return resolvePiRuntimeDescriptor().root;
}

function legacyPackagePathCandidates(relativePath) {
  if (relativePath === "node_modules/@mariozechner/pi-ai/dist/index.js") {
    return [
      "node_modules/@earendil-works/pi-ai/dist/compat.js",
      relativePath,
    ];
  }

  if (relativePath === "node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js") {
    return [
      "node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js",
      "node_modules/@earendil-works/pi-ai/dist/providers/openai-responses-shared.js",
      relativePath,
    ];
  }

  for (const [oldPackageName, newPackageName] of LEGACY_RUNTIME_PACKAGES) {
    const prefix = `node_modules/${oldPackageName}/`;
    if (relativePath.startsWith(prefix)) {
      return [
        `node_modules/${newPackageName}/${relativePath.slice(prefix.length)}`,
        relativePath,
      ];
    }
  }
  return [relativePath];
}

function modulePathCandidates(root, relativePath) {
  const candidates = [];
  const addCandidate = (candidate) => {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  addCandidate(path.join(root, relativePath));

  if (relativePath.startsWith("node_modules/")) {
    let current = root;
    for (;;) {
      addCandidate(path.join(current, relativePath));
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return candidates;
}

/**
 * Импорт внутреннего модуля standalone pi runtime.
 *
 * @param {string} relativePath Путь относительно runtime root.
 * @returns {Promise<any>} Импортированный модуль.
 */
export async function importPiRuntimeModule(relativePath) {
  const root = resolvePiRuntimeRoot();
  for (const runtimeRelativePath of legacyPackagePathCandidates(relativePath)) {
    for (const modulePath of modulePathCandidates(root, runtimeRelativePath)) {
      if (existsSync(modulePath)) {
        return import(pathToFileURL(modulePath).href);
      }
    }
  }

  throw new Error(`Модуль standalone pi runtime не найден: ${path.join(root, relativePath)}`);
}

/**
 * Capability probe для compat-фич standalone pi.
 *
 * @param {any} pi Экземпляр pi runtime.
 * @param {{probeProviderCompat?: Function, probeInteractiveInlineCompat?: Function, probeToolRenderCompat?: Function}} probes Настраиваемые probes.
 * @returns {Promise<{runtime: any, features: Record<string, any>, warnings: string[], diagnostics: string[], status: string}>} Compat summary.
 */
export async function probePiCompatCapabilities(pi, probes = {}) {
  let descriptor;

  try {
    descriptor = resolvePiRuntimeDescriptor();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const features = {
      [COMPAT_FEATURES.providerCompat]: createCompatFeatureStatus(COMPAT_FEATURES.providerCompat, {
        supported: false,
        reason,
      }),
      [COMPAT_FEATURES.interactiveInline]: createCompatFeatureStatus(COMPAT_FEATURES.interactiveInline, {
        supported: false,
        reason,
      }),
      [COMPAT_FEATURES.toolRender]: createCompatFeatureStatus(COMPAT_FEATURES.toolRender, {
        supported: false,
        reason,
      }),
    };

    return {
      runtime: {
        kind: "pi",
        descriptor: undefined,
        version: classifyPiVersion(undefined),
      },
      features,
      warnings: buildCompatWarnings(features),
      diagnostics: [reason],
      status: summarizeCompatStatus(features),
    };
  }

  const version = classifyPiVersion(descriptor.version);
  const diagnostics = [...version.diagnostics];

  const providerEnabled = parseCompatBoolean(process.env.PI_OPENAI_NATIVE_SEARCH_PROVIDER_COMPAT, true);
  const inlineEnabled = parseCompatBoolean(process.env.PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT, true);
  const toolRenderEnabled = parseCompatBoolean(process.env.PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT, true);

  const featureEntries = await Promise.all([
    providerEnabled
      ? probes.probeProviderCompat?.(pi, descriptor)
      : Promise.resolve(createDisabledCompatFeatureStatus(COMPAT_FEATURES.providerCompat)),
    inlineEnabled
      ? probes.probeInteractiveInlineCompat?.(descriptor)
      : Promise.resolve(createDisabledCompatFeatureStatus(COMPAT_FEATURES.interactiveInline)),
    toolRenderEnabled
      ? probes.probeToolRenderCompat?.(descriptor)
      : Promise.resolve(createDisabledCompatFeatureStatus(COMPAT_FEATURES.toolRender)),
  ]);

  const features = {
    [COMPAT_FEATURES.providerCompat]: featureEntries[0] || createCompatFeatureStatus(COMPAT_FEATURES.providerCompat, {
      supported: false,
      reason: "provider-compat probe missing",
    }),
    [COMPAT_FEATURES.interactiveInline]: featureEntries[1] || createCompatFeatureStatus(COMPAT_FEATURES.interactiveInline, {
      supported: false,
      reason: "interactive-inline probe missing",
    }),
    [COMPAT_FEATURES.toolRender]: featureEntries[2] || createCompatFeatureStatus(COMPAT_FEATURES.toolRender, {
      supported: false,
      reason: "tool-render probe missing",
    }),
  };

  for (const feature of Object.values(features)) {
    diagnostics.push(...(feature.diagnostics || []));
  }

  return {
    runtime: {
      kind: "pi",
      descriptor,
      version,
    },
    features,
    warnings: buildCompatWarnings(features),
    diagnostics,
    status: summarizeCompatStatus(features),
  };
}
