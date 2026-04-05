import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
 * Определение дескриптора standalone pi runtime.
 *
 * @returns {{kind: "pi", binPath: string, root: string}} Дескриптор runtime.
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
 * Безопасная регистрация compat-слоя с fail-open деградацией.
 *
 * @param {string} featureName Название compat-фичи.
 * @param {() => Promise<any>} loader Функция загрузки/регистрации.
 * @param {string | undefined} envFlag Значение env-флага.
 * @returns {Promise<{enabled: boolean, applied: boolean, reason?: string, error?: Error}>} Результат регистрации.
 */
export async function registerCompatLayer(featureName, loader, envFlag) {
  if (!parseCompatBoolean(envFlag, true)) {
    return {
      enabled: false,
      applied: false,
      reason: `${featureName} disabled by env`,
    };
  }

  try {
    await loader();
    return {
      enabled: true,
      applied: true,
    };
  } catch (error) {
    return {
      enabled: true,
      applied: false,
      reason: `${featureName} compat unavailable`,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
