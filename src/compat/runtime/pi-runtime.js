import { existsSync, readFileSync } from "node:fs";
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

let resolvedPiBinPath;
let resolvedRuntimeDescriptor;

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
    resolvedPiBinPath = envBinPath;
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
    resolvedPiBinPath = discoveredPath;
    return resolvedPiBinPath;
  }

  throw new Error("Не удалось определить путь к pi binary. Укажи PI_BIN_PATH или добавь pi в PATH.");
}

/**
 * Чтение версии standalone pi из package metadata.
 *
 * @param {string} root Корень runtime.
 * @returns {string | undefined} Версия runtime.
 */
function readPiRuntimeVersion(root) {
  const packageJsonPath = path.join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof packageJson?.version === "string" ? packageJson.version : undefined;
  } catch {
    return undefined;
  }
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

  const binPath = resolvePiBinPath();
  const root = path.resolve(
    path.dirname(binPath),
    "..",
    "lib",
    "node_modules",
    "@mariozechner",
    "pi-coding-agent",
  );

  if (!existsSync(root)) {
    throw new Error(`Корень standalone pi runtime не найден по вычисленному пути: ${root}`);
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

/**
 * Импорт внутреннего модуля standalone pi runtime.
 *
 * @param {string} relativePath Путь относительно runtime root.
 * @returns {Promise<any>} Импортированный модуль.
 */
export async function importPiRuntimeModule(relativePath) {
  const modulePath = path.join(resolvePiRuntimeRoot(), relativePath);
  if (!existsSync(modulePath)) {
    throw new Error(`Модуль standalone pi runtime не найден: ${modulePath}`);
  }

  return import(pathToFileURL(modulePath).href);
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
