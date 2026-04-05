import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

let resolvedGsdBinPath;

/**
 * Сброс кеша auto-discovery.
 *
 * @returns {void}
 */
export function resetGsdPiCompatCache() {
  resolvedGsdBinPath = undefined;
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
 * Определение пути к бинарю gsd через env или PATH.
 *
 * @returns {string} Абсолютный путь к бинарю.
 */
export function resolveGsdBinPath() {
  if (resolvedGsdBinPath) {
    return resolvedGsdBinPath;
  }

  const envBinPath = process.env.GSD_BIN_PATH?.trim();
  if (envBinPath) {
    resolvedGsdBinPath = envBinPath;
    return resolvedGsdBinPath;
  }

  const argvCandidate = process.argv.find((value) => typeof value === "string" && /(^|\/)gsd$/.test(value));
  if (argvCandidate && existsSync(argvCandidate)) {
    resolvedGsdBinPath = argvCandidate;
    return resolvedGsdBinPath;
  }

  const lookup = spawnSync("sh", ["-lc", "command -v gsd"], {
    encoding: "utf8",
  });
  const discoveredPath = String(lookup.stdout || "").trim();
  if (lookup.status === 0 && discoveredPath && existsSync(discoveredPath)) {
    resolvedGsdBinPath = discoveredPath;
    return resolvedGsdBinPath;
  }

  throw new Error("Не удалось определить путь к gsd binary. Укажи GSD_BIN_PATH или добавь gsd в PATH.");
}

/**
 * Определение корня установленного gsd-pi.
 *
 * @returns {string} Абсолютный путь к корню пакета.
 */
export function resolveGsdPiRoot() {
  const binPath = resolveGsdBinPath();

  const root = path.resolve(path.dirname(binPath), "..", "lib", "node_modules", "gsd-pi");
  if (!existsSync(root)) {
    throw new Error(`Корень gsd-pi не найден по вычисленному пути: ${root}`);
  }

  return root;
}

/**
 * Импорт внутреннего модуля gsd-pi по относительному пути.
 *
 * @param {string} relativePath Путь относительно корня gsd-pi.
 * @returns {Promise<any>} Импортированный модуль.
 */
export async function importGsdPiModule(relativePath) {
  const root = resolveGsdPiRoot();
  const modulePath = path.join(root, relativePath);
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
